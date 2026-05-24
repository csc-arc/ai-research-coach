"""FastAPI server for executing student/project-scoped Python and shell scripts."""

import asyncio
import json
import logging
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal, Optional, Union

import httpx
from fastapi import BackgroundTasks, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response, StreamingResponse
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

# Mutable globals populated by run_server() / create_app()
SERVER_PASSCODE: Optional[str] = None
SERVER_WORKING_DIR: Optional[Path] = None
OPENROUTER_API_KEY: Optional[str] = None

# App-level model constants. The coach model is locked at process start; the
# student-facing UI cannot change it. The QA replay endpoint (Phase A5) is the
# only place that may override on a per-call basis.
COACH_MODEL = os.environ.get("ARC_COACH_MODEL", "openai/gpt-chat-latest")

# PI dashboard passcode (separate from the student-facing ARC_PASSCODE).
# Empty/unset means the PI endpoints are effectively disabled.
PI_PASSCODE: Optional[str] = os.environ.get("ARC_PI_PASSCODE") or None

# student_id and project_id must be safe path components.
# Allow letters, digits, dash, underscore. Length 1..64.
ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

# Default CORS origins. Extra origins can be added via --allow-origin on the CLI.
DEFAULT_CORS_ORIGINS = [
    "http://localhost:5173",
    "https://arc-csc.github.io",
]

# Two-agent constants
DEEP_EVAL_EVERY_N_ASSISTANT_TURNS = 1
DEEP_EVAL_FULL_REWRITE_EVERY_N = 10
INACTIVITY_TIMEOUT_SECONDS = 1800  # 30 minutes
FAST_EVAL_WAIT_BUDGET_SECONDS = 5
RESUME_WINDOW_SECONDS = 4 * 3600

# Module-level registries protected by per-session locks
_inactivity_tasks: dict[tuple[str, str], asyncio.Task] = {}
_fast_eval_tasks: dict[tuple[str, str], asyncio.Task] = {}
_session_locks: dict[tuple[str, str], asyncio.Lock] = {}

# Subprocess env hardening: only pass through known-safe env vars.
_SAFE_ENV_KEYS = {
    "PATH", "HOME", "USER", "SHELL", "TMPDIR",
    "LANG", "LC_ALL",
    "PYTHONUNBUFFERED", "PYTHONIOENCODING",
    "MPLBACKEND",
    "XDG_CACHE_HOME",
    "OPENBLAS_NUM_THREADS", "OMP_NUM_THREADS",
}
_SAFE_ENV_PREFIXES = ("LC_",)


app = FastAPI(title="AI Research Coach Script Execution Server")


def _mount_pi_router_once() -> None:
    """Lazily mount the PI dashboard router. Recorder.py's module load is
    expensive (resolves env vars, sets up locks); we keep the import inside
    a helper so test paths that build a bare FastAPI app can opt in or out.
    """
    if getattr(app.state, "_pi_router_mounted", False):
        return
    from . import pi_api
    app.include_router(pi_api.router)
    app.state._pi_router_mounted = True


class ChatMessage(BaseModel):
    role: Literal["system", "user", "assistant", "tool"]
    content: Optional[Union[str, list]] = None
    tool_calls: Optional[list] = None
    tool_call_id: Optional[str] = None


class CompletionProxyRequest(BaseModel):
    model: str
    systemMessage: str
    messages: list[ChatMessage]
    tools: list[dict] = []
    passcode: str
    student_id: Optional[str] = None
    project_id: Optional[str] = None


class RunScriptRequest(BaseModel):
    script: str
    scriptType: str = "python"  # "python" or "shell"
    timeout: int = 10
    passcode: str
    student_id: str = Field(..., description="Student identifier; used as a directory component")
    project_id: str = Field(..., description="Project identifier; used as a directory component")


class RunScriptResponse(BaseModel):
    success: bool
    scriptDir: Optional[str] = None
    scriptPath: Optional[str] = None
    exitCode: Optional[int] = None
    stdout: Optional[str] = None
    stderr: Optional[str] = None
    timeout: bool = False
    message: Optional[str] = None
    createdFiles: Optional[list[str]] = None
    createdDirectories: Optional[list[str]] = None
    error: Optional[str] = None


class LogMessageRequest(BaseModel):
    passcode: str
    student_id: str
    project_id: str
    role: str  # "user" | "assistant"
    content: str
    timestamp: str  # ISO-8601 from client


class LogMessageResponse(BaseModel):
    success: bool
    error: Optional[str] = None


class ChatLogMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str
    timestamp: str


class StartSessionRequest(BaseModel):
    passcode: str
    student_id: str
    project_id: str


class StartSessionResponse(BaseModel):
    success: bool
    first_visit: bool = False
    resumed: bool = False
    session_start: str = ""
    project_description: str = ""
    pi: str = ""
    student_repo_url: Optional[str] = None
    cumulative_report: str = ""
    last_session_summary: str = ""
    coach_style_notes: str = ""
    chat_log: list[ChatLogMessage] = []
    coach_model: str = ""
    error: Optional[str] = None


