"""PI dashboard — LLM-assisted prompt drafts.

Endpoints:
  POST /api/pi/synthesize-drafts        Synthesis (Phase C1)
  GET  /api/pi/feedback-by-reviewer     Per-reviewer head-of-chain feedback (Phase C1.5)

The synthesis endpoint folds a reviewer's accumulated feedback into working
drafts of the three editable prompts (`instructions-v1.md`,
`fast-eval-prompt.md`, `deep-eval-prompt.md`). Recorder edits are out of
scope.

Validators (Phase C2) live in this module too — they consume the LLM's
explicit category lists rather than regex-extracting from markdown so we
don't double-implement the AGENTS.md invariants.

Validation rules in this module:

- Coach prompt: every `${...}` placeholder present in the original must
  appear in the new draft; the YAML frontmatter lines `parameters:`,
  `suggestions-enabled:`, `recording-mode: split` must be preserved.
- Eval prompts: the LLM's emitted `coach_issues_categories` /
  `student_red_flags_categories` must match `recorder.COACH_ISSUE_CATEGORIES`
  / `recorder.STUDENT_RED_FLAG_CATEGORIES` exactly. Missing or extra
  category strings produce per-item warnings (never hard rejects).
- Cross-prompt: when both fast and deep eval emit category lists, they must
  agree.
"""

from __future__ import annotations

import json
import logging
import os
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

import httpx
from fastapi import APIRouter, Body, Header, HTTPException, Query
from pydantic import BaseModel, Field

from . import _agents_md_fallback
from . import pi_api
from . import recorder

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/pi")


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

SYNTHESIS_MODEL = os.environ.get(
    "ARC_SYNTHESIS_MODEL", "anthropic/claude-sonnet-4.5"
)
# Synthesis is one big call; budget 3 minutes end-to-end.
SYNTHESIS_TIMEOUT_SECONDS = 180

# Soft input-token cap we enforce client-side via 4-chars-per-token. Sonnet
# 4.5 has a 200k window; leaving 50k headroom for the assistant's tool-call
# and any reasoning tokens.
SYNTHESIS_INPUT_TOKEN_BUDGET = 150_000

AGENTS_MD_URL = (
    f"https://raw.githubusercontent.com/{recorder.REPO_OWNER}/"
    f"{recorder.REPO_NAME}/main/public/AGENTS.md"
)

# Cache for AGENTS.md; reuses the recorder's general-purpose URL→text cache
# so a single in-process map serves both. 5-minute TTL matches PROMPT_TTL.
_agents_md_cache: dict[str, tuple[float, str]] = {}

# Per-reviewer head-of-chain feedback cache (Phase C1.5).
_FEEDBACK_BY_REVIEWER_TTL_SECONDS = 30
_feedback_by_reviewer_cache: dict[str, tuple[float, list[dict]]] = {}


# ---------------------------------------------------------------------------
# Phase C1 — Synthesize drafts request/response shapes
# ---------------------------------------------------------------------------


class DraftPromptInput(BaseModel):
    name: str  # "coach" | "fast_eval" | "deep_eval"
    original: str
    current: str


class SynthesisFeedbackItem(BaseModel):
    head_id: str
    kind: str  # "session_rating" | "turn_annotation" | "coach_issue_review"
    pi: str
    project: str
    student: str
    session_ts: str
    session_prompts_sha: Optional[str] = None
    reviewer: str
    ts: str
    payload: dict
    already_folded_in: bool = False


class SynthesizeDraftsRequest(BaseModel):
    draft_set_id: str
    schema_version: int = 1
    reviewer: str = Field(..., min_length=1, max_length=80)
    baseline_sha: Optional[str] = None
    prompts: list[DraftPromptInput]
    feedback_items: list[SynthesisFeedbackItem]
    model: Optional[str] = None


class DraftPromptOutput(BaseModel):
    name: str
    new_text: Optional[str]
    summary: str
    rationale: str
    coach_issues_categories: Optional[list[str]] = None
    student_red_flags_categories: Optional[list[str]] = None
    validation_warnings: list[str] = []


class SynthesisUsage(BaseModel):
    model: str
    prompt_tokens: Optional[int] = None
    completion_tokens: Optional[int] = None
    elapsed_seconds: float
    agents_md_source: str = "github"  # "github" | "fallback"


class SynthesizeDraftsResponse(BaseModel):
    draft_set_id: str
    synthesized_at: str
    feedback_snapshot_ts: str
    model: str
    prompts: list[DraftPromptOutput]
    usage: SynthesisUsage
    baseline_sha: Optional[str] = None
    feedback_item_count: int
    warnings: list[str] = []


# ---------------------------------------------------------------------------
# Tool schema (the LLM is forced to call this)
# ---------------------------------------------------------------------------


