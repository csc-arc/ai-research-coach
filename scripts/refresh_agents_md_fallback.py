#!/usr/bin/env python3
"""Regenerate `_agents_md_fallback.py` from the live `public/AGENTS.md`.

Run this whenever `public/AGENTS.md` is materially edited so the offline
fallback used by `pi_drafts._build_system_prompt` doesn't drift. CI fails
the build when the constant has drifted >50 lines from the live file.

Usage:
    python scripts/refresh_agents_md_fallback.py

The script is idempotent — safe to re-run.
"""

from __future__ import annotations

import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent.parent
LIVE_PATH = REPO_ROOT / "public" / "AGENTS.md"
FALLBACK_PATH = (
    REPO_ROOT
    / "python"
    / "ai-research-coach"
    / "ai_research_coach"
    / "_agents_md_fallback.py"
)

HEADER = '''\
"""Frozen offline copy of `public/AGENTS.md`.

This constant is used by `pi_drafts._build_system_prompt` when the live fetch
of the canonical AGENTS.md from GitHub fails (network down, rate-limit, 5xx).
Synthesis must keep working end-to-end during a GitHub outage even if the
editing guide it references is slightly stale.

To refresh: run `python scripts/refresh_agents_md_fallback.py` from the
`ai-research-coach/` repo root, then commit the result. CI fails the build
when this constant has drifted >50 lines from `public/AGENTS.md`.
"""

AGENTS_MD_FALLBACK = """\\
'''


def main() -> int:
    if not LIVE_PATH.exists():
        print(f"ERROR: {LIVE_PATH} not found", file=sys.stderr)
        return 2
    text = LIVE_PATH.read_text(encoding="utf-8")
    # Escape any triple-quote sequences so the constant is a valid Python
    # string. AGENTS.md doesn't currently contain `"""`, but this keeps the
    # script safe if someone adds one later.
    escaped = text.replace('"""', '\\"\\"\\"')
    body = HEADER + escaped + '"""\n'
    FALLBACK_PATH.write_text(body, encoding="utf-8")
    live_lines = len(text.splitlines())
    print(f"Wrote {FALLBACK_PATH} ({live_lines} lines from public/AGENTS.md).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
