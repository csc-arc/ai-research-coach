"""PI dashboard API — browse, prompt history, replay, and feedback.

All endpoints are gated by `ARC_PI_PASSCODE` (separate from the
student-facing `ARC_PASSCODE`). The passcode may be sent via the
`X-PI-Passcode` header or a `?passcode=` query parameter.

The implementation reads from a local clone of `coach-sessions` on the
droplet (the same one the recorder writes to). All git operations against
that clone funnel through the shared `COACH_SESSIONS_GIT_LOCK` defined in
`recorder.py` so concurrent recorder pushes, browse pulls, and feedback
writes serialize on a single mutex.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

import httpx
from fastapi import APIRouter, Body, Header, HTTPException, Query
from pydantic import BaseModel, Field

from . import recorder
from . import server as server_module

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/pi")


# Cache for the in-memory index (10 seconds, per the plan).
_INDEX_CACHE_TTL_SECONDS = 10
_index_cache: dict[str, Any] = {"ts": 0.0, "tree": None}

# Cache for prompt-history responses (5 minutes).
_PROMPT_HISTORY_CACHE_TTL_SECONDS = 5 * 60
_prompt_history_cache: dict[str, tuple[float, list[dict]]] = {}

_SLUG_RE = re.compile(r"^[A-Za-z0-9_.-]{1,100}$")


def _validate_pi_passcode(
    header_value: Optional[str], query_value: Optional[str]
) -> None:
    """Raise 401 unless the supplied passcode matches `ARC_PI_PASSCODE`.

    The PI passcode is configured via env var on the droplet. If it is unset
    (None or empty), the PI endpoints are effectively disabled — every
    request returns 401, no exceptions. This keeps the surface inert until
    the operator has explicitly set the passcode.
    """
    expected = server_module.PI_PASSCODE
    if not expected:
        raise HTTPException(
            status_code=401,
            detail="PI dashboard is not configured on this server",
        )
    supplied = header_value or query_value
    if not supplied or supplied != expected:
        raise HTTPException(status_code=401, detail="Invalid PI passcode")


def _validate_slug(value: str, field_name: str) -> None:
    if not _SLUG_RE.match(value):
        raise HTTPException(
            status_code=400,
            detail=f"Invalid {field_name}: must match {_SLUG_RE.pattern}",
        )


def _validate_session_ts(ts: str) -> None:
    """Sessions are stored under directories named with an ISO-8601 timestamp.
    Use a slightly looser regex than the slug regex so colons are allowed."""
    if not re.match(r"^[A-Za-z0-9_.:+-]{1,64}$", ts):
        raise HTTPException(status_code=400, detail="Invalid session timestamp")


# ---------------------------------------------------------------------------
# Browse — index + session bundle
# ---------------------------------------------------------------------------


async def _refresh_coach_sessions_clone() -> None:
    """`git pull --ff-only` the local coach-sessions clone, under the shared
    git lock. Failures are logged but non-fatal — we still serve from the
    last-known-good local state."""
    tracker = recorder.COACH_SESSIONS_DIR
    if not tracker.exists():
        # First-time setup: clone the repo. (The recorder will also clone on
        # its first push, but PIs may browse before the recorder runs.)
        async with recorder.COACH_SESSIONS_GIT_LOCK:
            if not tracker.exists():
                rc, _, err = await recorder._run_subprocess(
                    "git", "clone", recorder.COACH_SESSIONS_REPO_URL,
                    str(tracker), timeout=120,
                )
                if rc != 0:
                    logger.warning(f"PI browse: coach-sessions clone failed: {err}")
        return
    async with recorder.COACH_SESSIONS_GIT_LOCK:
        rc, _, err = await recorder._run_subprocess(
            "git", "pull", "--ff-only", cwd=tracker, timeout=30
        )
        if rc != 0:
            logger.warning(f"PI browse: coach-sessions pull failed: {err}")


def _build_index_tree(root: Path) -> dict[str, Any]:
    """Walk `coach-sessions/<pi>/<project>/<student>/sessions/<ts>` and emit
    `{pi: {project: {student: [session_ts, ...]}}}` sorted alphabetically /
    by timestamp descending."""
    tree: dict[str, dict[str, dict[str, list[str]]]] = {}
    if not root.exists():
        return tree
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
                session_ts: list[str] = sorted(
                    (s.name for s in sessions_dir.iterdir() if s.is_dir()),
                    reverse=True,
                )
                if not session_ts:
                    continue
                tree.setdefault(pi_dir.name, {}).setdefault(
                    project_dir.name, {}
                )[student_dir.name] = session_ts
    return tree


@router.get("/index")
async def get_index(
    passcode: Optional[str] = Query(None),
    x_pi_passcode: Optional[str] = Header(None, alias="X-PI-Passcode"),
):
    """Return the {pi: {project: {student: [session_ts, ...]}}} tree."""
    _validate_pi_passcode(x_pi_passcode, passcode)

    now = time.monotonic()
    cached = _index_cache.get("tree")
    if cached is not None and now - _index_cache["ts"] < _INDEX_CACHE_TTL_SECONDS:
        return {"tree": cached, "cached": True}

    await _refresh_coach_sessions_clone()
    tree = _build_index_tree(recorder.COACH_SESSIONS_DIR)
    _index_cache["tree"] = tree
    _index_cache["ts"] = now
    return {"tree": tree, "cached": False}


def _read_text_or_none(path: Path) -> Optional[str]:
    try:
        return path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return None


def _read_jsonl(path: Path) -> Optional[list[dict]]:
    if not path.exists():
        return None
    out: list[dict] = []
    try:
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    out.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
        return out
    except OSError:
        return None


def _read_json_or_none(path: Path) -> Optional[Any]:
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None


def _resolve_session_dir(pi: str, project: str, student: str, ts: str) -> Path:
    """Return the path to the on-disk session directory, validating that all
    components stay inside coach-sessions root."""
    _validate_slug(pi, "pi")
    _validate_slug(project, "project")
    _validate_slug(student, "student")
    _validate_session_ts(ts)

    root = recorder.COACH_SESSIONS_DIR.resolve()
    target = (root / pi / project / student / "sessions" / ts).resolve()
    if not target.is_relative_to(root):
        raise HTTPException(status_code=400, detail="Path traversal blocked")
    return target


@router.get("/session/{pi}/{project}/{student}/{ts}")
async def get_session(
    pi: str,
    project: str,
    student: str,
    ts: str,
    passcode: Optional[str] = Query(None),
    x_pi_passcode: Optional[str] = Header(None, alias="X-PI-Passcode"),
):
    """Return the full session bundle: summary, transcript, evaluation,
    metadata, fast_eval_turns (may be null), cumulative_report, feedback."""
    _validate_pi_passcode(x_pi_passcode, passcode)

    session_dir = _resolve_session_dir(pi, project, student, ts)
    if not session_dir.exists():
        raise HTTPException(status_code=404, detail="Session not found")

    student_root = session_dir.parent.parent  # drop /sessions/<ts>

    return {
        "summary": _read_text_or_none(session_dir / "summary.md"),
        "transcript": _read_jsonl(session_dir / "transcript.jsonl") or [],
        "evaluation": _read_text_or_none(session_dir / "evaluation.md"),
        "metadata": _read_json_or_none(session_dir / "metadata.json"),
        "fast_eval_turns": _read_jsonl(session_dir / "fast-eval-turns.jsonl"),
        "cumulative_report": _read_text_or_none(student_root / "cumulative-report.md"),
        "feedback": _read_json_or_none(session_dir / "feedback.json"),
    }


# ---------------------------------------------------------------------------
# Phase A4 — Prompt history & content
# ---------------------------------------------------------------------------


_VALID_PROMPT_KEYS = {
    "legacy-instructions": "legacy-instructions.md",
    "coach-instructions": "coach-instructions.md",
    "fast-eval": recorder.PROMPT_FILES["fast_eval"],
    "deep-eval": recorder.PROMPT_FILES["deep_eval"],
    "recorder": recorder.PROMPT_FILES["recorder"],
}

# Historical filename chains for prompts that have been renamed. When
# resolving a prompt at a pinned SHA, we try each filename newest-first so
# that replaying a session recorded before a rename still finds the content.
# Coach: instructions-v1.md → coach-instructions.md (renamed 2026-05).
# Legacy: instructions.md → legacy-instructions.md (renamed 2026-05).
_PROMPT_FILENAME_HISTORY = {
    "coach-instructions": ("coach-instructions.md", "instructions-v1.md"),
    "legacy-instructions": ("legacy-instructions.md", "instructions.md"),
}


def _prompt_filename_for(key: str) -> str:
    if key not in _VALID_PROMPT_KEYS:
        raise HTTPException(
            status_code=404,
            detail=(
                f"Unknown prompt name: {key}. "
                f"Valid: {sorted(_VALID_PROMPT_KEYS)}"
            ),
        )
    return _VALID_PROMPT_KEYS[key]


async def _fetch_prompt_with_fallback(prompt_name: str, sha: str) -> tuple[str, str]:
    """Fetch a prompt's content at `sha`, following the rename history chain.

    Returns `(content, filename_used)`. For renamed prompts (coach, legacy) we
    try the current filename first, then older names, so replaying a session
    pinned to a pre-rename SHA still resolves. Raises 502 if every candidate
    filename 404s / errors at the given SHA.
    """
    chain = _PROMPT_FILENAME_HISTORY.get(prompt_name)
    if chain is None:
        chain = (_prompt_filename_for(prompt_name),)
    last_exc: Optional[Exception] = None
    for filename in chain:
        url = recorder._prompt_url_at(sha, filename)
        try:
            text = await recorder._fetch_prompt(url)
            return text, filename
        except httpx.HTTPError as e:
            last_exc = e
            continue
    raise HTTPException(
        status_code=502,
        detail=f"Prompt fetch failed for {prompt_name} at {sha}: {last_exc}",
    )


def _github_headers() -> dict[str, str]:
    """GitHub API headers, with optional `GITHUB_TOKEN` for higher rate limits."""
    headers = {"Accept": "application/vnd.github+json"}
    import os
    gh_token = os.environ.get("GITHUB_TOKEN")
    if gh_token:
        headers["Authorization"] = f"Bearer {gh_token}"
    return headers


async def _fetch_prompt_history(filename: str) -> list[dict]:
    """Internal: fetch the per-file commit history (newest first), cached.

    Used by both `/prompt-history/{name}` and `/prompts-divergence`.
    """
    now = time.monotonic()
    cached = _prompt_history_cache.get(filename)
    if cached is not None:
        ts, payload = cached
        if now - ts < _PROMPT_HISTORY_CACHE_TTL_SECONDS:
            return payload

    api_url = (
        f"https://api.github.com/repos/{recorder.REPO_OWNER}/{recorder.REPO_NAME}"
        f"/commits"
    )
    params = {"path": f"public/{filename}", "sha": "main", "per_page": "100"}

    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            r = await client.get(api_url, params=params, headers=_github_headers())
            r.raise_for_status()
            commits_payload = r.json()
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"GitHub API error: {e}")

    history: list[dict] = []
    for c in commits_payload:
        sha = c.get("sha")
        commit_obj = c.get("commit") or {}
        author = commit_obj.get("author") or {}
        committed_at = author.get("date") or ""
        message_lines = (commit_obj.get("message") or "").splitlines()
        message = message_lines[0] if message_lines else ""
        if sha:
            history.append({
                "sha": sha,
                "committed_at": committed_at,
                "commit_subject": message,
            })

    _prompt_history_cache[filename] = (now, history)
    return history


@router.get("/prompt-history/{prompt_name}")
async def get_prompt_history(
    prompt_name: str,
    passcode: Optional[str] = Query(None),
    x_pi_passcode: Optional[str] = Header(None, alias="X-PI-Passcode"),
):
    """List commits on `main` that touched the named prompt file, newest
    first. Cached for ~5 minutes."""
    _validate_pi_passcode(x_pi_passcode, passcode)
    filename = _prompt_filename_for(prompt_name)
    history = await _fetch_prompt_history(filename)
    return {"history": history, "cached": False}


# Per-since-sha cache for divergence responses. Keyed by since_sha so each
# session's check is cached independently. TTL is short — main is moving.
_DIVERGENCE_CACHE_TTL_SECONDS = 60
_divergence_cache: dict[str, tuple[float, dict]] = {}


async def _fetch_commit_committed_at(sha: str) -> Optional[str]:
    """Resolve a commit SHA → its `committer.date` (ISO 8601 string).

    Returns None if the API call fails or the SHA is unknown — caller
    decides how to degrade.
    """
    if not sha or sha.startswith("local:") or sha == "unknown":
        return None
    api_url = (
        f"https://api.github.com/repos/{recorder.REPO_OWNER}/{recorder.REPO_NAME}"
        f"/commits/{sha}"
    )
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            r = await client.get(api_url, headers=_github_headers())
            if r.status_code == 404:
                return None
            r.raise_for_status()
            obj = r.json()
            commit = obj.get("commit") or {}
            committer = commit.get("committer") or {}
            return committer.get("date") or (commit.get("author") or {}).get("date")
    except httpx.HTTPError:
        return None


@router.get("/prompts-divergence")
async def get_prompts_divergence(
    since: str = Query(..., min_length=1, max_length=64),
    passcode: Optional[str] = Query(None),
    x_pi_passcode: Optional[str] = Header(None, alias="X-PI-Passcode"),
):
    """Compare a session's pinned prompts SHA against current head of main.

    Returns per-prompt-file divergence info: which of the three prompt files
    (coach `coach-instructions.md`, fast-eval, deep-eval) have been modified
    since the session ran, plus the commit subjects so the PI can decide
    whether it's worth re-running with the current prompts.

    Sessions whose `prompts_sha` is missing or starts with `local:` cannot
    be compared (no GitHub anchor); we return `comparable: false` and let
    the UI suppress the chip.
    """
    _validate_pi_passcode(x_pi_passcode, passcode)

    # Sanity-check the SHA shape — reject obvious garbage but allow short
    # SHAs since those are still resolvable on GitHub.
    if not re.match(r"^[0-9a-fA-F]{7,40}$", since):
        # Either a `local:` hash or an `unknown` placeholder — not comparable.
        return {
            "since_sha": since,
            "head_sha": None,
            "comparable": False,
            "reason": "Pinned SHA is a local content hash, not a GitHub commit",
            "prompts": {},
            "any_modified": False,
        }

    # Cache by since_sha so re-clicking a session view doesn't re-spam GitHub.
    now = time.monotonic()
    cached = _divergence_cache.get(since)
    if cached is not None:
        ts, payload = cached
        if now - ts < _DIVERGENCE_CACHE_TTL_SECONDS:
            return {**payload, "cached": True}

    head_sha = await recorder.resolve_prompts_sha()
    if head_sha and head_sha.startswith("local:"):
        # The recorder fell back to a local hash — we can't compare against
        # GitHub. Surface this honestly rather than pretending to compare.
        payload = {
            "since_sha": since,
            "head_sha": head_sha,
            "comparable": False,
            "reason": "Server is in local-fallback mode (no GitHub access)",
            "prompts": {},
            "any_modified": False,
        }
        _divergence_cache[since] = (now, payload)
        return payload

    if head_sha == since:
        payload = {
            "since_sha": since,
            "head_sha": head_sha,
            "comparable": True,
            "prompts": {
                "coach-instructions.md": {"modified": False, "commits": []},
                "fast-eval-prompt.md": {"modified": False, "commits": []},
                "deep-eval-prompt.md": {"modified": False, "commits": []},
            },
            "any_modified": False,
        }
        _divergence_cache[since] = (now, payload)
        return payload

    # Resolve the date of `since` so we can filter per-file histories.
    since_date = await _fetch_commit_committed_at(since)
    if not since_date:
        # Fall back to "every commit on file is potentially newer" — the UI
        # can still show the chip but won't have a precise list.
        since_date = ""

    # Fetch each of the three prompt files' commit histories in parallel and
    # filter to commits whose committer-date is strictly newer than the
    # session's pinned commit's date. (We ignore the recorder prompt for
    # divergence — the PI dashboard's drafting flow excludes it.)
    targets = {
        "coach-instructions.md": "coach-instructions.md",
        "fast-eval-prompt.md": recorder.PROMPT_FILES["fast_eval"],
        "deep-eval-prompt.md": recorder.PROMPT_FILES["deep_eval"],
    }

    async def per_file(label: str, filename: str):
        try:
            history = await _fetch_prompt_history(filename)
        except HTTPException:
            return label, {"modified": False, "commits": [], "error": "history fetch failed"}
        if not since_date:
            # Without a since-date we can't reliably filter. Conservative:
            # mark as unknown rather than guessing.
            return label, {
                "modified": False,
                "commits": [],
                "error": "could not resolve session SHA on GitHub",
            }
        commits_since = [
            c for c in history
            if c.get("committed_at") and c["committed_at"] > since_date
        ]
        return label, {
            "modified": len(commits_since) > 0,
            "commits": commits_since[:20],  # cap for response size
        }

    results = await asyncio.gather(*(per_file(k, v) for k, v in targets.items()))
    prompts = dict(results)

    payload = {
        "since_sha": since,
        "head_sha": head_sha,
        "comparable": True,
        "prompts": prompts,
        "any_modified": any(p.get("modified") for p in prompts.values()),
    }
    _divergence_cache[since] = (now, payload)
    return payload


@router.get("/prompt/{prompt_name}")
async def get_prompt_at_sha(
    prompt_name: str,
    sha: str = Query(..., min_length=1, max_length=40),
    passcode: Optional[str] = Query(None),
    x_pi_passcode: Optional[str] = Header(None, alias="X-PI-Passcode"),
):
    """Return the raw content of a prompt at `sha` (use the literal string
    `live` for head-of-main)."""
    _validate_pi_passcode(x_pi_passcode, passcode)
    # Validate the key up front (404s on unknown names) before fetching.
    _prompt_filename_for(prompt_name)

    if sha == "live":
        resolved_sha = await recorder.resolve_prompts_sha()
    else:
        if not re.match(r"^[0-9a-f]{7,40}$|^local:[0-9a-f]{1,40}$", sha):
            raise HTTPException(status_code=400, detail="Bad sha format")
        resolved_sha = sha

    text, filename = await _fetch_prompt_with_fallback(prompt_name, resolved_sha)
    return {"sha": resolved_sha, "filename": filename, "content": text}


# ---------------------------------------------------------------------------
# Phase A5 — Single-turn replay
# ---------------------------------------------------------------------------


def _slice_transcript_to_turn(
    transcript: list[dict], turn: int
) -> tuple[list[dict], dict]:
    """Slice the transcript so the conversation looks like it did right
    before the original `turn`-th user message was answered.

    `turn` is 1-indexed and counts user messages. The slice contains every
    message up to and including the `turn`-th user message, minus the
    coach response that came after (if any).

    Returns (sliced_messages, target_user_turn). Raises 400 on bad index.
    """
    user_indices = [i for i, t in enumerate(transcript) if t.get("role") == "user"]
    if turn < 1 or turn > len(user_indices):
        raise HTTPException(
            status_code=400,
            detail=f"turn {turn} out of range (1..{len(user_indices)})",
        )
    cutoff = user_indices[turn - 1]
    sliced = transcript[: cutoff + 1]
    return sliced, transcript[cutoff]


def compose_coach_system_message(
    base_prompt: str, fast_eval: Optional[str], deep_eval: Optional[str]
) -> str:
    """Compose the coach system message the same way `completion_proxy`
    does. Kept here so the replay endpoint and the live endpoint can't
    drift; `server.completion_proxy` calls into this too."""
    sections: list[str] = []
    if deep_eval:
        sections.append(
            "## Live evaluation (running)\n\n"
            "_Auto-maintained across the session by the deep evaluator._\n\n"
            f"{deep_eval}"
        )
    if fast_eval:
        sections.append(
            "## Live evaluation (this turn)\n\n"
            "_Freshly computed for the moment about to unfold. Treat tactical flags "
            "(coach_issues, open_threads) as a correction signal for the response "
            "you are about to write._\n\n"
            f"{fast_eval}"
        )
    if not sections:
        return base_prompt
    return base_prompt + "\n\n---\n\n" + "\n\n---\n\n".join(sections)


class PromptSelector(BaseModel):
    mode: str = Field(..., description="One of: original | sha | text")
    value: Optional[str] = None


class ReplayRequest(BaseModel):
    pi: str
    project: str
    student: str
    session_ts: str
    turn: int
    coach_prompt: PromptSelector
    fast_eval_prompt: PromptSelector
    deep_eval_prompt: PromptSelector
    coach_model: Optional[str] = None
    fast_eval_model: Optional[str] = None
    deep_eval_model: Optional[str] = None


async def _resolve_selector(
    selector: PromptSelector, prompt_key: str, original_sha: Optional[str]
) -> str:
    """Resolve a PromptSelector → the prompt text to use."""
    mode = selector.mode
    if mode == "text":
        if selector.value is None:
            raise HTTPException(status_code=400, detail="mode=text requires value")
        return selector.value
    if mode == "original":
        if not original_sha:
            raise HTTPException(
                status_code=400,
                detail=(
                    "mode=original is unavailable for this session "
                    "(prompts_sha was not recorded)."
                ),
            )
        return await recorder.fetch_prompt_for_session(prompt_key, original_sha)
    if mode == "sha":
        if not selector.value:
            raise HTTPException(status_code=400, detail="mode=sha requires value")
        sha_value = selector.value
        if sha_value == "live":
            sha_value = await recorder.resolve_prompts_sha()
        if not re.match(r"^[0-9a-f]{7,40}$|^local:[0-9a-f]{1,40}$", sha_value):
            raise HTTPException(status_code=400, detail="Bad sha format")
        filename = recorder.PROMPT_FILES.get(prompt_key) or _VALID_PROMPT_KEYS.get(
            prompt_key.replace("_", "-")
        )
        if not filename:
            raise HTTPException(status_code=400, detail=f"Unknown prompt key {prompt_key}")
        url = recorder._prompt_url_at(sha_value, filename)
        return await recorder._fetch_prompt(url)
    raise HTTPException(status_code=400, detail=f"Unknown selector mode: {mode}")


async def _resolve_coach_prompt_selector(
    selector: PromptSelector, original_sha: Optional[str]
) -> str:
    """Resolve the coach system prompt for replay.

    The active coach prompt is `coach-instructions.md` (formerly
    `instructions-v1.md`). For `mode=original`/`mode=sha` we fetch the content
    at the pinned SHA via `_fetch_prompt_with_fallback`, which tries the
    current filename first and falls back to the pre-rename name for sessions
    recorded before the rename. `mode=text` uses the supplied literal."""
    mode = selector.mode
    if mode == "text":
        if selector.value is None:
            raise HTTPException(status_code=400, detail="mode=text requires value")
        return selector.value
    if mode == "original":
        if not original_sha:
            raise HTTPException(
                status_code=400,
                detail="mode=original unavailable: prompts_sha not recorded.",
            )
        text, _ = await _fetch_prompt_with_fallback("coach-instructions", original_sha)
        return text
    if mode == "sha":
        if not selector.value:
            raise HTTPException(status_code=400, detail="mode=sha requires value")
        sha_value = selector.value
        if sha_value == "live":
            sha_value = await recorder.resolve_prompts_sha()
        if not re.match(r"^[0-9a-f]{7,40}$|^local:[0-9a-f]{1,40}$", sha_value):
            raise HTTPException(status_code=400, detail="Bad sha format")
        text, _ = await _fetch_prompt_with_fallback("coach-instructions", sha_value)
        return text
    raise HTTPException(status_code=400, detail=f"Unknown selector mode: {mode}")


@router.post("/replay-turn")
async def replay_turn(
    body: ReplayRequest = Body(...),
    passcode: Optional[str] = Query(None),
    x_pi_passcode: Optional[str] = Header(None, alias="X-PI-Passcode"),
):
    """Run deep-eval → fast-eval → coach for one historical turn, with
    optional prompt and model overrides. Nothing is persisted to disk.
    """
    _validate_pi_passcode(x_pi_passcode, passcode)

    session_dir = _resolve_session_dir(
        body.pi, body.project, body.student, body.session_ts
    )
    if not session_dir.exists():
        raise HTTPException(status_code=404, detail="Session not found")

    transcript = _read_jsonl(session_dir / "transcript.jsonl") or []
    if not transcript:
        raise HTTPException(status_code=400, detail="Session has no transcript")
    metadata = _read_json_or_none(session_dir / "metadata.json") or {}

    sliced, _ = _slice_transcript_to_turn(transcript, body.turn)
    original_sha = metadata.get("prompts_sha") or None
    project_id = metadata.get("project_id") or body.project
    project_description = await recorder._fetch_project_description(project_id)

    # ---- Step 1: deep-eval ----
    deep_eval_prompt = await _resolve_selector(
        body.deep_eval_prompt, "deep_eval", original_sha
    )
    rendered_deep_prompt = deep_eval_prompt.replace("${eval_mode}", "full")
    deep_user = recorder._render_deep_eval_user_message(
        eval_mode="full",
        turns=sliced,
        prior_eval="",
        cumulative_report="",
        project_description=project_description,
    )
    deep_model = body.deep_eval_model or (
        metadata.get("models", {}).get("deep_eval") if isinstance(metadata.get("models"), dict) else None
    ) or recorder.EVAL_MODEL
    deep_msg = await recorder._openrouter_call(
        model=deep_model,
        system_prompt=rendered_deep_prompt,
        user_message=deep_user,
        tools=[recorder.DEEP_EVAL_TOOL_SCHEMA],
        tool_choice={"type": "function", "function": {"name": "submit_evaluation"}},
        timeout_seconds=recorder.DEEP_EVALUATOR_TIMEOUT_SECONDS,
        kind="replay",
        student_id=body.student,
        project_id=project_id,
    )
    deep_args = recorder._extract_tool_args(deep_msg, "submit_evaluation") if deep_msg else None
    deep_eval_md = recorder._render_deep_eval_markdown(deep_args) if deep_args else ""

    # ---- Step 2: fast-eval ----
    fast_eval_prompt = await _resolve_selector(
        body.fast_eval_prompt, "fast_eval", original_sha
    )
    fast_user = recorder._render_fast_eval_user_message(
        recent_turns=sliced[-4:], project_description=project_description
    )
    fast_model = body.fast_eval_model or (
        metadata.get("models", {}).get("fast_eval") if isinstance(metadata.get("models"), dict) else None
    ) or recorder.EVAL_MODEL
    fast_msg = await recorder._openrouter_call(
        model=fast_model,
        system_prompt=fast_eval_prompt,
        user_message=fast_user,
        tools=[recorder.FAST_EVAL_TOOL_SCHEMA],
        tool_choice={
            "type": "function",
            "function": {"name": "submit_fast_evaluation"},
        },
        timeout_seconds=recorder.FAST_EVAL_LLM_TIMEOUT_SECONDS,
        kind="replay",
        student_id=body.student,
        project_id=project_id,
    )
    fast_args = recorder._extract_tool_args(fast_msg, "submit_fast_evaluation") if fast_msg else None
    fast_eval_md = recorder._render_fast_eval_markdown(fast_args) if fast_args else ""

    # ---- Step 3: coach ----
    coach_prompt = await _resolve_coach_prompt_selector(
        body.coach_prompt, original_sha
    )
    system_message = compose_coach_system_message(
        coach_prompt, fast_eval_md or None, deep_eval_md or None
    )
    coach_model = body.coach_model or (
        metadata.get("models", {}).get("coach") if isinstance(metadata.get("models"), dict) else None
    ) or server_module.COACH_MODEL

    if not server_module.OPENROUTER_API_KEY:
        raise HTTPException(
            status_code=503,
            detail="OpenRouter API key not configured on this server",
        )

    coach_messages = [{"role": "system", "content": system_message}]
    for m in sliced:
        role = m.get("role")
        if role not in ("user", "assistant"):
            continue
        content = m.get("content", "")
        coach_messages.append({"role": role, "content": content})
    payload = {
        "model": coach_model,
        "messages": coach_messages,
        "stream": False,
    }
    headers = {
        "Authorization": f"Bearer {server_module.OPENROUTER_API_KEY}",
        "Content-Type": "application/json",
        "HTTP-Referer": "https://airesearchcoach.org",
        "X-Title": "AI Research Coach (replay)",
    }
    coach_response_text = ""
    coach_usage: dict = {}
    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            r = await client.post(
                "https://openrouter.ai/api/v1/chat/completions",
                headers=headers,
                json=payload,
            )
            r.raise_for_status()
            data = r.json()
            choices = data.get("choices") or []
            if choices:
                coach_response_text = choices[0].get("message", {}).get("content", "") or ""
            coach_usage = data.get("usage") or {}
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"Coach call failed: {e}")

    pt = coach_usage.get("prompt_tokens")
    ct = coach_usage.get("completion_tokens")
    logger.info(
        f"usage kind=replay student={body.student} project={project_id} "
        f"model={coach_model} prompt_tokens={pt} completion_tokens={ct}"
    )

    return {
        "deep_eval_md": deep_eval_md,
        "deep_eval_args": deep_args,
        "fast_eval_md": fast_eval_md,
        "fast_eval_args": fast_args,
        "coach_response": coach_response_text,
        "coach_system_message": system_message,
        "models_used": {
            "coach": coach_model,
            "fast_eval": fast_model,
            "deep_eval": deep_model,
        },
        "original_prompts_sha": original_sha,
    }


# ---------------------------------------------------------------------------
# Phase A6 — Feedback write/read
# ---------------------------------------------------------------------------


_FEEDBACK_SCHEMA: dict[str, list] = {
    "session_ratings": [],
    "turn_annotations": [],
    "coach_issue_reviews": [],
}


_VALID_SESSION_RATINGS = {"great", "ok", "poor"}
# Coach-row annotations: coach_good, coach_problem, note.
# Student-row annotations: student_engaged, student_struggling,
# student_solution_seeking, student_off_topic.
# student_issue is kept for back-compat with older annotations.
_VALID_TURN_TAGS = {
    "coach_problem",
    "coach_good",
    "student_engaged",
    "student_struggling",
    "student_solution_seeking",
    "student_off_topic",
    "student_issue",
    "note",
}
_VALID_VERDICTS = {"agree", "disagree", "partial"}


class FeedbackBase(BaseModel):
    pi: str
    project: str
    student: str
    session_ts: str
    reviewer: str = Field(..., min_length=1, max_length=80)
    note: Optional[str] = ""
    supersedes: Optional[str] = None
    retracted: Optional[bool] = None


class SessionFeedback(FeedbackBase):
    rating: str  # "great" | "ok" | "poor"


class TurnFeedback(FeedbackBase):
    turn: int = Field(..., ge=1)
    tag: str  # coach_problem | coach_good | student_issue | note


class IssueFeedback(FeedbackBase):
    turn: int = Field(..., ge=1)
    issue_category: str
    verdict: str  # agree | disagree | partial


def _ensure_feedback_schema(data: Optional[dict]) -> dict:
    if not isinstance(data, dict):
        data = {}
    out = dict(_FEEDBACK_SCHEMA)
    for k in _FEEDBACK_SCHEMA:
        existing = data.get(k)
        out[k] = list(existing) if isinstance(existing, list) else []
    return out


async def _append_feedback_entry(
    *,
    pi: str,
    project: str,
    student: str,
    session_ts: str,
    reviewer: str,
    section: str,
    entry_payload: dict,
) -> dict:
    """Common feedback-write path. Acquires the shared coach-sessions git
    lock, pulls, reads or initializes feedback.json, appends, commits, and
    pushes."""
    session_dir = _resolve_session_dir(pi, project, student, session_ts)
    if not session_dir.exists():
        raise HTTPException(status_code=404, detail="Session not found")

    feedback_path = session_dir / "feedback.json"
    tracker = recorder.COACH_SESSIONS_DIR

    new_id = str(uuid.uuid4())
    full_entry = {
        "id": new_id,
        "reviewer": reviewer,
        "ts": datetime.now(timezone.utc).isoformat(),
        **entry_payload,
    }

    async with recorder.COACH_SESSIONS_GIT_LOCK:
        # Best-effort pull so we don't write on top of a stale local view.
        rc, _, err = await recorder._run_subprocess(
            "git", "pull", "--ff-only", cwd=tracker, timeout=30
        )
        if rc != 0:
            logger.warning(f"feedback POST: pull failed (continuing): {err}")

        existing = _read_json_or_none(feedback_path)
        data = _ensure_feedback_schema(existing)
        data.setdefault(section, []).append(full_entry)
        try:
            feedback_path.write_text(
                json.dumps(data, indent=2) + "\n", encoding="utf-8"
            )
        except OSError as e:
            raise HTTPException(status_code=500, detail=f"feedback write failed: {e}")

        rel = feedback_path.relative_to(tracker)
        rc, _, err = await recorder._run_subprocess(
            "git", "add", str(rel), cwd=tracker, timeout=15
        )
        if rc != 0:
            raise HTTPException(status_code=500, detail=f"git add failed: {err}")

        rc, status_out, _ = await recorder._run_subprocess(
            "git", "status", "--porcelain", cwd=tracker, timeout=10
        )
        if not status_out.strip():
            # Nothing changed (race? identical content?); still report success.
            return {"id": new_id, "committed": False}

        commit_msg = f"pi feedback: {reviewer} on {pi}/{project}/{student}/{session_ts}"
        rc, _, err = await recorder._run_subprocess(
            "git", "commit", "-m", commit_msg, cwd=tracker, timeout=30
        )
        if rc != 0:
            raise HTTPException(status_code=500, detail=f"git commit failed: {err}")

        rc, _, err = await recorder._run_subprocess(
            "git", "push", cwd=tracker, timeout=60
        )
        if rc != 0:
            logger.warning(f"feedback POST: push failed: {err}")
            return {"id": new_id, "committed": True, "pushed": False, "push_error": err}

    # Bust the index cache so the new feedback is visible immediately.
    _index_cache["ts"] = 0.0
    # Bust the per-reviewer feedback cache used by the drafts widget so the
    # `new feedback since last synth` counter updates without a 30s lag.
    # Lazy import: pi_drafts imports pi_api, so importing it at module-load
    # time would create a circular import.
    try:
        from . import pi_drafts
        pi_drafts.invalidate_feedback_by_reviewer_cache()
    except ImportError:
        pass
    return {"id": new_id, "committed": True, "pushed": True}


@router.post("/feedback/session")
async def post_session_feedback(
    body: SessionFeedback,
    passcode: Optional[str] = Query(None),
    x_pi_passcode: Optional[str] = Header(None, alias="X-PI-Passcode"),
):
    _validate_pi_passcode(x_pi_passcode, passcode)
    if body.rating not in _VALID_SESSION_RATINGS:
        raise HTTPException(status_code=400, detail=f"rating must be one of {sorted(_VALID_SESSION_RATINGS)}")
    payload = {
        "rating": body.rating,
        "note": body.note or "",
    }
    if body.supersedes:
        payload["supersedes"] = body.supersedes
    if body.retracted:
        payload["retracted"] = True
    return await _append_feedback_entry(
        pi=body.pi,
        project=body.project,
        student=body.student,
        session_ts=body.session_ts,
        reviewer=body.reviewer,
        section="session_ratings",
        entry_payload=payload,
    )


@router.post("/feedback/turn")
async def post_turn_feedback(
    body: TurnFeedback,
    passcode: Optional[str] = Query(None),
    x_pi_passcode: Optional[str] = Header(None, alias="X-PI-Passcode"),
):
    _validate_pi_passcode(x_pi_passcode, passcode)
    if body.tag not in _VALID_TURN_TAGS:
        raise HTTPException(status_code=400, detail=f"tag must be one of {sorted(_VALID_TURN_TAGS)}")
    payload = {
        "turn": body.turn,
        "tag": body.tag,
        "note": body.note or "",
    }
    if body.supersedes:
        payload["supersedes"] = body.supersedes
    if body.retracted:
        payload["retracted"] = True
    return await _append_feedback_entry(
        pi=body.pi,
        project=body.project,
        student=body.student,
        session_ts=body.session_ts,
        reviewer=body.reviewer,
        section="turn_annotations",
        entry_payload=payload,
    )


@router.post("/feedback/issue")
async def post_issue_feedback(
    body: IssueFeedback,
    passcode: Optional[str] = Query(None),
    x_pi_passcode: Optional[str] = Header(None, alias="X-PI-Passcode"),
):
    _validate_pi_passcode(x_pi_passcode, passcode)
    if body.verdict not in _VALID_VERDICTS:
        raise HTTPException(status_code=400, detail=f"verdict must be one of {sorted(_VALID_VERDICTS)}")
    if body.issue_category not in recorder.COACH_ISSUE_CATEGORIES:
        raise HTTPException(
            status_code=400,
            detail=f"unknown issue_category: {body.issue_category}",
        )
    payload = {
        "turn": body.turn,
        "issue_category": body.issue_category,
        "verdict": body.verdict,
        "note": body.note or "",
    }
    if body.supersedes:
        payload["supersedes"] = body.supersedes
    if body.retracted:
        payload["retracted"] = True
    return await _append_feedback_entry(
        pi=body.pi,
        project=body.project,
        student=body.student,
        session_ts=body.session_ts,
        reviewer=body.reviewer,
        section="coach_issue_reviews",
        entry_payload=payload,
    )