def _eval_prompt_schema() -> dict:
    return {
        "type": "object",
        "properties": {
            "new_text": {"type": ["string", "null"]},
            "summary": {
                "type": "string",
                "description": (
                    "One-line caption (≤120 chars) summarizing the change, "
                    "or the reason for no change."
                ),
            },
            "rationale": {
                "type": "string",
                "description": (
                    "Longer prose (1-3 paragraphs) explaining what feedback "
                    "drove the edit and how the edit addresses it."
                ),
            },
            "coach_issues_categories": {
                "type": "array",
                "items": {"type": "string"},
                "description": (
                    "Exact category strings used in your draft's "
                    "coach_issues enum table. REQUIRED whenever new_text is "
                    "non-null. The validator diffs this against the master "
                    "list in recorder.py."
                ),
            },
            "student_red_flags_categories": {
                "type": "array",
                "items": {"type": "string"},
                "description": (
                    "Exact category strings used in your draft's "
                    "student_red_flags enum table. REQUIRED whenever "
                    "new_text is non-null."
                ),
            },
        },
        "required": ["new_text", "summary", "rationale"],
    }


SYNTHESIZE_DRAFTS_TOOL_SCHEMA = {
    "type": "function",
    "function": {
        "name": "submit_prompt_drafts",
        "description": (
            "Return updated drafts for any of the three editable prompts. "
            "Set new_text to null for any prompt that doesn't need to change. "
            "For the two eval prompts, also return the explicit lists of "
            "coach_issues and student_red_flags categories used in your "
            "draft so the validator can check enum coverage without "
            "parsing markdown."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "coach": {
                    "type": "object",
                    "properties": {
                        "new_text": {"type": ["string", "null"]},
                        "summary": {"type": "string"},
                        "rationale": {"type": "string"},
                    },
                    "required": ["new_text", "summary", "rationale"],
                },
                "fast_eval": _eval_prompt_schema(),
                "deep_eval": _eval_prompt_schema(),
            },
            "required": ["coach", "fast_eval", "deep_eval"],
            "additionalProperties": False,
        },
    },
}


# ---------------------------------------------------------------------------
# AGENTS.md fetch with offline fallback
# ---------------------------------------------------------------------------


async def _fetch_agents_md() -> tuple[str, str]:
    """Return `(content, source)` where source is `"github"` or `"fallback"`."""
    try:
        text = await recorder._fetch_text_with_cache(
            _agents_md_cache, AGENTS_MD_URL
        )
        return text, "github"
    except httpx.HTTPError as e:
        logger.warning(f"agents_md fallback used; github fetch failed: {e}")
        return _agents_md_fallback.AGENTS_MD_FALLBACK, "fallback"


# ---------------------------------------------------------------------------
# System / user prompt construction
# ---------------------------------------------------------------------------


def _invariants_block() -> str:
    coach_issue_lines = "\n".join(
        f"  - `{c}`" for c in sorted(recorder.COACH_ISSUE_CATEGORIES)
    )
    red_flag_lines = "\n".join(
        f"  - `{c}`" for c in sorted(recorder.STUDENT_RED_FLAG_CATEGORIES)
    )
    return (
        "## Cross-prompt invariants (auto-generated from recorder.py)\n\n"
        "These category strings are shared across the fast and deep "
        "evaluator prompts and the recorder.py master list. Renames must "
        "be coordinated across all three.\n\n"
        f"`COACH_ISSUE_CATEGORIES`:\n{coach_issue_lines}\n\n"
        f"`STUDENT_RED_FLAG_CATEGORIES`:\n{red_flag_lines}\n"
    )