class EndSessionRequest(BaseModel):
    passcode: str
    student_id: str
    project_id: str
    pi: str
    session_start: str
    session_end: str
    abrupt: bool = False


class EndSessionResponse(BaseModel):
    status: str  # "recorded" | "already_recorded" | "recorder_failed" | "queued_retry"
    commit_sha: Optional[str] = None
    error: Optional[str] = None


def validate_passcode(passcode: str) -> bool:
    return passcode == SERVER_PASSCODE


def validate_id(value: str, field_name: str) -> None:
    """Raise HTTPException(400) if value is not a safe path component."""
    if not ID_PATTERN.match(value):
        raise HTTPException(
            status_code=400,
            detail=(
                f"Invalid {field_name}: must match {ID_PATTERN.pattern} "
                "(letters, digits, dash, underscore; 1-64 chars)"
            ),
        )


def is_safe_path(base_dir: Path, requested_path: str) -> bool:
    """Check that requested_path resolves inside base_dir (prevent traversal)."""
    try:
        base = base_dir.resolve()
        target = (base / requested_path).resolve()
        return target.is_relative_to(base)
    except (ValueError, OSError):
        return False


def get_session_dir(student_id: str, project_id: str) -> Path:
    """
    Return the per-session working directory for a (student_id, project_id) pair.
    Layout: <SERVER_WORKING_DIR>/workspaces/<student_id>/<project_id>/
    Validates IDs and ensures the directory is created and within the root.
    """
    assert SERVER_WORKING_DIR is not None
    validate_id(student_id, "student_id")
    validate_id(project_id, "project_id")

    session_dir = SERVER_WORKING_DIR / "workspaces" / student_id / project_id
    if not is_safe_path(SERVER_WORKING_DIR, f"workspaces/{student_id}/{project_id}"):
        raise HTTPException(status_code=400, detail="Invalid session directory path")
    session_dir.mkdir(parents=True, exist_ok=True)
    return session_dir


def _session_dir(student_id: str, project_id: str) -> Path:
    """Path-only variant of get_session_dir that does not create directories."""
    assert SERVER_WORKING_DIR is not None
    return SERVER_WORKING_DIR / "workspaces" / student_id / project_id


def _get_session_lock(student_id: str, project_id: str) -> asyncio.Lock:
    key = (student_id, project_id)
    if key not in _session_locks:
        _session_locks[key] = asyncio.Lock()
    return _session_locks[key]


def _build_safe_env() -> dict[str, str]:
    """Return a sanitized environment dict for subprocess execution.

    Strips secrets like OPENROUTER_API_KEY from inheritance while keeping the
    minimal set of variables student scripts typically need.
    """
    out: dict[str, str] = {}
    for k, v in os.environ.items():
        if k in _SAFE_ENV_KEYS or any(k.startswith(p) for p in _SAFE_ENV_PREFIXES):
            out[k] = v
    return out


def _touch_active_session(session_dir: Path) -> None:
    """Update last_activity if active-session.json exists; no-op otherwise."""
    path = session_dir / "active-session.json"
    if not path.exists():
        return
    try:
        data = json.loads(path.read_text())
        data["last_activity"] = datetime.now(timezone.utc).isoformat()
        path.write_text(json.dumps(data))
    except (json.JSONDecodeError, OSError):
        return


def _count_assistant_messages(log_path: Path) -> int:
    if not log_path.exists():
        return 0
    count = 0
    try:
        with open(log_path, "r", encoding="utf-8") as f:
            for line in f:
                if '"role": "assistant"' in line or '"role":"assistant"' in line:
                    count += 1
    except OSError:
        return 0
    return count


# Phase 1 stubs; real implementations live in recorder.py and are wired below
# under the lazy-import helpers _maybe_run_fast_evaluator etc. We keep the
# stubs at module load time so server.py is importable without recorder.py.
async def _stub_fast_eval(student_id: str, project_id: str) -> None:
    return


async def _stub_deep_eval(student_id: str, project_id: str, full_rewrite: bool = False) -> None:
    return


async def run_fast_evaluator(student_id: str, project_id: str) -> None:
    """Run the fast evaluator. Imports recorder lazily so stubs work in tests."""
    try:
        from . import recorder
    except ImportError:
        return await _stub_fast_eval(student_id, project_id)
    return await recorder.run_fast_evaluator(student_id, project_id)


async def run_deep_evaluator(
    student_id: str, project_id: str, full_rewrite: bool = False, already_locked: bool = False
) -> None:
    """Run the deep evaluator. Imports recorder lazily so stubs work in tests."""
    try:
        from . import recorder
    except ImportError:
        return await _stub_deep_eval(student_id, project_id, full_rewrite)
    return await recorder.run_deep_evaluator(
        student_id, project_id, full_rewrite=full_rewrite, already_locked=already_locked
    )


