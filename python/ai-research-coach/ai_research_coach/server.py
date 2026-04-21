"""FastAPI server for executing student/project-scoped Python and shell scripts."""

import asyncio
import re
import sys
from datetime import datetime
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel, Field

# Mutable globals populated by run_server() / create_app()
SERVER_PASSCODE: Optional[str] = None
SERVER_WORKING_DIR: Optional[Path] = None

# student_id and project_id must be safe path components.
# Allow letters, digits, dash, underscore. Length 1..64.
ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

# Default CORS origins. Extra origins can be added via --allow-origin on the CLI.
DEFAULT_CORS_ORIGINS = [
    "http://localhost:5173",
    "https://arc-csc.github.io",
]

app = FastAPI(title="AI Research Coach Script Execution Server")


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
) -> FastAPI:
    """Configure and return the FastAPI app (used by tests / programmatic embedding)."""
    global SERVER_WORKING_DIR, SERVER_PASSCODE
    SERVER_WORKING_DIR = working_dir
    SERVER_PASSCODE = passcode
    _install_cors(extra_origins)
    return app


def run_server(
    working_dir: Path,
    host: str = "127.0.0.1",
    port: int = 3339,
    passcode: str = "",
    extra_origins: Optional[list[str]] = None,
):
    """Run the server with uvicorn."""
    global SERVER_WORKING_DIR, SERVER_PASSCODE
    SERVER_WORKING_DIR = working_dir
    SERVER_PASSCODE = passcode
    _install_cors(extra_origins)

    import uvicorn

    uvicorn.run(app, host=host, port=port)