def _framing_wrapper() -> str:
    return (
        "# Your role\n\n"
        "You are an editor of three prompt files for an AI tutoring system "
        "called the AI Research Coach. The system is composed of:\n\n"
        "- a **coach** (system prompt: `instructions-v1.md`) that talks to "
        "the student;\n"
        "- a **fast evaluator** (`fast-eval-prompt.md`) that runs after each "
        "student turn and outputs a tactical correction signal;\n"
        "- a **deep evaluator** (`deep-eval-prompt.md`) that maintains a "
        "session-long picture.\n\n"
        "A principal investigator (PI) reviews recorded sessions and leaves "
        "feedback. Your job: fold the PI's feedback into updated drafts of "
        "all three prompts.\n\n"
        "## Rules\n\n"
        "1. The PI dashboard only edits these three prompts. Feedback that "
        "applies only to the recorder prompt (e.g. complaints about session "
        "summaries) should be acknowledged in `summary`/`rationale` but "
        "should NOT drive edits — leave those prompts unchanged.\n"
        "2. Preserve every `${...}` placeholder in `instructions-v1.md`. "
        "Removing one is a runtime error.\n"
        "3. Preserve the YAML frontmatter lines in `instructions-v1.md`: "
        "`parameters:`, `suggestions-enabled:`, `recording-mode: split`.\n"
        "4. The `coach_issues` and `student_red_flags` enum strings must "
        "stay consistent between `fast-eval-prompt.md` and "
        "`deep-eval-prompt.md`. If you rename one in either prompt, rename "
        "it in the other too. Net additions or deletions are allowed but "
        "must be applied to both prompts at once.\n"
        "5. **Output convention.** For any prompt where no edit is "
        "warranted, return `new_text: null`. Do NOT return a verbatim copy "
        "of the current draft — null is the right way to signal 'no change'.\n"
        "6. **Round 2+ guard.** Each feedback item carries an "
        "`already_folded_in` flag. Items where this is true were already "
        "folded into the current draft by a prior synthesis run. Treat "
        "those as resolved unless the current draft demonstrably failed to "
        "address them. Do NOT re-correct items that are already fine.\n"
        "7. Whenever you return a non-null `new_text` for `fast_eval` or "
        "`deep_eval`, you MUST also return the exact "
        "`coach_issues_categories` and `student_red_flags_categories` lists "
        "used in your draft. The validator diffs these against the master "
        "list in `recorder.py` to catch silent enum drift.\n"
    )


async def _build_system_prompt() -> tuple[str, str]:
    """Return `(system_prompt_text, agents_md_source)`."""
    agents_md, source = await _fetch_agents_md()
    parts = [
        _framing_wrapper(),
        "---\n\n# Verbatim AGENTS.md (canonical editing guide)\n\n" + agents_md,
        "---\n\n" + _invariants_block(),
    ]
    return "\n\n".join(parts), source


def _quote_fenced(text: str) -> str:
    """Embed `text` in a fenced code block. Uses four backticks if the
    content already contains a triple-backtick run."""
    fence = "```"
    if "```" in text:
        fence = "````"
    return f"{fence}\n{text}\n{fence}"


def _excerpt_for_item(
    item: SynthesisFeedbackItem,
    excerpts_by_session: dict[tuple, str],
) -> Optional[str]:
    """Look up the precomputed (per-session, merged) excerpt for this item."""
    key = (item.pi, item.project, item.student, item.session_ts)
    return excerpts_by_session.get(key)


def _build_excerpts_server_side(
    items: list[SynthesisFeedbackItem],
) -> dict[tuple, str]:
    """For each turn-anchored item, build a ±3-turn excerpt. Adjacent
    windows in the same session are merged; session-level items get no
    excerpt.

    Returns `{(pi, project, student, session_ts): merged_excerpt_text}`.
    """
    by_session: dict[tuple, list[int]] = {}
    for it in items:
        if it.kind not in ("turn_annotation", "coach_issue_review"):
            continue
        turn = it.payload.get("turn")
        if not isinstance(turn, int) or turn < 1:
            continue
        key = (it.pi, it.project, it.student, it.session_ts)
        by_session.setdefault(key, []).append(turn)

    out: dict[tuple, str] = {}
    for key, turns in by_session.items():
        # Resolve session dir on disk; skip silently if missing/invalid.
        try:
            session_dir = pi_api._resolve_session_dir(*key)
        except HTTPException:
            continue
        if not session_dir.exists():
            continue
        transcript = pi_api._read_jsonl(session_dir / "transcript.jsonl") or []
        if not transcript:
            continue

        # User-message indices, 1-indexed by user turn (mirrors the
        # SessionViewer pattern at SessionViewer.tsx:543-562).
        user_indices: list[int] = [
            i for i, m in enumerate(transcript) if m.get("role") == "user"
        ]
        n_turns = len(user_indices)
        if n_turns == 0:
            continue

        # Build the union of ±3 windows (in user-turn space), then expand to
        # transcript-message slices.
        wanted_turns: set[int] = set()
        flagged_turns = sorted({t for t in turns if 1 <= t <= n_turns})
        for t in flagged_turns:
            for x in range(max(1, t - 3), min(n_turns, t + 3) + 1):
                wanted_turns.add(x)

        if not wanted_turns:
            continue

        sorted_turns = sorted(wanted_turns)

        # Group consecutive runs so the rendered excerpt naturally collapses.
        runs: list[list[int]] = []
        current: list[int] = []
        for t in sorted_turns:
            if not current or t == current[-1] + 1:
                current.append(t)
            else:
                runs.append(current)
                current = [t]
        if current:
            runs.append(current)

        flagged_set = set(flagged_turns)
        rendered_parts: list[str] = []
        for run in runs:
            run_lines: list[str] = []
            run_lines.append(
                f"--- turns {run[0]}–{run[-1]} "
                f"(flagged: {', '.join(str(t) for t in run if t in flagged_set) or 'none'}) ---"
            )
            for t in run:
                # User message at user_indices[t-1]; assistant follow-up (if
                # any) at the next index.
                idx = user_indices[t - 1]
                u = transcript[idx]
                u_content = u.get("content", "")
                marker = " (flagged)" if t in flagged_set else ""
                run_lines.append(
                    f"turn {t} user{marker}: {_truncate_text(u_content, 600)}"
                )
                # Assistant response, if present, lives between this user
                # index and the next user index.
                next_user_idx = (
                    user_indices[t] if t < len(user_indices) else len(transcript)
                )
                for j in range(idx + 1, next_user_idx):
                    m = transcript[j]
                    role = m.get("role", "?")
                    content = m.get("content", "")
                    run_lines.append(
                        f"turn {t} {role}: {_truncate_text(content, 800)}"
                    )
            rendered_parts.append("\n".join(run_lines))
        out[key] = "\n\n".join(rendered_parts)

    return out