async def run_recorder(
    student_id: str,
    project_id: str,
    pi: str,
    session_start: str,
    session_end: str,
    abrupt: bool,
) -> dict:
    """Run the recorder. Imports recorder module lazily."""
    from . import recorder
    return await recorder.run_recorder(
        student_id=student_id,
        project_id=project_id,
        pi=pi,
        session_start=session_start,
        session_end=session_end,
        abrupt=abrupt,
    )


async def _auto_end_after(timeout: float, student_id: str, project_id: str) -> None:
    """Inactivity-timer task. Sleeps for timeout, then fires the recorder if
    the session is still active."""
    try:
        await asyncio.sleep(timeout)
    except asyncio.CancelledError:
        return

    session_dir = _session_dir(student_id, project_id)
    active_path = session_dir / "active-session.json"
    if not active_path.exists():
        return

    try:
        active = json.loads(active_path.read_text())
    except (json.JSONDecodeError, OSError):
        return

    session_start = active.get("session_start")
    pi = active.get("pi")
    if not (session_start and pi):
        return

    if (session_dir / "sessions" / session_start).exists():
        return

    try:
        await run_recorder(
            student_id=student_id,
            project_id=project_id,
            pi=pi,
            session_start=session_start,
            session_end=datetime.now(timezone.utc).isoformat(),
            abrupt=True,
        )
    except Exception as e:
        logger.error(f"Inactivity-timer recorder failed for {student_id}/{project_id}: {e}")


async def run_script_with_timeout(
    script_path: Path, timeout_seconds: int, cwd: Path, script_type: str = "python"
) -> tuple[int, str, str, bool]:
    """
    Execute a script with a timeout.
    Returns: (exit_code, stdout, stderr, timed_out)
    """
    try:
        if script_type == "python":
            cmd = [sys.executable, str(script_path)]
        elif script_type == "shell":
            cmd = ["/bin/bash", str(script_path)]
        else:
            return -1, "", f"Unsupported script type: {script_type}", False

        process = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=str(cwd),
            env=_build_safe_env(),
        )

        try:
            stdout_bytes, stderr_bytes = await asyncio.wait_for(
                process.communicate(), timeout=timeout_seconds
            )
            stdout = stdout_bytes.decode("utf-8", errors="replace")
            stderr = stderr_bytes.decode("utf-8", errors="replace")
            return process.returncode or 0, stdout, stderr, False
        except asyncio.TimeoutError:
            process.kill()
            await process.wait()
            return -1, "", "Script execution timed out", True

    except Exception as e:
        return -1, "", f"Error executing script: {str(e)}", False


def get_files_in_directory(directory: Path) -> set[str]:
    try:
        return {f.name for f in directory.iterdir() if f.is_file()}
    except Exception:
        return set()


def get_directories_in_directory(directory: Path) -> set[str]:
    try:
        return {f.name for f in directory.iterdir() if f.is_dir()}
    except Exception:
        return set()


@app.post("/api/run-script", response_model=RunScriptResponse)
async def run_script(request: RunScriptRequest):
    """Execute a script in <working-dir>/workspaces/<student_id>/<project_id>/tmp/<timestamp>/."""

    if not validate_passcode(request.passcode):
        raise HTTPException(status_code=401, detail="Invalid passcode")

    if request.scriptType not in ["python", "shell"]:
        return RunScriptResponse(
            success=False, error="scriptType must be 'python' or 'shell'"
        )

    if request.timeout < 1 or request.timeout > 60:
        return RunScriptResponse(
            success=False, error="Timeout must be between 1 and 60 seconds"
        )

    if not request.script.strip():
        return RunScriptResponse(success=False, error="Script content is required")

    # Resolve per-session directory (validates IDs)
    session_dir = get_session_dir(request.student_id, request.project_id)

    # Build a timestamped script directory inside the session's tmp folder
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    tmp_dir = session_dir / "tmp"
    tmp_dir.mkdir(exist_ok=True)
    script_dir = tmp_dir / timestamp
    script_dir.mkdir(exist_ok=True)

    # Paths returned to the client are relative to the session_dir so the frontend
    # can hit them via /files/<student_id>/<project_id>/<rel_path>.
    script_dir_rel = script_dir.relative_to(session_dir)
    script_filename = "script.py" if request.scriptType == "python" else "script.sh"
    script_path = script_dir / script_filename
    script_path_rel = script_path.relative_to(session_dir)

    try:
        script_path.write_text(request.script, encoding="utf-8")
        if request.scriptType == "shell":
            script_path.chmod(0o755)

        files_before = get_files_in_directory(script_dir)
        directories_before = get_directories_in_directory(script_dir)

        exit_code, stdout, stderr, timed_out = await run_script_with_timeout(
            script_path, request.timeout, script_dir, request.scriptType
        )

        files_after = get_files_in_directory(script_dir)
        directories_after = get_directories_in_directory(script_dir)
        created_files = sorted(files_after - files_before)
        created_directories = sorted(directories_after - directories_before)

        if timed_out:
            message = f"Script execution timed out after {request.timeout} seconds"
        elif exit_code == 0:
            message = "Script executed successfully"
        else:
            message = f"Script exited with code {exit_code}"

        return RunScriptResponse(
            success=True,
            scriptDir=str(script_dir_rel),
            scriptPath=str(script_path_rel),
            exitCode=exit_code,
            stdout=stdout,
            stderr=stderr,
            timeout=timed_out,
            message=message,
            createdFiles=created_files,
            createdDirectories=created_directories,
        )

    except Exception as e:
        return RunScriptResponse(
            success=False, error=f"Failed to execute script: {str(e)}"
        )


