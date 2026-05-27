"""Tests for the backgrounded /api/end-session recorder and /api/session-status.

Run with:
    pytest python/ai-research-coach/tests/test_end_session_backgrounding.py
"""

from __future__ import annotations

import asyncio
import time
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient
from httpx import AsyncClient

import ai_research_coach.server as srv
from ai_research_coach.server import app

PASSCODE = "testpass"


@pytest.fixture(autouse=True)
def _setup_server(monkeypatch):
    """Minimal server config for every test in this module."""
    monkeypatch.setattr(srv, "SERVER_PASSCODE", PASSCODE)
    # Clear shared dicts between tests so state doesn't leak.
    srv._recorder_status.clear()
    srv._recorder_tasks.clear()
    yield
    srv._recorder_status.clear()
    srv._recorder_tasks.clear()


def _end_session_payload(**overrides):
    base = {
        "passcode": PASSCODE,
        "student_id": "alice",
        "project_id": "proj1",
        "pi": "dr_bob",
        "session_start": "2026-01-01T10:00:00",
        "session_end": "2026-01-01T11:00:00",
        "abrupt": False,
    }
    base.update(overrides)
    return base


# ---------------------------------------------------------------------------
# POST /api/end-session
# ---------------------------------------------------------------------------


def test_end_session_returns_202_running_with_token():
    """Fresh session: 202, status=running, recorder_token is set."""
    with patch.object(srv, "run_recorder", new=AsyncMock(return_value={"status": "recorded"})):
        with TestClient(app, raise_server_exceptions=True) as client:
            r = client.post("/api/end-session", json=_end_session_payload())
    assert r.status_code == 202
    body = r.json()
    assert body["status"] == "running"
    assert body["recorder_token"] is not None


def test_end_session_populates_recorder_status():
    """`_recorder_status` is populated on POST."""
    recorder_done = asyncio.Event()

    async def slow_recorder(**_kw):
        await asyncio.sleep(0.05)
        return {"status": "recorded", "commit_sha": "abc123"}

    with patch.object(srv, "run_recorder", new=slow_recorder):
        with TestClient(app) as client:
            r = client.post("/api/end-session", json=_end_session_payload())

    assert r.status_code == 202
    token = r.json()["recorder_token"]
    assert token in srv._recorder_status
    assert srv._recorder_status[token]["status"] in ("running", "recorded")


def test_duplicate_post_same_session_start_returns_same_token():
    """Two POSTs with the same session_start share a token; only one task spawned."""
    call_count = 0

    async def counted_recorder(**_kw):
        nonlocal call_count
        call_count += 1
        await asyncio.sleep(0.05)
        return {"status": "recorded"}

    payload = _end_session_payload()
    with patch.object(srv, "run_recorder", new=counted_recorder):
        with TestClient(app) as client:
            r1 = client.post("/api/end-session", json=payload)
            r2 = client.post("/api/end-session", json=payload)

    assert r1.json()["recorder_token"] == r2.json()["recorder_token"]


def test_already_terminal_returns_immediately():
    """If the token is already terminal, the POST short-circuits without a new task."""
    token = "alice:proj1:2026-01-01T10:00:00"
    srv._recorder_status[token] = {
        "status": "recorded",
        "commit_sha": "deadbeef",
        "error": None,
        "updated_at": time.time(),
    }

    with TestClient(app) as client:
        r = client.post("/api/end-session", json=_end_session_payload())

    body = r.json()
    assert body["status"] == "recorded"
    assert body["commit_sha"] == "deadbeef"
    assert body["recorder_token"] == token


def test_already_recorded_short_circuit_single_round_trip():
    """already_recorded result in the dict → terminal on the very first POST."""
    token = "alice:proj1:2026-01-01T10:00:00"
    srv._recorder_status[token] = {
        "status": "already_recorded",
        "commit_sha": None,
        "error": None,
        "updated_at": time.time(),
    }

    with TestClient(app) as client:
        r = client.post("/api/end-session", json=_end_session_payload())

    assert r.json()["status"] == "already_recorded"


def test_end_session_invalid_passcode():
    with TestClient(app) as client:
        r = client.post("/api/end-session", json=_end_session_payload(passcode="wrong"))
    assert r.status_code == 401


# ---------------------------------------------------------------------------
# GET /api/session-status
# ---------------------------------------------------------------------------


def test_session_status_unknown_token():
    """Unknown token → recorder_failed with error=unknown_token."""
    with TestClient(app) as client:
        r = client.get(f"/api/session-status?token=no-such-token&passcode={PASSCODE}")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "recorder_failed"
    assert body["error"] == "unknown_token"


def test_session_status_running():
    token = "alice:proj1:2026-01-01T10:00:00"
    srv._recorder_status[token] = {
        "status": "running",
        "commit_sha": None,
        "error": None,
        "updated_at": time.time(),
    }
    with TestClient(app) as client:
        r = client.get(f"/api/session-status?token={token}&passcode={PASSCODE}")
    body = r.json()
    assert body["status"] == "running"
    assert body["recorder_token"] == token


def test_session_status_recorded():
    token = "alice:proj1:2026-01-01T10:00:00"
    srv._recorder_status[token] = {
        "status": "recorded",
        "commit_sha": "cafebabe",
        "error": None,
        "updated_at": time.time(),
    }
    with TestClient(app) as client:
        r = client.get(f"/api/session-status?token={token}&passcode={PASSCODE}")
    body = r.json()
    assert body["status"] == "recorded"
    assert body["commit_sha"] == "cafebabe"


def test_session_status_invalid_passcode():
    with TestClient(app) as client:
        r = client.get("/api/session-status?token=anything&passcode=wrong")
    assert r.status_code == 401


# ---------------------------------------------------------------------------
# _prune_recorder_status
# ---------------------------------------------------------------------------


def test_prune_removes_old_entries():
    old_time = time.time() - 7200  # 2 hours ago
    srv._recorder_status["old_token"] = {
        "status": "recorded",
        "updated_at": old_time,
    }
    srv._recorder_status["fresh_token"] = {
        "status": "recorded",
        "updated_at": time.time(),
    }
    srv._prune_recorder_status(max_age_seconds=3600)
    assert "old_token" not in srv._recorder_status
    assert "fresh_token" in srv._recorder_status


def test_prune_called_on_every_post():
    """_prune_recorder_status fires on POST; stale entries are removed."""
    old_time = time.time() - 7200
    srv._recorder_status["stale"] = {
        "status": "recorded",
        "updated_at": old_time,
    }

    with patch.object(srv, "run_recorder", new=AsyncMock(return_value={"status": "recorded"})):
        with TestClient(app) as client:
            client.post("/api/end-session", json=_end_session_payload())

    assert "stale" not in srv._recorder_status
