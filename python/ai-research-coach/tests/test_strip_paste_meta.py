"""Regression tests for `recorder._strip_paste_meta`.

This is the single piece of code that keeps the v1 "no LLM behavior
change" invariant of `notes/dev-0526/plans/paste-detection-plan.md` true.
If it ever stops stripping paste-detection fields from the transcript
sent to the recorder LLM, the model will see signal it wasn't trained
to use, breaking the invariant silently.

Run with:

    pytest python/ai-research-coach/tests/test_strip_paste_meta.py
"""

from __future__ import annotations

import json

from ai_research_coach.recorder import _strip_paste_meta
from ai_research_coach.server import PASTE_META_FIELDS


def _to_jsonl(rows: list[dict]) -> str:
    return "\n".join(json.dumps(r) for r in rows)


def _parse_jsonl(text: str) -> list[dict]:
    return [json.loads(line) for line in text.splitlines() if line.strip()]


def test_strips_paste_fields_when_present() -> None:
    rows = [
        {
            "timestamp": "2026-05-26T20:00:00Z",
            "role": "user",
            "content": "hello",
            "paste_event_count": 2,
            "paste_char_count": 200,
            "final_char_count": 250,
        },
        {
            "timestamp": "2026-05-26T20:00:05Z",
            "role": "assistant",
            "content": "hi there",
        },
    ]
    out = _strip_paste_meta(_to_jsonl(rows))
    parsed = _parse_jsonl(out)
    assert len(parsed) == 2
    for field in PASTE_META_FIELDS:
        assert field not in parsed[0], f"{field} should be stripped from user row"
        assert field not in parsed[1]
    # Non-paste fields are preserved.
    assert parsed[0]["content"] == "hello"
    assert parsed[0]["role"] == "user"
    assert parsed[0]["timestamp"] == "2026-05-26T20:00:00Z"
    assert parsed[1]["content"] == "hi there"


def test_passthrough_when_no_paste_fields() -> None:
    rows = [
        {"timestamp": "2026-05-26T20:00:00Z", "role": "user", "content": "hello"},
        {"timestamp": "2026-05-26T20:00:05Z", "role": "assistant", "content": "hi"},
    ]
    input_text = _to_jsonl(rows)
    out = _strip_paste_meta(input_text)
    # Re-parse both sides — direct byte equality is not promised across
    # json.dumps round-trips (e.g. key ordering for non-roundtrippable
    # inputs), but the content must match exactly.
    assert _parse_jsonl(out) == rows


def test_mixed_transcript_strips_only_where_present() -> None:
    rows = [
        {
            "timestamp": "t1",
            "role": "user",
            "content": "first",
            "paste_event_count": 1,
            "paste_char_count": 42,
            "final_char_count": 50,
        },
        {"timestamp": "t2", "role": "assistant", "content": "ok"},
        {"timestamp": "t3", "role": "user", "content": "second (typed only)"},
    ]
    parsed = _parse_jsonl(_strip_paste_meta(_to_jsonl(rows)))
    assert len(parsed) == 3
    # First row: paste fields gone, everything else intact.
    assert "paste_event_count" not in parsed[0]
    assert parsed[0]["content"] == "first"
    # Second & third: unchanged.
    assert parsed[1] == {"timestamp": "t2", "role": "assistant", "content": "ok"}
    assert parsed[2] == {
        "timestamp": "t3",
        "role": "user",
        "content": "second (typed only)",
    }


def test_invalid_json_lines_pass_through_unchanged() -> None:
    # Defensive: a corrupted transcript line must not poison the whole
    # prompt. The recorder should see the raw garbage line and decide
    # what to do.
    input_text = "\n".join(
        [
            json.dumps({"role": "user", "content": "hi", "paste_event_count": 3}),
            "not valid json {{{",
            json.dumps({"role": "assistant", "content": "ok"}),
        ]
    )
    out = _strip_paste_meta(input_text).splitlines()
    assert len(out) == 3
    # First line: stripped.
    assert "paste_event_count" not in json.loads(out[0])
    # Second line: untouched.
    assert out[1] == "not valid json {{{"
    # Third line: untouched.
    assert json.loads(out[2]) == {"role": "assistant", "content": "ok"}


def test_blank_lines_are_dropped() -> None:
    # `splitlines()` then skip-on-empty is what the helper does; confirm
    # blank lines (from trailing newlines, etc.) don't introduce empty
    # JSONL rows.
    input_text = (
        json.dumps({"role": "user", "content": "hi"})
        + "\n\n"
        + json.dumps({"role": "assistant", "content": "ok"})
        + "\n"
    )
    parsed = _parse_jsonl(_strip_paste_meta(input_text))
    assert len(parsed) == 2
