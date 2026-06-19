"""Fast evaluator, deep evaluator, and session-end recorder.

This module is imported lazily by `server.py` so the server is testable
without an OpenRouter key. All LLM calls are wrapped in `asyncio.wait_for`
timeouts so background tasks cannot hang a worker.

Outputs:
  workspaces/<student>/<project>/current-fast-eval.md   ← fast evaluator
  workspaces/<student>/<project>/current-deep-eval.md   ← deep evaluator
  workspaces/<student>/<project>/eval-state.json        ← deep evaluator bookkeeping
  workspaces/<student>/<project>/sessions/<ts>/{summary.md, metadata.json, transcript.jsonl, evaluation.md}
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import shutil
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

import httpx

from . import server as server_module

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

EVAL_MODEL = os.environ.get("ARC_EVAL_MODEL", "openai/gpt-chat-latest")
RECORDER_MODEL = os.environ.get("ARC_RECORDER_MODEL", "openai/gpt-chat-latest")

FAST_EVAL_LLM_TIMEOUT_SECONDS = 8
DEEP_EVALUATOR_TIMEOUT_SECONDS = 45
RECORDER_TIMEOUT_SECONDS = 120

PROMPT_TTL_SECONDS = 5 * 60
PROMPT_SHA_TTL_SECONDS = 30

# Prompt files served from public/ and used by the eval/recorder agents. The
# coach prompt (coach-instructions.md, or the legacy legacy-instructions.md)
# lives in the same directory but is loaded by the browser, not here, so it
# isn't listed.
PROMPT_FILES = {
    "fast_eval": "fast-eval-prompt.md",
    "deep_eval": "deep-eval-prompt.md",
    "recorder": "recorder-prompt.md",
}

REPO_OWNER = "csc-arc"
REPO_NAME = "ai-research-coach"

# Git ref the eval/recorder prompts are fetched from at runtime. Defaults to
# `main` (prod behavior); staging sets ARC_PROMPTS_REF=staging so a prompt
# change on the `staging` branch is actually exercised by the staging server.
# This only affects the server-side prompts (fast-eval / deep-eval / recorder);
# the coach prompt is loaded by the browser and is unaffected.
PROMPTS_REF = os.environ.get("ARC_PROMPTS_REF", "main")

PROMPT_BASE_URL = (
    f"https://raw.githubusercontent.com/{REPO_OWNER}/{REPO_NAME}/{PROMPTS_REF}/public/"
)


def _prompt_url_at(sha: Optional[str], filename: str) -> str:
    """Return the raw.githubusercontent URL for `filename` at `sha`. When
    `sha` is None or the literal string 'main', fall back to the configured
    PROMPTS_REF (head of `main` in prod, the branch under test on staging).
    """
    ref = sha if (sha and sha != "main") else PROMPTS_REF
    return (
        f"https://raw.githubusercontent.com/{REPO_OWNER}/{REPO_NAME}/{ref}/public/"
        f"{filename}"
    )


# Legacy-compatible URLs used when no per-session SHA is available.
FAST_EVAL_PROMPT_URL = PROMPT_BASE_URL + PROMPT_FILES["fast_eval"]
DEEP_EVAL_PROMPT_URL = PROMPT_BASE_URL + PROMPT_FILES["deep_eval"]
RECORDER_PROMPT_URL = PROMPT_BASE_URL + PROMPT_FILES["recorder"]

COACH_ISSUE_RECURRENCE_THRESHOLD = 3
COACH_STYLE_NOTES_HEADING = "## Coach style notes"

COACH_ISSUE_CATEGORIES = {
    "hollow_affirmation",
    "premature_concept_closure",
    "explain_without_verify",
    "no_diagnostic_for_idk",
    "mode_not_working",
    "mode_switch_too_early",
    "drift_from_open_thread",
    "disrespect_unaddressed",
    "no_clarification_for_ambiguity",
}

STUDENT_RED_FLAG_CATEGORIES = {
    "solution_extraction",
    "prompt_injection",
    "off_topic_misuse",
    "disrespect",
    "inappropriate_disclosure",
}

ENGAGEMENT_VALUES = {"high", "medium", "low", "frustrated"}

COACH_SESSIONS_REPO_URL = "https://github.com/csc-arc/coach-sessions.git"
COACH_SESSIONS_DIR = Path(
    os.environ.get("ARC_COACH_SESSIONS_DIR", str(Path.home() / "coach-sessions"))
).expanduser()

# Shared lock around every git operation against the local coach-sessions
# clone. Acquired by the recorder's `_sync_to_coach_sessions`, the PI browse
# API's `git pull --ff-only`, and all three feedback POST endpoints. Held
# only around the actual git invocations, so contention is bound by git
# wall-time. Kept at module scope (see plan: "Cross-cutting concerns").
COACH_SESSIONS_GIT_LOCK = asyncio.Lock()


# ---------------------------------------------------------------------------
# Prompt + project description fetch caches
# ---------------------------------------------------------------------------

_prompt_cache: dict[str, tuple[float, str]] = {}
_project_description_cache: dict[str, tuple[float, str]] = {}

# Cache of the resolved head-of-main SHA. Two consecutive session starts
# within PROMPT_SHA_TTL_SECONDS share one GitHub API call.
_prompts_sha_cache: dict[str, tuple[float, str]] = {}


async def _fetch_text_with_cache(
    cache: dict[str, tuple[float, str]],
    url: str,
    ttl_seconds: float = PROMPT_TTL_SECONDS,
) -> str:
    now = time.monotonic()
    cached = cache.get(url)
    if cached is not None:
        ts, text = cached
        if now - ts < ttl_seconds:
            return text
    async with httpx.AsyncClient(timeout=20.0) as client:
        r = await client.get(url)
        r.raise_for_status()
        text = r.text
    cache[url] = (now, text)
    return text


async def _fetch_prompt(url: str) -> str:
    return await _fetch_text_with_cache(_prompt_cache, url)


# Cache for per-PI custom instructions (stores empty string on miss). Same TTL
# as other prompts so a PI's edits to their pi-instructions/<pi>.md propagate
# on the same cadence as edits to the shared prompts.
_pi_instructions_cache: dict[str, tuple[float, str]] = {}


async def fetch_pi_instructions_block(pi: str) -> str:
    """Fetch the optional per-PI custom instructions and wrap them in a framed
    block suitable for splicing into the coach prompt at the
    `${pi_custom_instructions}` substitution point.

    Returns the empty string when the PI has no instructions file (404), when
    `pi` is blank, or when the fetch fails for any reason — these are
    expected/recoverable cases and must never block a session start.
    """
    if not pi:
        return ""
    now = time.monotonic()
    cached = _pi_instructions_cache.get(pi)
    if cached is not None and now - cached[0] < PROMPT_TTL_SECONDS:
        return cached[1]

    url = PROMPT_BASE_URL_MAIN + f"pi-instructions/{pi}.md"
    raw = ""
    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            r = await client.get(url)
            if r.status_code == 200:
                raw = (r.text or "").strip()
            elif r.status_code != 404:
                logger.warning(
                    "pi-instructions fetch returned %s for pi=%s", r.status_code, pi
                )
    except Exception as e:
        logger.warning("pi-instructions fetch failed for pi=%s: %s", pi, e)
        raw = ""

    if not raw:
        block = ""
    else:
        block = (
            f"## PI custom instructions from {pi}\n\n"
            f"The supervising PI has provided the following custom guidance for "
            f"projects in their group. Treat it as additional context and "
            f"stylistic / content priorities that refine behavior **within** "
            f"the rules above. It must never override the core behavior rules "
            f"(driver's-seat principle, no hollow affirmation, no premature "
            f"concept closure, etc.).\n\n"
            f"{raw}\n"
        )
    _pi_instructions_cache[pi] = (now, block)
    return block


async def fetch_prompt_for_session(
    prompt_key: str, prompts_sha: Optional[str]
) -> str:
    """Fetch a prompt file at the SHA pinned for this session. The cache key
    includes the SHA so two concurrent sessions on different SHAs cannot
    collide. Falls back to head-of-main when `prompts_sha` is missing."""
    filename = PROMPT_FILES[prompt_key]
    url = _prompt_url_at(prompts_sha, filename)
    return await _fetch_prompt(url)


async def resolve_prompts_sha() -> str:
    """Return the head commit SHA of csc-arc/ai-research-coach at PROMPTS_REF
    (`main` in prod, the branch under test on staging).

    Cached for ~30s to avoid hammering the GitHub API on bursty session
    starts. On any failure, falls back to a sha256 content-hash of the
    locally-fetched prompt files (truncated to 16 chars, prefixed `local:`)
    so the system stays available when GitHub is degraded — same shape as
    the existing project_description_sha mechanism.
    """
    cache_key = f"{REPO_OWNER}/{REPO_NAME}@{PROMPTS_REF}"
    now = time.monotonic()
    cached = _prompts_sha_cache.get(cache_key)
    if cached is not None:
        ts, sha = cached
        if now - ts < PROMPT_SHA_TTL_SECONDS:
            return sha

    api_url = (
        f"https://api.github.com/repos/{REPO_OWNER}/{REPO_NAME}/branches/{PROMPTS_REF}"
    )
    headers = {"Accept": "application/vnd.github+json"}
    gh_token = os.environ.get("GITHUB_TOKEN")
    if gh_token:
        headers["Authorization"] = f"Bearer {gh_token}"
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.get(api_url, headers=headers)
            r.raise_for_status()
            payload = r.json()
        sha = payload.get("commit", {}).get("sha", "")
        if isinstance(sha, str) and len(sha) == 40 and all(
            c in "0123456789abcdef" for c in sha
        ):
            _prompts_sha_cache[cache_key] = (now, sha)
            return sha
    except (httpx.HTTPError, ValueError, KeyError) as e:
        logger.warning(f"resolve_prompts_sha failed via GitHub API: {e}")

    # Fallback: hash the locally-fetched prompt files. Better than recording
    # nothing — at least the bytes pinned for this session are traceable.
    import hashlib
    h = hashlib.sha256()
    try:
        for key in ("fast_eval", "deep_eval", "recorder"):
            url = PROMPT_BASE_URL + PROMPT_FILES[key]
            text = await _fetch_prompt(url)
            h.update(text.encode("utf-8", errors="replace"))
        digest = "local:" + h.hexdigest()[:16]
    except httpx.HTTPError as e:
        logger.warning(f"resolve_prompts_sha fallback hash failed: {e}")
        digest = "unknown"
    _prompts_sha_cache[cache_key] = (now, digest)
    return digest


PROJECT_DESCRIPTION_BASE_URL = (
    "https://raw.githubusercontent.com/csc-arc/research-projects/main/projects"
)


def project_md_url(project_id: str) -> str:
    return f"{PROJECT_DESCRIPTION_BASE_URL}/{project_id}/project.md"


def resources_md_url(project_id: str) -> str:
    return f"{PROJECT_DESCRIPTION_BASE_URL}/{project_id}/resources.md"


def combine_project_artifacts(project_md_text: str, resources_md_text: str) -> str:
    """Combine the project.md text and the (optional) resources.md text into
    the single ``project_description`` string that flows into coach prompts
    and evaluator inputs.

    The resources.md content, when present, is appended under a ``# Resources``
    heading so the coach has the full reading list as part of its working
    context for the project. Both files keep their full contents (including
    the YAML frontmatter on project.md) so the coach can read title, pi, and
    goals directly without a side-channel.
    """
    parts = [project_md_text.rstrip()]
    resources = resources_md_text.strip()
    if resources:
        parts.append("")
        parts.append("---")
        parts.append("")
        parts.append("# Resources")
        parts.append("")
        parts.append(resources)
        parts.append("")
    return "\n".join(parts)


async def _fetch_project_description(project_id: str) -> str:
    """Fetch and cache the project description (project.md plus optional resources.md)."""
    try:
        project_md = await _fetch_text_with_cache(
            _project_description_cache, project_md_url(project_id)
        )
    except httpx.HTTPError:
        return ""
    try:
        resources_md = await _fetch_text_with_cache(
            _project_description_cache, resources_md_url(project_id)
        )
    except httpx.HTTPError:
        # resources.md is optional; a 404 (or any fetch error) is fine — fall
        # back to project.md alone. The cache miss means the next call will
        # retry, which is acceptable at session-start scale.
        resources_md = ""
    return combine_project_artifacts(project_md, resources_md)


# ---------------------------------------------------------------------------
# IO helpers
# ---------------------------------------------------------------------------


def _session_dir(student_id: str, project_id: str) -> Path:
    return server_module._session_dir(student_id, project_id)


def _read_active_session(session_dir: Path) -> dict:
    """Return the parsed active-session.json or an empty dict."""
    path = session_dir / "active-session.json"
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text())
    except (json.JSONDecodeError, OSError):
        return {}


def _prompts_sha_for_session(session_dir: Path) -> Optional[str]:
    """Return the prompts_sha pinned for this session, or None for legacy
    sessions started before Phase A1 landed."""
    return _read_active_session(session_dir).get("prompts_sha") or None


def _read_log(
    session_dir: Path,
    since_index: Optional[int] = None,
    tail: Optional[int] = None,
) -> list[dict]:
    """Read chat-log.jsonl. If since_index given, return entries after that
    index. If tail given, return only the last N entries."""
    log_path = session_dir / "chat-log.jsonl"
    if not log_path.exists():
        return []
    out: list[dict] = []
    try:
        with open(log_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    out.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
    except OSError:
        return []
    if since_index is not None:
        out = out[since_index:]
    if tail is not None:
        out = out[-tail:]
    return out


def _atomic_write_text(path: Path, content: str) -> None:
    """Write content to a sibling tmp file then atomically rename."""
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(content, encoding="utf-8")
    tmp.replace(path)


def _load_eval_state(session_dir: Path) -> dict[str, Any]:
    path = session_dir / "eval-state.json"
    if not path.exists():
        return {
            "last_evaluated_turn_index": 0,
            "last_full_rewrite_turn": 0,
            "coach_issue_run_counts": {},
        }
    try:
        data = json.loads(path.read_text())
        data.setdefault("last_evaluated_turn_index", 0)
        data.setdefault("last_full_rewrite_turn", 0)
        data.setdefault("coach_issue_run_counts", {})
        return data
    except (json.JSONDecodeError, OSError):
        return {
            "last_evaluated_turn_index": 0,
            "last_full_rewrite_turn": 0,
            "coach_issue_run_counts": {},
        }


def _save_eval_state(session_dir: Path, state: dict[str, Any]) -> None:
    path = session_dir / "eval-state.json"
    _atomic_write_text(path, json.dumps(state, indent=2))


def extract_coach_style_notes(cumulative_report: str) -> str:
    """Extract the body of the `## Coach style notes` section from a
    cumulative report. Returns empty string if absent.
    """
    if not cumulative_report:
        return ""
    lines = cumulative_report.splitlines()
    out: list[str] = []
    in_section = False
    for line in lines:
        stripped = line.strip()
        if not in_section:
            if stripped == COACH_STYLE_NOTES_HEADING:
                in_section = True
            continue
        # In section. Stop at the next heading at the same level (## or above).
        if re.match(r"^#{1,2}\s", stripped):
            break
        out.append(line)
    return "\n".join(out).strip()


# ---------------------------------------------------------------------------
# OpenRouter call wrapper
# ---------------------------------------------------------------------------


async def _openrouter_call(
    *,
    model: str,
    system_prompt: str,
    user_message: str,
    tools: Optional[list[dict]] = None,
    tool_choice: Optional[dict] = None,
    timeout_seconds: float,
    kind: str,
    student_id: str,
    project_id: str,
) -> Optional[dict]:
    """Call OpenRouter chat completions and return the assistant message dict.

    Returns the JSON-parsed assistant message (with tool_calls if any).
    Returns None on any failure (timeout, non-200, parse error). Logs elapsed
    time and token usage with the `kind` tag for cost visibility.
    """
    msg, _usage = await _openrouter_call_with_usage(
        model=model,
        system_prompt=system_prompt,
        user_message=user_message,
        tools=tools,
        tool_choice=tool_choice,
        timeout_seconds=timeout_seconds,
        kind=kind,
        student_id=student_id,
        project_id=project_id,
    )
    return msg


async def _openrouter_call_with_usage(
    *,
    model: str,
    system_prompt: str,
    user_message: str,
    tools: Optional[list[dict]] = None,
    tool_choice: Optional[dict] = None,
    timeout_seconds: float,
    kind: str,
    student_id: str,
    project_id: str,
) -> tuple[Optional[dict], dict]:
    """Like `_openrouter_call`, but also returns the OpenRouter `usage` block.

    Returns `(message, usage_dict)`. On failure, returns `(None, {})`. The
    usage dict carries OpenRouter's `prompt_tokens` / `completion_tokens` /
    other token counters when available.
    """
    api_key = server_module.OPENROUTER_API_KEY
    if not api_key:
        logger.warning(f"OPENROUTER_API_KEY not configured; {kind} skipped")
        return None, {}

    payload: dict[str, Any] = {
        "model": model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_message},
        ],
        "stream": False,
    }
    if tools:
        payload["tools"] = tools
    if tool_choice:
        payload["tool_choice"] = tool_choice

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "HTTP-Referer": "https://airesearchcoach.org",
        "X-Title": "AI Research Coach",
    }

    start = time.monotonic()
    try:
        async with httpx.AsyncClient(timeout=timeout_seconds + 5) as client:
            resp = await asyncio.wait_for(
                client.post(
                    "https://openrouter.ai/api/v1/chat/completions",
                    json=payload,
                    headers=headers,
                ),
                timeout=timeout_seconds,
            )
    except asyncio.TimeoutError:
        elapsed = time.monotonic() - start
        logger.warning(
            f"openrouter_timeout kind={kind} student={student_id} project={project_id} "
            f"model={model} elapsed_seconds={elapsed:.3f}"
        )
        return None, {}
    except httpx.HTTPError as e:
        elapsed = time.monotonic() - start
        logger.warning(
            f"openrouter_http_error kind={kind} student={student_id} project={project_id} "
            f"model={model} elapsed_seconds={elapsed:.3f} error={e}"
        )
        return None, {}

    elapsed = time.monotonic() - start
    if resp.status_code != 200:
        logger.warning(
            f"openrouter_non_200 kind={kind} student={student_id} project={project_id} "
            f"model={model} elapsed_seconds={elapsed:.3f} status={resp.status_code}"
        )
        return None, {}

    try:
        body = resp.json()
    except ValueError:
        logger.warning(
            f"openrouter_parse_failed kind={kind} student={student_id} project={project_id}"
        )
        return None, {}

    usage = body.get("usage") or {}
    pt = usage.get("prompt_tokens")
    ct = usage.get("completion_tokens")
    logger.info(
        f"eval_call kind={kind} student={student_id} project={project_id} model={model} "
        f"elapsed_seconds={elapsed:.3f} prompt_tokens={pt} completion_tokens={ct}"
    )

    choices = body.get("choices") or []
    if not choices:
        return None, usage if isinstance(usage, dict) else {}
    msg = choices[0].get("message") or {}
    return msg, usage if isinstance(usage, dict) else {}


def _extract_tool_args(message: dict, tool_name: str) -> Optional[dict]:
    """From an assistant message, return the parsed arguments of the named
    tool call (the first one if multiple)."""
    if not message:
        return None
    tool_calls = message.get("tool_calls") or []
    for tc in tool_calls:
        fn = tc.get("function") or {}
        if fn.get("name") == tool_name:
            try:
                return json.loads(fn.get("arguments") or "{}")
            except json.JSONDecodeError:
                return None
    return None


# ---------------------------------------------------------------------------
# Tool schemas
# ---------------------------------------------------------------------------

_COACH_ISSUE_OBJECT_SCHEMA = {
    "type": "object",
    "properties": {
        "category": {
            "type": "string",
            "enum": sorted(COACH_ISSUE_CATEGORIES),
        },
        "observation": {"type": "string"},
        "suggested_correction": {"type": "string"},
    },
    "required": ["category", "observation", "suggested_correction"],
    "additionalProperties": False,
}

_STUDENT_RED_FLAG_OBJECT_SCHEMA = {
    "type": "object",
    "properties": {
        "category": {
            "type": "string",
            "enum": sorted(STUDENT_RED_FLAG_CATEGORIES),
        },
        "observation": {"type": "string"},
        "suggested_response": {"type": "string"},
    },
    "required": ["category", "observation", "suggested_response"],
    "additionalProperties": False,
}

FAST_EVAL_TOOL_SCHEMA = {
    "type": "function",
    "function": {
        "name": "submit_fast_evaluation",
        "description": (
            "Submit the per-turn tactical evaluation. Be brief; emit only what is "
            "actionable for the immediate next coach response."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "coach_issues": {
                    "type": "array",
                    "items": _COACH_ISSUE_OBJECT_SCHEMA,
                },
                "student_red_flags": {
                    "type": "array",
                    "items": _STUDENT_RED_FLAG_OBJECT_SCHEMA,
                },
                "open_threads": {
                    "type": "array",
                    "items": {"type": "string"},
                },
                "mode_effectiveness": {
                    "type": "string",
                    "enum": ["working", "mixed", "not_working"],
                },
                "suggested_next_move": {"type": "string"},
            },
            "required": [
                "coach_issues",
                "student_red_flags",
                "open_threads",
                "mode_effectiveness",
                "suggested_next_move",
            ],
            "additionalProperties": False,
        },
    },
}

DEEP_EVAL_TOOL_SCHEMA = {
    "type": "function",
    "function": {
        "name": "submit_evaluation",
        "description": (
            "Submit the running session-long evaluation. Update or rebuild every field."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "objective_progress": {"type": "object"},
                "open_threads": {"type": "array", "items": {"type": "string"}},
                "mastery_log": {"type": "object"},
                "idk_patterns": {"type": "array", "items": {"type": "string"}},
                "engagement": {
                    "type": "string",
                    "enum": sorted(ENGAGEMENT_VALUES),
                },
                "mode_effectiveness": {"type": "object"},
                "coach_issues": {
                    "type": "array",
                    "items": _COACH_ISSUE_OBJECT_SCHEMA,
                },
                "student_red_flags": {
                    "type": "array",
                    "items": _STUDENT_RED_FLAG_OBJECT_SCHEMA,
                },
                "personalization_signals": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "category": {
                                "type": "string",
                                "enum": [
                                    "preferred_register",
                                    "preferred_explanation_style",
                                    "response_to_challenge",
                                    "response_to_scaffolding",
                                    "math_vs_prose_preference",
                                    "background_gap",
                                ],
                            },
                            "evidence": {"type": "string"},
                        },
                        "required": ["category", "evidence"],
                        "additionalProperties": False,
                    },
                },
                "suggested_action": {"type": "string"},
                "summary": {"type": "string"},
            },
            "required": [
                "objective_progress",
                "open_threads",
                "mastery_log",
                "idk_patterns",
                "engagement",
                "mode_effectiveness",
                "coach_issues",
                "student_red_flags",
                "personalization_signals",
                "suggested_action",
                "summary",
            ],
            "additionalProperties": False,
        },
    },
}

RECORDER_TOOL_SCHEMA = {
    "type": "function",
    "function": {
        "name": "submit_artifacts",
        "description": (
            "Submit the three session-end artifacts: per-session summary, metadata, "
            "and the full replacement body of the cumulative report."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "summary_md": {"type": "string"},
                "metadata_json": {"type": "object"},
                "cumulative_report_md": {"type": "string"},
            },
            "required": ["summary_md", "metadata_json", "cumulative_report_md"],
            "additionalProperties": False,
        },
    },
}


# ---------------------------------------------------------------------------
# Fast evaluator
# ---------------------------------------------------------------------------


async def run_fast_evaluator(student_id: str, project_id: str) -> None:
    """Tail-only evaluator that produces a tight tactical signal for the
    coach's immediate next response. Atomically overwrites
    `current-fast-eval.md`.
    """
    session_dir = _session_dir(student_id, project_id)
    if not (session_dir / "active-session.json").exists():
        return

    recent = _read_log(session_dir, tail=4)
    if not recent:
        return

    prompts_sha = _prompts_sha_for_session(session_dir)
    try:
        prompt = await fetch_prompt_for_session("fast_eval", prompts_sha)
    except httpx.HTTPError as e:
        logger.warning(f"fast_eval prompt fetch failed: {e}")
        return

    project_description = await _fetch_project_description(project_id)

    user_message = _render_fast_eval_user_message(recent, project_description)

    msg = await _openrouter_call(
        model=EVAL_MODEL,
        system_prompt=prompt,
        user_message=user_message,
        tools=[FAST_EVAL_TOOL_SCHEMA],
        tool_choice={"type": "function", "function": {"name": "submit_fast_evaluation"}},
        timeout_seconds=FAST_EVAL_LLM_TIMEOUT_SECONDS,
        kind="fast_eval",
        student_id=student_id,
        project_id=project_id,
    )
    if msg is None:
        return

    args = _extract_tool_args(msg, "submit_fast_evaluation")
    if args is None:
        return

    out = _render_fast_eval_markdown(args)
    fast_path = session_dir / "current-fast-eval.md"
    try:
        _atomic_write_text(fast_path, out)
    except OSError as e:
        logger.warning(f"fast_eval write failed: {e}")

    # Phase A2: append the structured fast-eval payload to a per-session
    # JSONL log so the QA viewer can show inline fast-eval context next to
    # each coach turn. Not load-bearing for replay (replay re-computes), so
    # write failures here are non-fatal.
    try:
        latest_user_turn = next(
            (t for t in reversed(recent) if t.get("role") == "user"), None
        )
        # Turn index = number of user messages logged so far (1-indexed).
        all_turns = _read_log(session_dir)
        user_turn_count = sum(1 for t in all_turns if t.get("role") == "user")
        preview = ""
        ts = ""
        if isinstance(latest_user_turn, dict):
            content = latest_user_turn.get("content")
            if isinstance(content, str):
                preview = content[:80]
            ts = latest_user_turn.get("timestamp", "")
        entry = {
            "turn": user_turn_count,
            "ts": ts,
            "user_message_preview": preview,
            "fast_eval": args,
        }
        turns_path = session_dir / "fast-eval-turns.jsonl"
        with open(turns_path, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except OSError as e:
        logger.warning(f"fast-eval-turns append failed: {e}")


def _render_fast_eval_user_message(recent_turns: list[dict], project_description: str) -> str:
    parts: list[str] = []
    parts.append("## Project description\n")
    parts.append(project_description.strip() or "(unavailable)")
    parts.append("\n## Most recent turns (oldest first)\n")
    for turn in recent_turns:
        role = turn.get("role", "?")
        content = turn.get("content", "")
        parts.append(f"### {role}\n{content}\n")
    parts.append(
        "\nProduce exactly one call to `submit_fast_evaluation`. Be brief; "
        "the coach completion is waiting on you."
    )
    return "\n".join(parts)


def _render_fast_eval_markdown(args: dict) -> str:
    lines: list[str] = ["<!-- arc-fast-eval v1 -->", ""]
    lines.append(f"**Mode effectiveness:** {args.get('mode_effectiveness', '?')}")
    lines.append("")
    lines.append(f"**Suggested next move:** {args.get('suggested_next_move', '').strip()}")
    lines.append("")

    open_threads = args.get("open_threads") or []
    lines.append("### Open threads")
    if open_threads:
        for t in open_threads:
            lines.append(f"- {t}")
    else:
        lines.append("(none)")
    lines.append("")

    coach_issues = args.get("coach_issues") or []
    lines.append("### Coach issues")
    if coach_issues:
        for issue in coach_issues:
            cat = issue.get("category", "?")
            obs = issue.get("observation", "").strip()
            corr = issue.get("suggested_correction", "").strip()
            lines.append(f"- **{cat}** — {obs}")
            if corr:
                lines.append(f"  - _Correction:_ {corr}")
    else:
        lines.append("(none)")
    lines.append("")

    red_flags = args.get("student_red_flags") or []
    lines.append("### Student red flags")
    if red_flags:
        for flag in red_flags:
            cat = flag.get("category", "?")
            obs = (flag.get("observation") or "").strip()
            resp = (flag.get("suggested_response") or "").strip()
            lines.append(f"- **{cat}** — {obs}")
            if resp:
                lines.append(f"  - _Response:_ {resp}")
    else:
        lines.append("(none)")
    lines.append("")

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Deep evaluator
# ---------------------------------------------------------------------------


async def run_deep_evaluator(
    student_id: str,
    project_id: str,
    full_rewrite: bool = False,
    already_locked: bool = False,
) -> None:
    """Update or rebuild `current-deep-eval.md` from the transcript.

    Holds the per-session lock around file writes (skipped when
    `already_locked=True`, used by the recorder's forced-rewrite path).
    """
    session_dir = _session_dir(student_id, project_id)
    if not (session_dir / "active-session.json").exists():
        return

    state = _load_eval_state(session_dir)
    last_index = int(state.get("last_evaluated_turn_index") or 0)

    if full_rewrite:
        turns = _read_log(session_dir)
        if not turns:
            return
        eval_mode = "full"
        prior_eval = ""
    else:
        turns_all = _read_log(session_dir)
        if last_index >= len(turns_all):
            return
        turns = turns_all[last_index:] if last_index > 0 else turns_all
        eval_mode = "incremental" if last_index > 0 else "full"
        prior_eval = ""
        if eval_mode == "incremental":
            try:
                p = session_dir / "current-deep-eval.md"
                if p.exists():
                    prior_eval = p.read_text(encoding="utf-8")
            except OSError:
                prior_eval = ""

    prompts_sha = _prompts_sha_for_session(session_dir)
    try:
        prompt = await fetch_prompt_for_session("deep_eval", prompts_sha)
    except httpx.HTTPError as e:
        logger.warning(f"deep_eval prompt fetch failed: {e}")
        return

    project_description = await _fetch_project_description(project_id)
    cumulative_report = ""
    cumulative_path = session_dir / "cumulative-report.md"
    if eval_mode == "full" and cumulative_path.exists():
        try:
            cumulative_report = cumulative_path.read_text(encoding="utf-8")
        except OSError:
            cumulative_report = ""

    rendered_prompt = prompt.replace("${eval_mode}", eval_mode)

    user_message = _render_deep_eval_user_message(
        eval_mode=eval_mode,
        turns=turns,
        prior_eval=prior_eval,
        cumulative_report=cumulative_report,
        project_description=project_description,
    )

    msg = await _openrouter_call(
        model=EVAL_MODEL,
        system_prompt=rendered_prompt,
        user_message=user_message,
        tools=[DEEP_EVAL_TOOL_SCHEMA],
        tool_choice={"type": "function", "function": {"name": "submit_evaluation"}},
        timeout_seconds=DEEP_EVALUATOR_TIMEOUT_SECONDS,
        kind="deep_eval",
        student_id=student_id,
        project_id=project_id,
    )
    if msg is None:
        return

    args = _extract_tool_args(msg, "submit_evaluation")
    if args is None:
        return

    rendered_md = _render_deep_eval_markdown(args)
    total_turns = len(_read_log(session_dir))

    if already_locked:
        await _commit_deep_eval(session_dir, rendered_md, args, state, total_turns, full_rewrite)
    else:
        async with server_module._get_session_lock(student_id, project_id):
            await _commit_deep_eval(
                session_dir, rendered_md, args, state, total_turns, full_rewrite
            )


async def _commit_deep_eval(
    session_dir: Path,
    rendered_md: str,
    args: dict,
    state: dict,
    total_turns: int,
    full_rewrite: bool,
) -> None:
    eval_path = session_dir / "current-deep-eval.md"
    try:
        _atomic_write_text(eval_path, rendered_md)
    except OSError as e:
        logger.warning(f"deep_eval write failed: {e}")
        return

    state["last_evaluated_turn_index"] = total_turns
    if full_rewrite:
        state["last_full_rewrite_turn"] = total_turns

    counts = state.setdefault("coach_issue_run_counts", {})
    seen_categories: set[str] = set()
    for issue in args.get("coach_issues") or []:
        cat = issue.get("category")
        if isinstance(cat, str) and cat in COACH_ISSUE_CATEGORIES:
            seen_categories.add(cat)
    for cat in seen_categories:
        counts[cat] = int(counts.get(cat, 0)) + 1

    try:
        _save_eval_state(session_dir, state)
    except OSError as e:
        logger.warning(f"eval-state write failed: {e}")


def _render_deep_eval_user_message(
    *,
    eval_mode: str,
    turns: list[dict],
    prior_eval: str,
    cumulative_report: str,
    project_description: str,
) -> str:
    parts: list[str] = []
    parts.append(f"## Eval mode\n{eval_mode}\n")
    parts.append("## Project description\n")
    parts.append(project_description.strip() or "(unavailable)")
    if eval_mode == "incremental" and prior_eval:
        parts.append("\n## Prior evaluation (current-deep-eval.md)\n")
        parts.append(prior_eval)
    if eval_mode == "full" and cumulative_report:
        parts.append("\n## Prior cumulative report (for cross-session context)\n")
        parts.append(cumulative_report)
    label = (
        "## New conversation turns since last evaluation"
        if eval_mode == "incremental"
        else "## Full transcript"
    )
    parts.append(f"\n{label}\n")
    for i, turn in enumerate(turns):
        role = turn.get("role", "?")
        content = turn.get("content", "")
        parts.append(f"### turn {i+1} — {role}\n{content}\n")
    parts.append(
        "\nProduce exactly one call to `submit_evaluation` with all fields filled."
    )
    return "\n".join(parts)


def _render_deep_eval_markdown(args: dict) -> str:
    lines: list[str] = ["<!-- arc-deep-eval v1 -->", ""]

    summary = (args.get("summary") or "").strip()
    lines.append("## Summary")
    lines.append(summary or "(none)")
    lines.append("")

    engagement = args.get("engagement") or "(unknown)"
    lines.append(f"**Engagement:** {engagement}")
    lines.append("")

    suggested_action = (args.get("suggested_action") or "").strip()
    lines.append(f"**Suggested action:** {suggested_action}")
    lines.append("")

    lines.append("### Objective progress")
    op = args.get("objective_progress") or {}
    if op:
        for k, v in op.items():
            lines.append(f"- **{k}**: {v}")
    else:
        lines.append("(none)")
    lines.append("")

    lines.append("### Open threads")
    ot = args.get("open_threads") or []
    if ot:
        for t in ot:
            lines.append(f"- {t}")
    else:
        lines.append("(none)")
    lines.append("")

    lines.append("### Mastery log")
    ml = args.get("mastery_log") or {}
    if ml:
        for k, v in ml.items():
            lines.append(f"- **{k}**: {v}")
    else:
        lines.append("(none)")
    lines.append("")

    lines.append("### IDK patterns")
    idk = args.get("idk_patterns") or []
    if idk:
        for t in idk:
            lines.append(f"- {t}")
    else:
        lines.append("(none)")
    lines.append("")

    lines.append("### Mode effectiveness")
    me = args.get("mode_effectiveness") or {}
    if me:
        for k, v in me.items():
            lines.append(f"- **{k}**: {v}")
    else:
        lines.append("(none)")
    lines.append("")

    lines.append("### Coach issues")
    ci = args.get("coach_issues") or []
    if ci:
        for issue in ci:
            cat = issue.get("category", "?")
            obs = (issue.get("observation") or "").strip()
            corr = (issue.get("suggested_correction") or "").strip()
            lines.append(f"- **{cat}** — {obs}")
            if corr:
                lines.append(f"  - _Correction:_ {corr}")
    else:
        lines.append("(none)")
    lines.append("")

    lines.append("### Student red flags")
    rf = args.get("student_red_flags") or []
    if rf:
        for flag in rf:
            cat = flag.get("category", "?")
            obs = (flag.get("observation") or "").strip()
            resp = (flag.get("suggested_response") or "").strip()
            lines.append(f"- **{cat}** — {obs}")
            if resp:
                lines.append(f"  - _Response:_ {resp}")
    else:
        lines.append("(none)")
    lines.append("")

    lines.append("### Personalization signals")
    ps = args.get("personalization_signals") or []
    if ps:
        for sig in ps:
            cat = sig.get("category", "?")
            ev = (sig.get("evidence") or "").strip()
            lines.append(f"- **{cat}** — {ev}")
    else:
        lines.append("(none)")
    lines.append("")

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Recorder
# ---------------------------------------------------------------------------


async def run_recorder(
    *,
    student_id: str,
    project_id: str,
    pi: str,
    session_start: str,
    session_end: str,
    abrupt: bool,
) -> dict:
    """Produce the per-session archive and the cross-session cumulative report,
    then sync both to coach-sessions.

    Returns a dict with `status` and optional `commit_sha` / `error`.
    """
    session_dir = _session_dir(student_id, project_id)
    sessions_dir = session_dir / "sessions"
    sessions_dir.mkdir(parents=True, exist_ok=True)

    # Idempotency
    final_dir = sessions_dir / session_start
    if final_dir.exists():
        return {"status": "already_recorded"}

    # Recorder restart hygiene: remove any stray .tmp from a prior crash.
    tmp_dir = sessions_dir / f"{session_start}.tmp"
    if tmp_dir.exists():
        try:
            shutil.rmtree(tmp_dir)
        except OSError:
            pass

    # Step 1: forced full deep-eval rewrite (recorder already holds the lock).
    try:
        await run_deep_evaluator(
            student_id, project_id, full_rewrite=True, already_locked=True
        )
    except Exception as e:
        logger.warning(f"forced full deep-eval failed: {e}; proceeding")

    # Read inputs.
    chat_log_path = session_dir / "chat-log.jsonl"
    deep_eval_path = session_dir / "current-deep-eval.md"
    fast_eval_path = session_dir / "current-fast-eval.md"
    fast_eval_turns_path = session_dir / "fast-eval-turns.jsonl"
    eval_state_path = session_dir / "eval-state.json"
    active_path = session_dir / "active-session.json"
    cumulative_path = session_dir / "cumulative-report.md"

    transcript_text = ""
    if chat_log_path.exists():
        try:
            transcript_text = chat_log_path.read_text(encoding="utf-8")
        except OSError:
            transcript_text = ""
    deep_eval_text = ""
    if deep_eval_path.exists():
        try:
            deep_eval_text = deep_eval_path.read_text(encoding="utf-8")
        except OSError:
            deep_eval_text = ""
    cumulative_text = ""
    if cumulative_path.exists():
        try:
            cumulative_text = cumulative_path.read_text(encoding="utf-8")
        except OSError:
            cumulative_text = ""

    project_description = await _fetch_project_description(project_id)

    eval_state = _load_eval_state(session_dir)
    counts = eval_state.get("coach_issue_run_counts") or {}
    threshold_categories = sorted(
        cat
        for cat, n in counts.items()
        if isinstance(n, int) and n >= COACH_ISSUE_RECURRENCE_THRESHOLD
    )

    project_description_sha = ""
    active_session_data: dict = {}
    if active_path.exists():
        try:
            active_session_data = json.loads(active_path.read_text())
            project_description_sha = active_session_data.get(
                "project_description_sha", ""
            )
        except (json.JSONDecodeError, OSError):
            active_session_data = {}

    # Compute deterministic numbers the LLM may not get right.
    message_count_actual = _count_jsonl_lines(chat_log_path)
    duration_seconds_actual = _safe_duration_seconds(session_start, session_end)

    prompts_sha = active_session_data.get("prompts_sha") or None
    try:
        prompt = await fetch_prompt_for_session("recorder", prompts_sha)
    except httpx.HTTPError as e:
        logger.warning(f"recorder prompt fetch failed: {e}")
        return await _failure_archive(
            session_dir=session_dir,
            sessions_dir=sessions_dir,
            session_start=session_start,
            session_end=session_end,
            student_id=student_id,
            project_id=project_id,
            pi=pi,
            abrupt=abrupt,
            project_description_sha=project_description_sha,
            message_count=message_count_actual,
            duration_seconds=duration_seconds_actual,
            failure_reason=f"recorder prompt fetch failed: {e}",
        )

    user_message = _render_recorder_user_message(
        student_id=student_id,
        project_id=project_id,
        pi=pi,
        session_start=session_start,
        session_end=session_end,
        abrupt=abrupt,
        project_description=project_description,
        transcript_text=transcript_text,
        deep_eval_text=deep_eval_text,
        cumulative_text=cumulative_text,
        threshold_categories=threshold_categories,
        message_count=message_count_actual,
        duration_seconds=duration_seconds_actual,
        project_description_sha=project_description_sha,
    )

    args = await _call_recorder_llm(
        prompt, user_message, student_id=student_id, project_id=project_id
    )
    validation_error = _validate_recorder_args(
        args=args,
        session_start=session_start,
        session_end=session_end,
        student_id=student_id,
        project_id=project_id,
        pi=pi,
        project_description_sha=project_description_sha,
    )
    if validation_error is not None and args is not None:
        # Re-prompt once with stricter instruction naming the failed field.
        args = await _call_recorder_llm(
            prompt,
            user_message
            + f"\n\nThe previous response failed validation: {validation_error}. "
            "Re-emit `submit_artifacts` with the field corrected.",
            student_id=student_id,
            project_id=project_id,
        )
        validation_error = _validate_recorder_args(
            args=args,
            session_start=session_start,
            session_end=session_end,
            student_id=student_id,
            project_id=project_id,
            pi=pi,
            project_description_sha=project_description_sha,
        )

    if args is None or validation_error is not None:
        return await _failure_archive(
            session_dir=session_dir,
            sessions_dir=sessions_dir,
            session_start=session_start,
            session_end=session_end,
            student_id=student_id,
            project_id=project_id,
            pi=pi,
            abrupt=abrupt,
            project_description_sha=project_description_sha,
            message_count=message_count_actual,
            duration_seconds=duration_seconds_actual,
            failure_reason=validation_error or "LLM call failed",
        )

    # Correct deterministic fields server-side.
    metadata = dict(args.get("metadata_json") or {})
    metadata["message_count"] = message_count_actual
    metadata["duration_seconds"] = duration_seconds_actual
    metadata["status"] = "recorded"
    # Attach the prompt-version and model fields recorded at session start
    # (Phase A1). These let the QA replay endpoint resolve "original mode"
    # against the exact prompt content the coach actually used.
    if prompts_sha:
        metadata["prompts_sha"] = prompts_sha
        metadata["prompts"] = {
            "coach": "coach-instructions.md",
            "fast_eval": PROMPT_FILES["fast_eval"],
            "deep_eval": PROMPT_FILES["deep_eval"],
            "recorder": PROMPT_FILES["recorder"],
        }
    models_block = active_session_data.get("models")
    if isinstance(models_block, dict) and models_block:
        metadata["models"] = models_block
    summary_md = (args.get("summary_md") or "").rstrip() + "\n"
    cumulative_report_md = (args.get("cumulative_report_md") or "").rstrip() + "\n"

    # Step 3: write archive atomically.
    try:
        tmp_dir.mkdir(parents=True, exist_ok=True)
        (tmp_dir / "summary.md").write_text(summary_md, encoding="utf-8")
        (tmp_dir / "metadata.json").write_text(
            json.dumps(metadata, indent=2) + "\n", encoding="utf-8"
        )
        if chat_log_path.exists():
            shutil.copy2(chat_log_path, tmp_dir / "transcript.jsonl")
        else:
            (tmp_dir / "transcript.jsonl").write_text("", encoding="utf-8")
        if deep_eval_path.exists():
            shutil.copy2(deep_eval_path, tmp_dir / "evaluation.md")
        else:
            (tmp_dir / "evaluation.md").write_text("(no evaluation produced)\n", encoding="utf-8")
        # Phase A2: include the per-turn fast-eval JSONL when present.
        if fast_eval_turns_path.exists():
            shutil.copy2(fast_eval_turns_path, tmp_dir / "fast-eval-turns.jsonl")

        cumulative_tmp = session_dir / "cumulative-report.md.tmp"
        cumulative_tmp.write_text(cumulative_report_md, encoding="utf-8")

        # Atomic rename of session dir, then cumulative report.
        os.rename(tmp_dir, final_dir)
        os.replace(cumulative_tmp, cumulative_path)

        # Delete originals (post-commit).
        for p in (
            chat_log_path,
            deep_eval_path,
            fast_eval_path,
            fast_eval_turns_path,
            eval_state_path,
            active_path,
        ):
            try:
                p.unlink(missing_ok=True)
            except OSError:
                pass
    except OSError as e:
        logger.error(f"recorder archive write failed: {e}")
        return {"status": "recorder_failed", "error": str(e)}

    # Step 4: mirror to coach-sessions and push.
    push_result = await _sync_to_coach_sessions(
        session_dir=session_dir,
        student_id=student_id,
        project_id=project_id,
        pi=pi,
        session_start=session_start,
    )

    if push_result.get("status") == "queued_retry":
        return {"status": "queued_retry", "error": push_result.get("error")}
    return {"status": "recorded", "commit_sha": push_result.get("commit_sha")}


def _count_jsonl_lines(path: Path) -> int:
    if not path.exists():
        return 0
    n = 0
    try:
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                if line.strip():
                    n += 1
    except OSError:
        return 0
    return n


def _safe_duration_seconds(start_iso: str, end_iso: str) -> int:
    try:
        s = datetime.fromisoformat(start_iso)
        e = datetime.fromisoformat(end_iso)
        return max(int((e - s).total_seconds()), 0)
    except (ValueError, TypeError):
        return 0


async def _call_recorder_llm(
    prompt: str,
    user_message: str,
    *,
    student_id: str,
    project_id: str,
) -> Optional[dict]:
    msg = await _openrouter_call(
        model=RECORDER_MODEL,
        system_prompt=prompt,
        user_message=user_message,
        tools=[RECORDER_TOOL_SCHEMA],
        tool_choice={"type": "function", "function": {"name": "submit_artifacts"}},
        timeout_seconds=RECORDER_TIMEOUT_SECONDS,
        kind="recorder",
        student_id=student_id,
        project_id=project_id,
    )
    if msg is None:
        return None
    return _extract_tool_args(msg, "submit_artifacts")


def _validate_recorder_args(
    *,
    args: Optional[dict],
    session_start: str,
    session_end: str,
    student_id: str,
    project_id: str,
    pi: str,
    project_description_sha: str,
) -> Optional[str]:
    if args is None:
        return "no tool call"
    md = args.get("metadata_json")
    if not isinstance(md, dict):
        return "metadata_json missing or not an object"

    if md.get("session_start") != session_start:
        return "metadata_json.session_start must equal the directory name"
    try:
        s = datetime.fromisoformat(session_start)
        e = datetime.fromisoformat(md.get("session_end", ""))
        if e < s:
            return "metadata_json.session_end must be >= session_start"
    except (ValueError, TypeError):
        return "metadata_json.session_end must be ISO-8601"

    if md.get("student_id") != student_id:
        return "metadata_json.student_id mismatch"
    if md.get("project_id") != project_id:
        return "metadata_json.project_id mismatch"
    if not md.get("pi"):
        return "metadata_json.pi must be a non-empty string"

    expected_transcript = f"sessions/{session_start}/transcript.jsonl"
    expected_evaluation = f"sessions/{session_start}/evaluation.md"
    if md.get("transcript_path") != expected_transcript:
        return f"metadata_json.transcript_path must be exactly {expected_transcript}"
    if md.get("evaluation_path") != expected_evaluation:
        return f"metadata_json.evaluation_path must be exactly {expected_evaluation}"

    if project_description_sha and md.get("project_description_sha") != project_description_sha:
        # Recorder may correct this; warn but don't fail.
        md["project_description_sha"] = project_description_sha

    cats = md.get("coach_issue_categories") or []
    for c in cats:
        if c not in COACH_ISSUE_CATEGORIES:
            return f"metadata_json.coach_issue_categories contains unknown category: {c}"

    if md.get("engagement") not in ENGAGEMENT_VALUES:
        return "metadata_json.engagement must be one of high|medium|low|frustrated"

    summary_md = args.get("summary_md") or ""
    if "# Session Summary:" not in summary_md:
        return "summary_md must contain a `# Session Summary:` heading"

    cumulative_report_md = args.get("cumulative_report_md") or ""
    if COACH_STYLE_NOTES_HEADING not in cumulative_report_md:
        return f"cumulative_report_md must contain a {COACH_STYLE_NOTES_HEADING!r} heading"

    return None


def _strip_paste_meta(transcript_text: str) -> str:
    """Remove paste-detection fields from every JSONL row.

    Called once on `transcript_text` before it is pasted into the
    recorder LLM prompt, so paste metadata never reaches the model.
    Preserves the v1 "no LLM behavior change" invariant of
    `notes/dev-0526/plans/paste-detection-plan.md`.

    The archived `transcript.jsonl` (copied to coach-sessions) is **not**
    redacted — only the live LLM prompt is. Analysts working off the
    archive still see the full signal.

    Lines that aren't valid JSON pass through unchanged so a partially
    corrupt transcript doesn't get silently rewritten. Fast-eval and
    deep-eval read structured `role`/`content` only, so this helper is
    not needed there.
    """
    out_lines: list[str] = []
    for line in transcript_text.splitlines():
        if not line.strip():
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            out_lines.append(line)
            continue
        if isinstance(obj, dict):
            for key in server_module.PASTE_META_FIELDS:
                obj.pop(key, None)
        out_lines.append(json.dumps(obj, ensure_ascii=False))
    return "\n".join(out_lines)


def _render_recorder_user_message(
    *,
    student_id: str,
    project_id: str,
    pi: str,
    session_start: str,
    session_end: str,
    abrupt: bool,
    project_description: str,
    transcript_text: str,
    deep_eval_text: str,
    cumulative_text: str,
    threshold_categories: list[str],
    message_count: int,
    duration_seconds: int,
    project_description_sha: str,
) -> str:
    parts: list[str] = []
    parts.append("## Session identity")
    parts.append(f"- student_id: {student_id}")
    parts.append(f"- project_id: {project_id}")
    parts.append(f"- pi: {pi}")
    parts.append(f"- session_start: {session_start}")
    parts.append(f"- session_end: {session_end}")
    parts.append(f"- duration_seconds: {duration_seconds}")
    parts.append(f"- message_count: {message_count}")
    parts.append(f"- abrupt: {abrupt}")
    parts.append(f"- project_description_sha: {project_description_sha}")
    parts.append("")
    parts.append("## Categories that crossed the recurrence threshold this session")
    if threshold_categories:
        for c in threshold_categories:
            parts.append(f"- {c}")
    else:
        parts.append("(none)")
    parts.append("")
    parts.append("## Project description")
    parts.append(project_description.strip() or "(unavailable)")
    parts.append("")
    parts.append("## Prior cumulative report")
    parts.append(cumulative_text.strip() or "(empty)")
    parts.append("")
    parts.append("## Deep evaluator (current-deep-eval.md, post-rewrite)")
    parts.append(deep_eval_text.strip() or "(empty)")
    parts.append("")
    parts.append("## Transcript (chat-log.jsonl)")
    # Strip paste-detection fields before sending to the recorder LLM.
    # See `_strip_paste_meta` and
    # `notes/dev-0526/plans/paste-detection-plan.md`.
    redacted_transcript = _strip_paste_meta(transcript_text)
    parts.append(redacted_transcript.strip() or "(empty)")
    parts.append("")
    parts.append(
        "Produce exactly one call to `submit_artifacts` with all three "
        "fields. Use the exact `transcript_path` and `evaluation_path` values "
        "specified in your instructions."
    )
    return "\n".join(parts)


async def _failure_archive(
    *,
    session_dir: Path,
    sessions_dir: Path,
    session_start: str,
    session_end: str,
    student_id: str,
    project_id: str,
    pi: str,
    abrupt: bool,
    project_description_sha: str,
    message_count: int,
    duration_seconds: int,
    failure_reason: str,
) -> dict:
    """Write a minimal placeholder archive so the session is still visible
    to PIs even when the LLM call fails."""
    tmp_dir = sessions_dir / f"{session_start}.tmp"
    final_dir = sessions_dir / session_start
    if final_dir.exists():
        return {"status": "already_recorded"}
    if tmp_dir.exists():
        try:
            shutil.rmtree(tmp_dir)
        except OSError:
            pass
    try:
        tmp_dir.mkdir(parents=True, exist_ok=True)
        chat_log_path = session_dir / "chat-log.jsonl"
        deep_eval_path = session_dir / "current-deep-eval.md"
        fast_eval_path = session_dir / "current-fast-eval.md"
        fast_eval_turns_path = session_dir / "fast-eval-turns.jsonl"
        eval_state_path = session_dir / "eval-state.json"
        active_path = session_dir / "active-session.json"

        if chat_log_path.exists():
            shutil.copy2(chat_log_path, tmp_dir / "transcript.jsonl")
        else:
            (tmp_dir / "transcript.jsonl").write_text("", encoding="utf-8")
        if deep_eval_path.exists():
            shutil.copy2(deep_eval_path, tmp_dir / "evaluation.md")
        else:
            (tmp_dir / "evaluation.md").write_text("", encoding="utf-8")
        if fast_eval_turns_path.exists():
            shutil.copy2(fast_eval_turns_path, tmp_dir / "fast-eval-turns.jsonl")

        # Capture per-session prompt SHA / model IDs (Phase A1) before
        # active-session.json is unlinked below.
        active_data = _read_active_session(session_dir)

        metadata = {
            "student_id": student_id,
            "project_id": project_id,
            "pi": pi,
            "session_start": session_start,
            "session_end": session_end,
            "duration_seconds": duration_seconds,
            "summary_path": None,
            "transcript_path": f"sessions/{session_start}/transcript.jsonl",
            "evaluation_path": f"sessions/{session_start}/evaluation.md",
            "message_count": message_count,
            "abrupt": abrupt,
            "status": "recorder_failed",
            "failure_reason": failure_reason,
            "engagement": None,
            "coach_issue_count": None,
            "coach_issue_categories": [],
            "has_pi_notes": False,
            "project_description_sha": project_description_sha,
        }
        if active_data.get("prompts_sha"):
            metadata["prompts_sha"] = active_data["prompts_sha"]
            metadata["prompts"] = {
                "coach": "coach-instructions.md",
                "fast_eval": PROMPT_FILES["fast_eval"],
                "deep_eval": PROMPT_FILES["deep_eval"],
                "recorder": PROMPT_FILES["recorder"],
            }
        if isinstance(active_data.get("models"), dict):
            metadata["models"] = active_data["models"]
        (tmp_dir / "metadata.json").write_text(
            json.dumps(metadata, indent=2) + "\n", encoding="utf-8"
        )

        os.rename(tmp_dir, final_dir)

        # cumulative-report.md is intentionally NOT rewritten on failure.
        # Clean up the originals.
        for p in (
            chat_log_path,
            deep_eval_path,
            fast_eval_path,
            fast_eval_turns_path,
            eval_state_path,
            active_path,
        ):
            try:
                p.unlink(missing_ok=True)
            except OSError:
                pass
    except OSError as e:
        logger.error(f"failure-path archive write failed: {e}")
        return {"status": "recorder_failed", "error": str(e)}

    push_result = await _sync_to_coach_sessions(
        session_dir=session_dir,
        student_id=student_id,
        project_id=project_id,
        pi=pi,
        session_start=session_start,
        skip_cumulative=True,
    )

    return {
        "status": "recorder_failed",
        "error": failure_reason,
        "commit_sha": push_result.get("commit_sha") if push_result else None,
    }


# ---------------------------------------------------------------------------
# Coach-sessions sync
# ---------------------------------------------------------------------------


async def _run_subprocess(
    *args: str, cwd: Optional[Path] = None, timeout: float = 30.0
) -> tuple[int, str, str]:
    proc = await asyncio.create_subprocess_exec(
        *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        cwd=str(cwd) if cwd else None,
        env=server_module._build_safe_env(),
    )
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        return -1, "", "timeout"
    return (
        proc.returncode or 0,
        stdout.decode("utf-8", errors="replace"),
        stderr.decode("utf-8", errors="replace"),
    )


async def _sync_to_coach_sessions(
    *,
    session_dir: Path,
    student_id: str,
    project_id: str,
    pi: str,
    session_start: str,
    skip_cumulative: bool = False,
) -> dict:
    """Mirror the five-file bundle into coach-sessions and push.

    Returns {"status": "recorded"|"queued_retry", "commit_sha": optional}
    """
    if not pi:
        return {"status": "queued_retry", "error": "pi missing"}

    tracker = COACH_SESSIONS_DIR

    async with COACH_SESSIONS_GIT_LOCK:
        if not tracker.exists():
            rc, _, err = await _run_subprocess(
                "git", "clone", COACH_SESSIONS_REPO_URL, str(tracker), timeout=120
            )
            if rc != 0:
                logger.warning(f"coach-sessions clone failed: {err}")
                return {"status": "queued_retry", "error": err}

        rc, _, err = await _run_subprocess(
            "git", "pull", "--ff-only", cwd=tracker, timeout=30
        )
        if rc != 0:
            logger.warning(f"coach-sessions pull failed: {err}")
            # Continue anyway — we may be able to push if remote hasn't moved.

        target_root = tracker / pi / project_id / student_id
        target_session = target_root / "sessions" / session_start
        target_session.mkdir(parents=True, exist_ok=True)

        src_session = session_dir / "sessions" / session_start
        src_cumulative = session_dir / "cumulative-report.md"

        files_to_copy = [
            (src_session / "summary.md", target_session / "summary.md"),
            (src_session / "metadata.json", target_session / "metadata.json"),
            (src_session / "transcript.jsonl", target_session / "transcript.jsonl"),
            (src_session / "evaluation.md", target_session / "evaluation.md"),
            (
                src_session / "fast-eval-turns.jsonl",
                target_session / "fast-eval-turns.jsonl",
            ),
        ]
        if not skip_cumulative:
            files_to_copy.append((src_cumulative, target_root / "cumulative-report.md"))

        for src, dst in files_to_copy:
            if src.exists():
                try:
                    shutil.copy2(src, dst)
                except OSError as e:
                    logger.warning(f"copy {src} → {dst} failed: {e}")

        rc, _, err = await _run_subprocess("git", "add", ".", cwd=tracker, timeout=30)
        if rc != 0:
            return {"status": "queued_retry", "error": err}

        rc, status_out, _ = await _run_subprocess(
            "git", "status", "--porcelain", cwd=tracker, timeout=10
        )
        if not status_out.strip():
            # Nothing to commit — can happen on a re-run with identical content.
            return {"status": "recorded", "commit_sha": None}

        commit_msg = f"session: {student_id} on {project_id} at {session_start}"
        rc, _, err = await _run_subprocess(
            "git", "commit", "-m", commit_msg, cwd=tracker, timeout=30
        )
        if rc != 0:
            logger.warning(f"coach-sessions commit failed: {err}")
            return {"status": "queued_retry", "error": err}

        rc, sha_out, _ = await _run_subprocess(
            "git", "rev-parse", "HEAD", cwd=tracker, timeout=10
        )
        commit_sha: Optional[str] = (
            sha_out.strip() if rc == 0 and sha_out.strip() else None
        )

        rc, _, err = await _run_subprocess("git", "push", cwd=tracker, timeout=60)
        if rc != 0:
            logger.warning(f"coach-sessions push failed: {err}")
            return {"status": "queued_retry", "error": err, "commit_sha": commit_sha}

    logger.info(
        f"coach-sessions push OK student={student_id} project={project_id} sha={commit_sha}"
    )
    return {"status": "recorded", "commit_sha": commit_sha}