def _resolve_session_file(student_id: str, project_id: str, file_path: str) -> Path:
    """Validate IDs and return the absolute path of <session_dir>/<file_path>, ensuring containment."""
    session_dir = get_session_dir(student_id, project_id)
    if not is_safe_path(session_dir, file_path):
        raise HTTPException(
            status_code=400,
            detail="Invalid path: must be within the student/project session directory",
        )
    full_path = session_dir / file_path
    if not full_path.exists():
        raise HTTPException(status_code=404, detail="File not found")
    if not full_path.is_file():
        raise HTTPException(status_code=400, detail="Path is not a file")
    return full_path


@app.head("/files/{student_id}/{project_id}/{file_path:path}")
async def head_file(student_id: str, project_id: str, file_path: str):
    """HEAD request for a session-scoped file."""
    full_path = _resolve_session_file(student_id, project_id, file_path)
    file_size = full_path.stat().st_size
    return Response(
        status_code=200,
        headers={
            "Content-Length": str(file_size),
            "Accept-Ranges": "bytes",
        },
    )


@app.get("/files/{student_id}/{project_id}/{file_path:path}")
async def serve_file(student_id: str, project_id: str, file_path: str, request: Request):
    """Serve a session-scoped file with range request support."""
    full_path = _resolve_session_file(student_id, project_id, file_path)

    range_header = request.headers.get("Range")
    if range_header:
        try:
            range_match = range_header.replace("bytes=", "").split("-")
            start = int(range_match[0]) if range_match[0] else 0
            file_size = full_path.stat().st_size
            end = int(range_match[1]) if range_match[1] else file_size - 1

            with open(full_path, "rb") as f:
                f.seek(start)
                content = f.read(end - start + 1)

            return Response(
                content=content,
                status_code=206,
                headers={
                    "Content-Range": f"bytes {start}-{end}/{file_size}",
                    "Accept-Ranges": "bytes",
                    "Content-Length": str(len(content)),
                },
            )
        except (ValueError, IndexError):
            pass

    return FileResponse(full_path)


@app.post("/api/log-message", response_model=LogMessageResponse)
async def log_message(request: LogMessageRequest, background_tasks: BackgroundTasks):
    """Append one message to chat-log.jsonl, refresh inactivity timer, and
    trigger evaluators on the appropriate cadence.

    User-role messages launch the registered fast-eval task (which
    /api/completion will await).
    Assistant-role messages enqueue the deep evaluator as a background task.
    No-ops if active-session.json is missing (covers post-recorder closing
    messages and stray late events).
    """
    if not validate_passcode(request.passcode):
        raise HTTPException(status_code=401, detail="Invalid passcode")

    validate_id(request.student_id, "student_id")
    validate_id(request.project_id, "project_id")

    if request.role not in ("user", "assistant"):
        return LogMessageResponse(success=True)

    session_dir = get_session_dir(request.student_id, request.project_id)
    log_path = session_dir / "chat-log.jsonl"
    active_path = session_dir / "active-session.json"
    key = (request.student_id, request.project_id)

    async with _get_session_lock(request.student_id, request.project_id):
        if not active_path.exists():
            return LogMessageResponse(success=True)

        entry = {
            "timestamp": request.timestamp,
            "role": request.role,
            "content": request.content,
        }
        try:
            with open(log_path, "a", encoding="utf-8") as f:
                f.write(json.dumps(entry) + "\n")
        except OSError as e:
            logger.error(f"Failed to write chat-log.jsonl for {key}: {e}")
            return LogMessageResponse(success=False, error=str(e))

        _touch_active_session(session_dir)

        # Refresh inactivity timer
        prior_inactivity = _inactivity_tasks.get(key)
        if prior_inactivity is not None and not prior_inactivity.done():
            prior_inactivity.cancel()
        _inactivity_tasks[key] = asyncio.create_task(
            _auto_end_after(INACTIVITY_TIMEOUT_SECONDS, request.student_id, request.project_id)
        )

        if request.role == "user":
            prior_fast = _fast_eval_tasks.get(key)
            if prior_fast is not None and not prior_fast.done():
                prior_fast.cancel()
            _fast_eval_tasks[key] = asyncio.create_task(
                run_fast_evaluator(request.student_id, request.project_id)
            )

        if request.role == "assistant":
            count = _count_assistant_messages(log_path)
            if count > 0 and count % DEEP_EVAL_EVERY_N_ASSISTANT_TURNS == 0:
                full_rewrite = (count % DEEP_EVAL_FULL_REWRITE_EVERY_N == 0)
                background_tasks.add_task(
                    run_deep_evaluator,
                    request.student_id,
                    request.project_id,
                    full_rewrite=full_rewrite,
                )

    return LogMessageResponse(success=True)