def _truncate_text(text: Any, max_chars: int) -> str:
    if not isinstance(text, str):
        try:
            text = json.dumps(text)
        except (TypeError, ValueError):
            text = str(text)
    if len(text) <= max_chars:
        return text
    return text[:max_chars] + " …(truncated)"


def _format_feedback_item(
    item: SynthesisFeedbackItem,
    excerpt: Optional[str],
) -> str:
    sha_label = item.session_prompts_sha or "unknown"
    head_lines = [
        f"### Feedback {item.head_id} ({item.kind})",
        f"- session: `{item.pi}/{item.project}/{item.student}/{item.session_ts}`",
        f"- session_prompts_sha: `{sha_label}`",
        f"- reviewer: {item.reviewer}",
        f"- ts: {item.ts}",
        f"- already_folded_in: {str(item.already_folded_in).lower()}",
    ]

    payload_lines = ["", "Payload:"]
    for k, v in item.payload.items():
        if k == "retracted":
            continue
        payload_lines.append(f"- `{k}`: {_truncate_text(v, 400)}")

    section = "\n".join(head_lines + payload_lines)
    if excerpt:
        section += "\n\nTranscript excerpt:\n" + _quote_fenced(excerpt)
    return section


def _build_user_message(
    body: SynthesizeDraftsRequest,
    excerpts_by_session: dict[tuple, str],
    max_input_chars: int,
) -> tuple[str, list[str]]:
    """Compose the structured user message. Drops oldest items (in-place)
    when the rough char count exceeds `max_input_chars`. Returns
    `(text, warnings)`.
    """
    warnings: list[str] = []

    by_name = {p.name: p for p in body.prompts}
    coach = by_name.get("coach")
    fast_eval = by_name.get("fast_eval")
    deep_eval = by_name.get("deep_eval")
    if not (coach and fast_eval and deep_eval):
        raise HTTPException(
            status_code=400,
            detail="prompts must include coach, fast_eval, deep_eval",
        )

    baseline_label = body.baseline_sha or "(not pinned)"
    feedback_count = len(body.feedback_items)

    header = (
        f"## Baseline\n\n"
        f"- Baseline SHA: `{baseline_label}`\n"
        f"- Reviewer: {body.reviewer}\n"
        f"- Draft set ID: {body.draft_set_id}\n"
        f"- Feedback items folded in: {feedback_count}\n"
    )

    originals_section = (
        "## Originals (snapshot of head of main at draft-set creation)\n\n"
        "### coach prompt — instructions-v1.md\n\n"
        + _quote_fenced(coach.original)
        + "\n\n### fast-eval prompt — fast-eval-prompt.md\n\n"
        + _quote_fenced(fast_eval.original)
        + "\n\n### deep-eval prompt — deep-eval-prompt.md\n\n"
        + _quote_fenced(deep_eval.original)
    )

    drafts_section = (
        "## Current drafts (starting point — apply edits to these)\n\n"
        "### coach prompt — instructions-v1.md\n\n"
        + _quote_fenced(coach.current)
        + "\n\n### fast-eval prompt — fast-eval-prompt.md\n\n"
        + _quote_fenced(fast_eval.current)
        + "\n\n### deep-eval prompt — deep-eval-prompt.md\n\n"
        + _quote_fenced(deep_eval.current)
    )

    task_section = (
        "## Your task\n\n"
        "Decide what edits to the three drafts would best address the **new "
        "(not-yet-folded-in) feedback**, while:\n\n"
        "- preserving the invariants spelled out in AGENTS.md (placeholders, "
        "YAML frontmatter, shared enum strings),\n"
        "- keeping prior edits in the current draft intact unless new "
        "feedback contradicts them,\n"
        "- treating already-folded-in feedback as resolved unless the "
        "current draft demonstrably failed to address it.\n\n"
        "Return a single submit_prompt_drafts call with one entry per "
        "prompt. For any prompt where no edit is warranted, return "
        "`new_text: null` and explain why in `summary` and `rationale`. "
        "For non-null fast_eval/deep_eval edits, ALWAYS include the exact "
        "`coach_issues_categories` and `student_red_flags_categories` lists "
        "used in your draft."
    )

    # Sort items: kind, then unfolded first, then by session_ts.
    items = list(body.feedback_items)
    items.sort(
        key=lambda it: (
            it.kind,
            0 if not it.already_folded_in else 1,
            it.session_ts,
            it.head_id,
        ),
    )

    def render_items(items_to_render: list[SynthesisFeedbackItem]) -> str:
        if not items_to_render:
            return "## Feedback items\n\n(none — synthesis call requested with empty feedback list)"
        blocks: list[str] = ["## Feedback items"]
        current_kind: Optional[str] = None
        for it in items_to_render:
            if it.kind != current_kind:
                pretty = it.kind.replace("_", " ")
                blocks.append(f"\n### Kind: {pretty}\n")
                current_kind = it.kind
            blocks.append(_format_feedback_item(it, _excerpt_for_item(it, excerpts_by_session)))
        return "\n\n".join(blocks)

    def assemble(items_subset: list[SynthesisFeedbackItem]) -> str:
        return (
            header
            + "\n"
            + originals_section
            + "\n\n"
            + drafts_section
            + "\n\n"
            + render_items(items_subset)
            + "\n\n"
            + task_section
        )

    text = assemble(items)
    dropped = 0
    while len(text) > max_input_chars and items:
        # Drop the oldest item (front of list — items are sorted with
        # unfolded-first per kind, but for budget overflow we just drop
        # from the back of the queue: oldest by session_ts).
        # Find the item with the smallest session_ts and remove it.
        items_sorted_by_age = sorted(items, key=lambda it: (it.session_ts, it.ts))
        oldest = items_sorted_by_age[0]
        items = [it for it in items if it.head_id != oldest.head_id]
        dropped += 1
        text = assemble(items)

    if dropped:
        warnings.append(
            f"dropped {dropped} oldest feedback item(s) to fit input token "
            f"budget ({max_input_chars} chars ≈ {max_input_chars // 4} tokens)"
        )

    return text, warnings


