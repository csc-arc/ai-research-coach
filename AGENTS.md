# AI Research Coach — Agent Context

## Repository layout

| Path | Purpose |
|---|---|
| `src/` | React/Vite frontend |
| `python/ai-research-coach/` | FastAPI backend (`server.py`, `recorder.py`) |
| `public/` | Static assets served at build time — **this is where the agent prompts live** |
| `scripts/` | Ops utilities (e.g. `clear-workspace.sh`) |

## The agent prompt system

The system is built around four prompts in `public/`. Each one drives one agent in the two-agent pipeline:

| File | Agent | When it runs |
|---|---|---|
| `public/coach-instructions.md` | **Coach** — the browser-side LLM the student talks to | Every turn; injected as system prompt |
| `public/fast-eval-prompt.md` | **Fast evaluator** — tactical turn-by-turn signal | After every user message, before coach responds |
| `public/deep-eval-prompt.md` | **Deep evaluator** — session-long running picture | After every assistant message (incremental) and at session end (full) |
| `public/recorder-prompt.md` | **Recorder** — end-of-session archiver | Once, at session end |

See `public/AGENTS.md` for detailed guidance on how to read and update each prompt.

## PI feedback → prompt updates

The primary mechanism for improving coach behavior is the feedback loop:

1. **PI observes** behavior through session transcripts and summaries in `coach-sessions/`
   (`coach-sessions/<pi>/<project_id>/<student_id>/sessions/<ts>/summary.md` and `evaluation.md`)
2. **PI provides feedback** — either freeform notes or specific complaints about coach behavior
3. **Developer updates prompts** in `public/` following the guidance in `public/AGENTS.md`
4. **Changes take effect** on the next session: the server fetches prompts from `main` on GitHub with a short TTL cache

**No backend redeploy is needed for prompt-only changes.** Prompt files are fetched at runtime from GitHub. Committing to `main` propagates within ~5 minutes.

## Notes files for ongoing feedback

The `notes/` directory in the workspace root (`ai-coach/notes/`) contains running logs relevant to prompt development:

- `notes/coach-behavior-notes.md` — observed behavior patterns with suggested improvements; see workspace `AGENTS.md` for entry format
- `notes/ux-notes.md` — UX decisions and open recommendations

When a PI reports a behavior issue, capture it in `notes/coach-behavior-notes.md` first, then translate it into a prompt change.