def _maybe_load_live_deep_eval(
    student_id: Optional[str], project_id: Optional[str]
) -> Optional[str]:
    """Return current-deep-eval.md content iff it is at least as fresh as the
    most recent chat-log activity. Stale evals (mtime older than chat-log)
    are treated as absent."""
    if not (student_id and project_id):
        return None
    try:
        validate_id(student_id, "student_id")
        validate_id(project_id, "project_id")
    except HTTPException:
        return None
    session_dir = _session_dir(student_id, project_id)
    eval_path = session_dir / "current-deep-eval.md"
    log_path = session_dir / "chat-log.jsonl"
    if not eval_path.exists():
        return None
    if log_path.exists() and log_path.stat().st_mtime > eval_path.stat().st_mtime:
        return None
    try:
        return eval_path.read_text(encoding="utf-8")
    except OSError:
        return None


async def _maybe_await_and_load_fast_eval(
    student_id: Optional[str], project_id: Optional[str]
) -> tuple[Optional[str], float]:
    """Wait (up to budget) for the registered fast-eval task to complete, then
    read its output. Returns (content_or_none, elapsed_seconds).
    """
    start = time.monotonic()
    if not (student_id and project_id):
        return None, 0.0
    try:
        validate_id(student_id, "student_id")
        validate_id(project_id, "project_id")
    except HTTPException:
        return None, time.monotonic() - start

    key = (student_id, project_id)
    task = _fast_eval_tasks.get(key)
    if task is None:
        return None, time.monotonic() - start

    if not task.done():
        try:
            await asyncio.wait_for(asyncio.shield(task), timeout=FAST_EVAL_WAIT_BUDGET_SECONDS)
        except (asyncio.TimeoutError, asyncio.CancelledError, Exception):
            return None, time.monotonic() - start

    if not task.done() or task.cancelled() or task.exception() is not None:
        return None, time.monotonic() - start

    fast_path = _session_dir(student_id, project_id) / "current-fast-eval.md"
    if not fast_path.exists():
        return None, time.monotonic() - start
    try:
        return fast_path.read_text(encoding="utf-8"), time.monotonic() - start
    except OSError:
        return None, time.monotonic() - start


def _parse_openrouter_usage(buffer: str) -> Optional[dict]:
    """Parse the final SSE usage frame from a buffered OpenRouter stream.
    OpenRouter emits the usage on the last data: frame before [DONE].
    """
    last_usage: Optional[dict] = None
    for raw_line in buffer.splitlines():
        line = raw_line.strip()
        if not line.startswith("data:"):
            continue
        payload = line[len("data:"):].strip()
        if payload == "[DONE]" or not payload:
            continue
        try:
            obj = json.loads(payload)
        except json.JSONDecodeError:
            continue
        usage = obj.get("usage")
        if isinstance(usage, dict):
            last_usage = usage
    return last_usage