# ---------------------------------------------------------------------------
# Phase C2 — Validators
# ---------------------------------------------------------------------------


_PLACEHOLDER_RE = re.compile(r"\$\{([a-zA-Z_]+)\}")


def _validate_coach_placeholders(original: str, new_text: str) -> list[str]:
    out: list[str] = []
    original_placeholders = set(_PLACEHOLDER_RE.findall(original))
    new_placeholders = set(_PLACEHOLDER_RE.findall(new_text))
    missing = sorted(original_placeholders - new_placeholders)
    for name in missing:
        out.append(
            f"Coach prompt missing placeholder: `${{{name}}}` "
            "(present in original; removing one causes session-start failure)."
        )
    return out


def _validate_coach_yaml_lines(new_text: str) -> list[str]:
    """Look for the three required frontmatter lines in the first ~40 lines.

    AGENTS.md "What NOT to change" calls out:
    - `parameters:`
    - `suggestions-enabled:`
    - `recording-mode: split`
    """
    out: list[str] = []
    head = "\n".join(new_text.splitlines()[:40])
    if not re.search(r"(?mi)^parameters\s*:", head):
        out.append(
            "Coach prompt missing `parameters:` frontmatter line "
            "(see AGENTS.md 'What NOT to change')."
        )
    if not re.search(r"(?mi)^suggestions-enabled\s*:", head):
        out.append(
            "Coach prompt missing `suggestions-enabled:` frontmatter line."
        )
    if not re.search(r"(?mi)^recording-mode\s*:\s*split", head):
        out.append(
            "Coach prompt missing `recording-mode: split` frontmatter line "
            "(removing it reverts to the legacy single-agent mode)."
        )
    return out


def _validate_eval_categories_present(
    name: str,
    coach_issues_categories: Optional[list[str]],
    student_red_flags_categories: Optional[list[str]],
) -> list[str]:
    out: list[str] = []
    if coach_issues_categories is None:
        out.append(
            f"{name}: synthesis model did not return `coach_issues_categories`; "
            "enum coverage cannot be checked."
        )
    if student_red_flags_categories is None:
        out.append(
            f"{name}: synthesis model did not return `student_red_flags_categories`; "
            "enum coverage cannot be checked."
        )
    return out


def _validate_set(
    name: str,
    label: str,
    emitted: Optional[list[str]],
    master: set[str],
) -> list[str]:
    if emitted is None:
        return []
    out: list[str] = []
    emitted_set = {s for s in emitted if isinstance(s, str)}
    missing = sorted(master - emitted_set)
    extra = sorted(emitted_set - master)
    for m in missing:
        out.append(
            f"{name}: `{label}` missing category `{m}` "
            "(category dropped from the enum table — verify this is intentional)."
        )
    for e in extra:
        out.append(
            f"{name}: `{label}` introduces new category `{e}` "
            f"(must also be added to recorder.py before this draft can ship)."
        )
    return out


def _validate_cross_prompt_agreement(
    name: str,
    cross_prompt_categories: dict[str, dict[str, Optional[list[str]]]],
) -> list[str]:
    """Fire only when both eval prompts emitted non-null categories and
    the two lists disagree."""
    fast = cross_prompt_categories.get("fast_eval") or {}
    deep = cross_prompt_categories.get("deep_eval") or {}
    out: list[str] = []
    for label, fkey, dkey in (
        ("coach_issues", "coach_issues", "coach_issues"),
        ("student_red_flags", "student_red_flags", "student_red_flags"),
    ):
        f = fast.get(fkey)
        d = deep.get(dkey)
        if f is None or d is None:
            continue
        f_set = {s for s in f if isinstance(s, str)}
        d_set = {s for s in d if isinstance(s, str)}
        if f_set != d_set:
            only_fast = sorted(f_set - d_set)
            only_deep = sorted(d_set - f_set)
            parts = []
            if only_fast:
                parts.append(f"only in fast_eval: {', '.join(only_fast)}")
            if only_deep:
                parts.append(f"only in deep_eval: {', '.join(only_deep)}")
            out.append(
                f"{name}: `{label}` enum disagrees between fast_eval and "
                f"deep_eval ({'; '.join(parts)}). The two prompts must use "
                "the same set."
            )
    return out


def run_validators(
    *,
    name: str,
    original: str,
    current: str,
    new_text: str,
    coach_issues_categories: Optional[list[str]],
    student_red_flags_categories: Optional[list[str]],
    cross_prompt_categories: dict[str, dict[str, Optional[list[str]]]],
) -> list[str]:
    warnings: list[str] = []
    if name == "coach":
        warnings.extend(_validate_coach_placeholders(original, new_text))
        warnings.extend(_validate_coach_yaml_lines(new_text))
    if name in ("fast_eval", "deep_eval"):
        warnings.extend(_validate_eval_categories_present(
            name, coach_issues_categories, student_red_flags_categories,
        ))
        warnings.extend(_validate_set(
            name, "coach_issues", coach_issues_categories,
            recorder.COACH_ISSUE_CATEGORIES,
        ))
        warnings.extend(_validate_set(
            name, "student_red_flags", student_red_flags_categories,
            recorder.STUDENT_RED_FLAG_CATEGORIES,
        ))
        warnings.extend(_validate_cross_prompt_agreement(
            name, cross_prompt_categories,
        ))
    # Silence the unused-arg linter; `current` is part of the contract for
    # future rules even if no rule reads it today.
    _ = current
    return warnings


def _collect_cross_prompt_categories(
    args: dict,
) -> dict[str, dict[str, Optional[list[str]]]]:
    out: dict[str, dict[str, Optional[list[str]]]] = {}
    for name in ("fast_eval", "deep_eval"):
        entry = args.get(name) or {}
        if entry.get("new_text") is None:
            # No edit means no consistency concern.
            out[name] = {"coach_issues": None, "student_red_flags": None}
            continue
        out[name] = {
            "coach_issues": entry.get("coach_issues_categories"),
            "student_red_flags": entry.get("student_red_flags_categories"),
        }
    return out


# ---------------------------------------------------------------------------
# Phase C1 — Endpoint
# ---------------------------------------------------------------------------


def _current_for(name: str, body: SynthesizeDraftsRequest) -> str:
    for p in body.prompts:
        if p.name == name:
            return p.current
    return ""


def _original_for(name: str, body: SynthesizeDraftsRequest) -> str:
    for p in body.prompts:
        if p.name == name:
            return p.original
    return ""