@app.post("/api/completion")
async def completion_proxy(body: CompletionProxyRequest, http_request: Request):
    """Stream LLM completions from OpenRouter, authenticated by passcode.

    The server holds the OpenRouter API key; the browser never sees it.
    Upstream errors are forwarded as HTTPExceptions so the client gets a
    meaningful status code rather than a silent empty stream.

    When `student_id` and `project_id` are present, the server awaits the
    in-flight fast-eval task (budget: FAST_EVAL_WAIT_BUDGET_SECONDS) and
    injects both `current-fast-eval.md` and `current-deep-eval.md` content
    into the system message under separate headers.
    """
    if not validate_passcode(body.passcode):
        raise HTTPException(status_code=403, detail="Invalid passcode")

    if not OPENROUTER_API_KEY:
        raise HTTPException(
            status_code=503,
            detail="OpenRouter API key not configured on this server",
        )

    # Defense-in-depth: student requests must use the configured coach model.
    # The QA replay endpoint is the only path that may override on a per-call
    # basis, and it bypasses this proxy entirely.
    if body.student_id and body.project_id and body.model != COACH_MODEL:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Coach model is locked to {COACH_MODEL}; received {body.model}. "
                "Refresh the page so the client picks up the server-configured model."
            ),
        )

    fast_eval, fast_eval_wait_seconds = await _maybe_await_and_load_fast_eval(
        body.student_id, body.project_id
    )
    deep_eval = _maybe_load_live_deep_eval(body.student_id, body.project_id)

    if body.student_id and body.project_id:
        logger.info(
            f"completion_eval_inject student={body.student_id} project={body.project_id} "
            f"fast_eval_wait_seconds={fast_eval_wait_seconds:.3f} "
            f"fast_eval_present={fast_eval is not None} "
            f"deep_eval_present={deep_eval is not None}"
        )

    # Compose the system message via the same helper used by the QA replay
    # endpoint, so the two paths can't drift.
    from . import pi_api
    system_message = pi_api.compose_coach_system_message(
        body.systemMessage, fast_eval, deep_eval
    )

    messages: list[dict] = [{"role": "system", "content": system_message}]
    messages += [m.model_dump(exclude_none=True) for m in body.messages]

    payload: dict = {
        "model": body.model,
        "messages": messages,
        "stream": True,
    }
    if body.tools:
        payload["tools"] = body.tools

    upstream_headers = {
        "Authorization": f"Bearer {OPENROUTER_API_KEY}",
        "Content-Type": "application/json",
        "HTTP-Referer": "https://airesearchcoach.org",
        "X-Title": "AI Research Coach",
    }

    timeout = httpx.Timeout(connect=10.0, read=None, write=10.0, pool=10.0)

    client = httpx.AsyncClient(timeout=timeout)
    upstream_request = client.build_request(
        "POST",
        "https://openrouter.ai/api/v1/chat/completions",
        json=payload,
        headers=upstream_headers,
    )
    response = await client.send(upstream_request, stream=True)

    if response.status_code != 200:
        error_body = await response.aread()
        await client.aclose()
        raise HTTPException(
            status_code=response.status_code,
            detail=error_body.decode("utf-8", errors="replace"),
        )

    log_kind = "coach"
    log_student = body.student_id
    log_project = body.project_id
    log_model = body.model

    async def generate():
        # Buffer the tail of the stream so we can find the final usage frame
        # without holding the whole response in memory.
        tail_buffer = ""
        max_tail = 8192
        client_disconnected = False
        try:
            async for chunk in response.aiter_bytes():
                if await http_request.is_disconnected():
                    client_disconnected = True
                    break
                yield chunk
                try:
                    text = chunk.decode("utf-8", errors="replace")
                except Exception:
                    text = ""
                tail_buffer = (tail_buffer + text)[-max_tail:]
        finally:
            await response.aclose()
            await client.aclose()

            if client_disconnected:
                logger.info(
                    f"usage_unavailable kind={log_kind} student={log_student} "
                    f"project={log_project} model={log_model} reason=client_disconnect"
                )
            else:
                usage = _parse_openrouter_usage(tail_buffer)
                if usage:
                    pt = usage.get("prompt_tokens")
                    ct = usage.get("completion_tokens")
                    logger.info(
                        f"usage kind={log_kind} student={log_student} project={log_project} "
                        f"model={log_model} prompt_tokens={pt} completion_tokens={ct}"
                    )
                else:
                    logger.info(
                        f"usage_unavailable kind={log_kind} student={log_student} "
                        f"project={log_project} model={log_model} reason=parse_failed"
                    )

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "X-Accel-Buffering": "no",
            "Cache-Control": "no-cache",
        },
    )