@router.post("/synthesize-drafts", response_model=SynthesizeDraftsResponse)
async def synthesize_drafts(
    body: SynthesizeDraftsRequest = Body(...),
    passcode: Optional[str] = Query(None),
    x_pi_passcode: Optional[str] = Header(None, alias="X-PI-Passcode"),
):
    pi_api._validate_pi_passcode(x_pi_passcode, passcode)

    if len(body.prompts) != 3:
        raise HTTPException(
            status_code=400,
            detail="Expected exactly 3 prompts (coach, fast_eval, deep_eval)",
        )
    names_seen = sorted(p.name for p in body.prompts)
    if names_seen != ["coach", "deep_eval", "fast_eval"]:
        raise HTTPException(
            status_code=400,
            detail=(
                "prompts must include exactly the three editable agents: "
                f"coach, fast_eval, deep_eval (got {names_seen})"
            ),
        )
    if body.schema_version != 1:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Unsupported draft schema_version {body.schema_version}; "
                "expected 1"
            ),
        )

    model = body.model or SYNTHESIS_MODEL

    feedback_snapshot_ts = datetime.now(timezone.utc).isoformat()
    excerpts_by_session = _build_excerpts_server_side(body.feedback_items)

    system_prompt, agents_md_source = await _build_system_prompt()
    user_message, payload_warnings = _build_user_message(
        body, excerpts_by_session, max_input_chars=SYNTHESIS_INPUT_TOKEN_BUDGET * 4,
    )

    started = time.monotonic()
    msg, raw_usage = await recorder._openrouter_call_with_usage(
        model=model,
        system_prompt=system_prompt,
        user_message=user_message,
        tools=[SYNTHESIZE_DRAFTS_TOOL_SCHEMA],
        tool_choice={
            "type": "function",
            "function": {"name": "submit_prompt_drafts"},
        },
        timeout_seconds=SYNTHESIS_TIMEOUT_SECONDS,
        kind="synthesize_drafts",
        student_id=body.reviewer,
        project_id="drafts",
    )
    elapsed = time.monotonic() - started

    if msg is None:
        raise HTTPException(
            status_code=502,
            detail=(
                "Synthesis call to OpenRouter failed (timeout, non-200, or "
                "API key missing). Try again or switch models."
            ),
        )

    args = recorder._extract_tool_args(msg, "submit_prompt_drafts")
    if not args or not all(k in args for k in ("coach", "fast_eval", "deep_eval")):
        raise HTTPException(
            status_code=502,
            detail=(
                "Synthesis model did not return a complete tool call. "
                "Try clicking Synthesize again or switch models."
            ),
        )

    cross_prompt_categories = _collect_cross_prompt_categories(args)

    out: list[DraftPromptOutput] = []
    changed_names: list[str] = []
    for name in ("coach", "fast_eval", "deep_eval"):
        entry = args.get(name) or {}
        raw_new = entry.get("new_text")
        current = _current_for(name, body)
        original = _original_for(name, body)

        # Whitespace-equal copies collapse to "no change".
        if raw_new is None:
            new_text: Optional[str] = None
        elif isinstance(raw_new, str) and raw_new.strip() == current.strip():
            new_text = None
        else:
            new_text = raw_new

        summary = entry.get("summary") or ""
        rationale = entry.get("rationale") or ""
        coach_cats = entry.get("coach_issues_categories")
        red_flag_cats = entry.get("student_red_flags_categories")

        warnings = (
            run_validators(
                name=name,
                original=original,
                current=current,
                new_text=new_text,
                coach_issues_categories=coach_cats,
                student_red_flags_categories=red_flag_cats,
                cross_prompt_categories=cross_prompt_categories,
            )
            if new_text
            else []
        )

        if new_text:
            changed_names.append(name)

        out.append(
            DraftPromptOutput(
                name=name,
                new_text=new_text,
                summary=summary,
                rationale=rationale,
                coach_issues_categories=coach_cats if isinstance(coach_cats, list) else None,
                student_red_flags_categories=red_flag_cats if isinstance(red_flag_cats, list) else None,
                validation_warnings=warnings,
            )
        )

    response = SynthesizeDraftsResponse(
        draft_set_id=body.draft_set_id,
        synthesized_at=datetime.now(timezone.utc).isoformat(),
        feedback_snapshot_ts=feedback_snapshot_ts,
        model=model,
        prompts=out,
        usage=SynthesisUsage(
            model=model,
            prompt_tokens=raw_usage.get("prompt_tokens") if isinstance(raw_usage, dict) else None,
            completion_tokens=raw_usage.get("completion_tokens") if isinstance(raw_usage, dict) else None,
            elapsed_seconds=elapsed,
            agents_md_source=agents_md_source,
        ),
        baseline_sha=body.baseline_sha,
        feedback_item_count=len(body.feedback_items),
        warnings=payload_warnings,
    )

    folded_count = sum(1 for it in body.feedback_items if it.already_folded_in)
    logger.info(
        "synthesize_drafts reviewer=%s draft_set=%s items=%d already_folded=%d "
        "model=%s agents_md=%s prompt_tokens=%s completion_tokens=%s "
        "elapsed=%.2f changed_prompts=%s",
        body.reviewer,
        body.draft_set_id,
        len(body.feedback_items),
        folded_count,
        model,
        agents_md_source,
        response.usage.prompt_tokens,
        response.usage.completion_tokens,
        elapsed,
        ",".join(changed_names) or "(none)",
    )

    return response