@app.post("/api/start-session", response_model=StartSessionResponse)
async def start_session(request: StartSessionRequest):
    """Start (or resume) a session. Replaces the old shell-script ceremony in
    instructions.md Steps 1-4.
    """
    from . import recorder
    if not validate_passcode(request.passcode):
        raise HTTPException(status_code=401, detail="Invalid passcode")

    validate_id(request.student_id, "student_id")
    validate_id(request.project_id, "project_id")

    # Resolve and pin the coach prompt SHA at session start (Phase A1). The
    # SHA is stored in active-session.json and copied into metadata.json at
    # session end, so QA replay can reproduce against the exact prompt
    # versions the coach actually used.
    prompts_sha = await recorder.resolve_prompts_sha()

    session_dir = get_session_dir(request.student_id, request.project_id)
    sessions_dir = session_dir / "sessions"
    sessions_dir.mkdir(parents=True, exist_ok=True)
    cumulative_path = session_dir / "cumulative-report.md"

    cumulative_existed = cumulative_path.exists()
    first_visit = not cumulative_existed

    if not cumulative_existed:
        cumulative_path.write_text(
            f"# Cumulative Report: {request.student_id} on {request.project_id}\n\n"
            "No sessions yet.\n"
        )

    project_md_url = (
        "https://raw.githubusercontent.com/csc-arc/research-projects/main/projects/"
        f"{request.project_id}/project.md"
    )
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            r = await client.get(project_md_url)
            if r.status_code != 200:
                return StartSessionResponse(
                    success=False,
                    error=(
                        f"Could not load project description for {request.project_id} "
                        f"(HTTP {r.status_code}) — verify the project ID or retry"
                    ),
                )
            project_md_text = r.text
            project_md_bytes = r.content
    except httpx.HTTPError as e:
        return StartSessionResponse(
            success=False,
            error=(
                f"Could not load project description for {request.project_id} "
                f"({e}) — verify the project ID or retry"
            ),
        )

    pi = ""
    student_repo_url: Optional[str] = None
    if project_md_text.startswith("---"):
        # YAML frontmatter
        end_idx = project_md_text.find("\n---", 3)
        if end_idx > 0:
            for line in project_md_text[3:end_idx].splitlines():
                line = line.strip()
                if line.startswith("pi:"):
                    pi = line.split(":", 1)[1].strip().strip("\"'")
                elif line.startswith("student_repo_url:"):
                    val = line.split(":", 1)[1].strip().strip("\"'")
                    if val and val.lower() != "null":
                        student_repo_url = val

    import hashlib
    project_description_sha = hashlib.sha256(project_md_bytes).hexdigest()[:16]

    if student_repo_url:
        try:
            target = session_dir / "student_repo"
            if target.exists():
                proc = await asyncio.create_subprocess_exec(
                    "git", "pull",
                    cwd=str(target),
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                    env=_build_safe_env(),
                )
                await asyncio.wait_for(proc.wait(), timeout=30)
            else:
                proc = await asyncio.create_subprocess_exec(
                    "git", "clone", student_repo_url, str(target),
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                    env=_build_safe_env(),
                )
                await asyncio.wait_for(proc.wait(), timeout=60)
        except Exception as e:
            logger.warning(f"student_repo clone/pull failed: {e}")

    async with _get_session_lock(request.student_id, request.project_id):
        active_path = session_dir / "active-session.json"

        session_start: str = ""
        resumed = False
        chat_log: list[ChatLogMessage] = []

        existing_session_start: Optional[str] = None
        if active_path.exists():
            try:
                active = json.loads(active_path.read_text())
                last_activity_str = active.get("last_activity")
                existing_session_start = active.get("session_start")
                if last_activity_str and existing_session_start:
                    last_activity = datetime.fromisoformat(last_activity_str)
                    age = (datetime.now(timezone.utc) - last_activity).total_seconds()
                    if age < RESUME_WINDOW_SECONDS:
                        # Re-check that the recorder didn't archive this session
                        if (sessions_dir / existing_session_start).exists():
                            existing_session_start = None
                        else:
                            session_start = existing_session_start
                            resumed = True
            except (json.JSONDecodeError, OSError, ValueError):
                pass

        if not session_start:
            session_start = datetime.now(timezone.utc).isoformat()
            resumed = False
            active_data = {
                "session_start": session_start,
                "pi": pi,
                "last_activity": datetime.now(timezone.utc).isoformat(),
                "project_description_sha": project_description_sha,
                "prompts_sha": prompts_sha,
                "models": {
                    "coach": COACH_MODEL,
                    "fast_eval": recorder.EVAL_MODEL,
                    "deep_eval": recorder.EVAL_MODEL,
                    "recorder": recorder.RECORDER_MODEL,
                },
            }
            active_path.write_text(json.dumps(active_data))
        else:
            try:
                active = json.loads(active_path.read_text())
                active["last_activity"] = datetime.now(timezone.utc).isoformat()
                active_path.write_text(json.dumps(active))
            except (json.JSONDecodeError, OSError):
                pass

        if resumed:
            log_path = session_dir / "chat-log.jsonl"
            if log_path.exists():
                try:
                    with open(log_path, "r", encoding="utf-8") as f:
                        for line in f:
                            line = line.strip()
                            if not line:
                                continue
                            try:
                                obj = json.loads(line)
                            except json.JSONDecodeError:
                                continue
                            role = obj.get("role")
                            if role not in ("user", "assistant"):
                                continue
                            chat_log.append(
                                ChatLogMessage(
                                    role=role,
                                    content=obj.get("content", ""),
                                    timestamp=obj.get("timestamp", ""),
                                )
                            )
                except OSError:
                    pass

    cumulative_report = ""
    try:
        cumulative_report = cumulative_path.read_text(encoding="utf-8")
    except OSError:
        pass

    last_session_summary = ""
    try:
        existing_sessions = sorted(
            [p for p in sessions_dir.iterdir() if p.is_dir() and not p.name.endswith(".tmp")]
        )
        if existing_sessions:
            summary_path = existing_sessions[-1] / "summary.md"
            if summary_path.exists():
                last_session_summary = summary_path.read_text(encoding="utf-8")
    except OSError:
        pass

    coach_style_notes = recorder.extract_coach_style_notes(cumulative_report)

    return StartSessionResponse(
        success=True,
        first_visit=first_visit,
        resumed=resumed,
        session_start=session_start,
        project_description=project_md_text,
        pi=pi,
        student_repo_url=student_repo_url,
        cumulative_report=cumulative_report,
        last_session_summary=last_session_summary,
        coach_style_notes=coach_style_notes,
        chat_log=chat_log,
        coach_model=COACH_MODEL,
    )


@app.post("/api/end-session", response_model=EndSessionResponse)
async def end_session(request: EndSessionRequest):
    """Run the recorder for an active session. Acquires the per-session lock to
    prevent racing with the inactivity-timer recorder."""
    if not validate_passcode(request.passcode):
        raise HTTPException(status_code=401, detail="Invalid passcode")

    validate_id(request.student_id, "student_id")
    validate_id(request.project_id, "project_id")

    async with _get_session_lock(request.student_id, request.project_id):
        try:
            result = await run_recorder(
                student_id=request.student_id,
                project_id=request.project_id,
                pi=request.pi,
                session_start=request.session_start,
                session_end=request.session_end,
                abrupt=request.abrupt,
            )
        except Exception as e:
            logger.error(f"end_session recorder failed: {e}")
            return EndSessionResponse(status="recorder_failed", error=str(e))

    return EndSessionResponse(
        status=result.get("status", "recorder_failed"),
        commit_sha=result.get("commit_sha"),
        error=result.get("error"),
    )