# ---------------------------------------------------------------------------
# Phase C1.5 — feedback-by-reviewer endpoint
# ---------------------------------------------------------------------------


def _walk_feedback_for_reviewer(root: Path, reviewer: str) -> list[dict]:
    """Walk the coach-sessions clone and return one head-of-chain entry per
    chain that the named reviewer authored.

    The shape mirrors `feedbackUtils.chainsForEntries` on the frontend: a
    chain's head is the entry that nothing else supersedes. We only emit
    heads, not the full chain history.
    """
    items: list[dict] = []
    if not root.exists():
        return items

    for pi_dir in sorted(p for p in root.iterdir() if p.is_dir() and not p.name.startswith(".")):
        for project_dir in sorted(
            p for p in pi_dir.iterdir() if p.is_dir() and not p.name.startswith(".")
        ):
            for student_dir in sorted(
                p for p in project_dir.iterdir() if p.is_dir() and not p.name.startswith(".")
            ):
                sessions_dir = student_dir / "sessions"
                if not sessions_dir.exists():
                    continue
                for session_dir in sorted(
                    s for s in sessions_dir.iterdir() if s.is_dir()
                ):
                    feedback_path = session_dir / "feedback.json"
                    bundle = pi_api._read_json_or_none(feedback_path)
                    if not isinstance(bundle, dict):
                        continue
                    metadata = pi_api._read_json_or_none(session_dir / "metadata.json")
                    sha: Optional[str] = None
                    if isinstance(metadata, dict):
                        s = metadata.get("prompts_sha")
                        if isinstance(s, str):
                            sha = s

                    for kind, section_key in (
                        ("session_rating", "session_ratings"),
                        ("turn_annotation", "turn_annotations"),
                        ("coach_issue_review", "coach_issue_reviews"),
                    ):
                        entries = bundle.get(section_key)
                        if not isinstance(entries, list):
                            continue
                        # Build a head set for this section.
                        by_id: dict[str, dict] = {}
                        for e in entries:
                            if isinstance(e, dict) and isinstance(e.get("id"), str):
                                by_id[e["id"]] = e
                        superseded: set[str] = set()
                        for e in entries:
                            if not isinstance(e, dict):
                                continue
                            sup = e.get("supersedes")
                            if isinstance(sup, str):
                                superseded.add(sup)
                        # Heads: entries not superseded by anything.
                        for e in entries:
                            if not isinstance(e, dict):
                                continue
                            eid = e.get("id")
                            if not isinstance(eid, str) or eid in superseded:
                                continue
                            if e.get("reviewer") != reviewer:
                                continue
                            payload = {k: v for k, v in e.items() if k not in {"id", "reviewer", "ts", "supersedes"}}
                            items.append({
                                "head_id": eid,
                                "kind": kind,
                                "pi": pi_dir.name,
                                "project": project_dir.name,
                                "student": student_dir.name,
                                "session_ts": session_dir.name,
                                "session_prompts_sha": sha,
                                "reviewer": reviewer,
                                "ts": e.get("ts") or "",
                                "payload": payload,
                            })

    return items


@router.get("/feedback-by-reviewer")
async def get_feedback_by_reviewer(
    reviewer: str = Query(..., min_length=1, max_length=80),
    passcode: Optional[str] = Query(None),
    x_pi_passcode: Optional[str] = Header(None, alias="X-PI-Passcode"),
):
    pi_api._validate_pi_passcode(x_pi_passcode, passcode)

    now = time.monotonic()
    cached = _feedback_by_reviewer_cache.get(reviewer)
    snapshot_ts = datetime.now(timezone.utc).isoformat()
    if cached is not None and now - cached[0] < _FEEDBACK_BY_REVIEWER_TTL_SECONDS:
        return {
            "items": cached[1],
            "cached": True,
            "snapshot_ts": snapshot_ts,
        }

    await pi_api._refresh_coach_sessions_clone()
    items = _walk_feedback_for_reviewer(recorder.COACH_SESSIONS_DIR, reviewer)
    _feedback_by_reviewer_cache[reviewer] = (now, items)
    return {
        "items": items,
        "cached": False,
        "snapshot_ts": snapshot_ts,
    }


def invalidate_feedback_by_reviewer_cache() -> None:
    """Bust the cache. Called from `pi_api._append_feedback_entry` whenever
    a feedback POST succeeds. Coarse but correct — feedback writes are
    infrequent."""
    _feedback_by_reviewer_cache.clear()