@app.on_event("startup")
async def _retry_unpushed_coach_sessions():
    """On startup, attempt a single git push on coach-sessions if there are
    committed-but-unpushed commits."""
    tracker = Path.home() / "coach-sessions"
    if not tracker.exists():
        return
    try:
        ahead = subprocess.run(
            ["git", "rev-list", "--count", "@{u}..HEAD"],
            cwd=str(tracker),
            capture_output=True,
            text=True,
            timeout=10,
        )
        if ahead.returncode == 0:
            count = int((ahead.stdout.strip() or "0"))
            if count > 0:
                logger.info(f"Retrying {count} unpushed coach-sessions commits")
                subprocess.run(["git", "push"], cwd=str(tracker), timeout=30, check=False)
    except (subprocess.SubprocessError, ValueError) as e:
        logger.warning(f"On-startup unpushed-commit retry failed: {e}")


@app.on_event("startup")
async def _recover_stale_sessions():
    """On startup, scan workspaces for stale active-session.json files and
    fire the recorder for any session that has been idle longer than the
    inactivity timeout. Also sweeps orphaned files next to a committed
    sessions/<ts>/ directory."""
    if SERVER_WORKING_DIR is None:
        return
    workspaces_root = SERVER_WORKING_DIR / "workspaces"
    if not workspaces_root.exists():
        return
    now = datetime.now(timezone.utc)
    try:
        glob_iter = list(workspaces_root.glob("*/*/active-session.json"))
    except OSError:
        return
    for active_path in glob_iter:
        try:
            active = json.loads(active_path.read_text())
            last_activity = datetime.fromisoformat(active["last_activity"])
            session_start = active["session_start"]
            pi = active.get("pi", "")
            student_id = active_path.parent.parent.name
            project_id = active_path.parent.name

            archive_dir = active_path.parent / "sessions" / session_start
            if archive_dir.exists():
                # Already recorded; sweep this orphan and any companions.
                _sweep_orphans(active_path.parent)
                continue

            if (now - last_activity).total_seconds() < INACTIVITY_TIMEOUT_SECONDS:
                continue

            logger.info(
                f"Recovering stale session {student_id}/{project_id}/{session_start}"
            )
            await run_recorder(
                student_id=student_id,
                project_id=project_id,
                pi=pi,
                session_start=session_start,
                session_end=now.isoformat(),
                abrupt=True,
            )
        except Exception as e:
            logger.warning(f"Stale-session recovery failed for {active_path}: {e}")


def _sweep_orphans(workspace_dir: Path) -> None:
    """Remove ephemeral state files left next to a committed sessions/<ts>/."""
    for fname in (
        "chat-log.jsonl",
        "current-deep-eval.md",
        "current-fast-eval.md",
        "fast-eval-turns.jsonl",
        "eval-state.json",
        "active-session.json",
    ):
        p = workspace_dir / fname
        if p.exists():
            try:
                p.unlink()
            except OSError:
                pass


@app.get("/health")
async def health_check():
    """Health check endpoint."""
    return {
        "status": "ok",
        "workingDir": str(SERVER_WORKING_DIR),
        "service": "ai-research-coach",
    }


def _install_cors(extra_origins: Optional[list[str]] = None) -> None:
    """(Re)install the CORS middleware with the configured allowlist.

    Note: FastAPI doesn't support removing middleware after the app is built, so this
    must be called exactly once before serving (which is what run_server() does).
    """
    origins = list(DEFAULT_CORS_ORIGINS)
    if extra_origins:
        origins.extend(extra_origins)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )


def create_app(
    working_dir: Path,
    passcode: str,
    extra_origins: Optional[list[str]] = None,
    openrouter_api_key: Optional[str] = None,
) -> FastAPI:
    """Configure and return the FastAPI app (used by tests / programmatic embedding)."""
    global SERVER_WORKING_DIR, SERVER_PASSCODE, OPENROUTER_API_KEY
    SERVER_WORKING_DIR = working_dir
    SERVER_PASSCODE = passcode
    OPENROUTER_API_KEY = openrouter_api_key
    _install_cors(extra_origins)
    _mount_pi_router_once()
    return app


def run_server(
    working_dir: Path,
    host: str = "127.0.0.1",
    port: int = 3339,
    passcode: str = "",
    extra_origins: Optional[list[str]] = None,
    openrouter_api_key: Optional[str] = None,
):
    """Run the server with uvicorn."""
    global SERVER_WORKING_DIR, SERVER_PASSCODE, OPENROUTER_API_KEY
    SERVER_WORKING_DIR = working_dir
    SERVER_PASSCODE = passcode
    OPENROUTER_API_KEY = openrouter_api_key
    _install_cors(extra_origins)
    _mount_pi_router_once()

    import uvicorn

    logging.basicConfig(level=logging.INFO)

    uvicorn.run(app, host=host, port=port)
