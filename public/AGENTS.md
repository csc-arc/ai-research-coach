# Agent Prompts — Developer Guide

This directory contains the four prompts that drive the two-agent coaching pipeline. This document explains what each prompt does, how they relate to each other, and how to update them in response to PI feedback.

## Prompt overview

### `instructions-v1.md` — The Coach

The coach is the browser-side LLM the student talks to. Its prompt is:

- **Injected as the system prompt** for every student turn
- **Augmented at runtime** with live evaluation content: the fast evaluator's output appears under `## Live evaluation (this turn)` and the deep evaluator's output under `## Live evaluation (running)`
- **Parameterized** with session-derived values (`${student_id}`, `${project_id}`, `${pi}`, `${first_visit}`, `${project_description}`, `${cumulative_report}`, `${last_session_summary}`, `${coach_style_notes}`)

The coach prompt has three distinct concerns. Keep them separate when editing:

1. **Behavior rules** (`# Behavior rules — first-class`): hard constraints that must hold every turn regardless of context. These are the highest-leverage levers for fixing systematic coach failures. Change these when PI feedback reveals a pattern the coach is consistently getting wrong.

2. **Personality modes** (`# Personality Modes`): how the coach should behave in different phases (Get to Know You, Lecturer, Socratic, Evaluator). Change these when PI feedback is about *when* the coach changes approach or *how* it behaves within a mode.

3. **Live evaluation usage** (Rule 4 in behavior rules): instructions to the coach on how to use the fast and deep eval signals. Change this only if the eval signal format changes or the coach is systematically misusing or ignoring the evals.

### `fast-eval-prompt.md` — The Fast Evaluator

The fast evaluator runs synchronously after each student message, before the coach responds. It outputs a brief tactical correction signal (`current-fast-eval.md`) that the coach reads on the next turn.

Key constraints to maintain when editing:

- **Stay brief**: it runs blocking inside the coach's latency budget (a few seconds). Do not add new output fields that require more reasoning.
- **Use the shared `coach_issues` enum**: the category strings are shared with the deep evaluator so flags can be aggregated. If you add a new category, add it to both evaluators and to the enum in `recorder.py` (`COACH_ISSUE_RECURRENCE_CATEGORIES`).
- **Keep it context-light by design**: the fast eval deliberately does not see the full transcript or the deep eval's output. Resist the temptation to give it more context — that's the deep eval's job.

Change this prompt when PI feedback is about the coach making the same mistake on a single turn repeatedly (e.g., always affirming wrong answers, never asking diagnostic questions after IDK).

### `deep-eval-prompt.md` — The Deep Evaluator

The deep evaluator runs after each assistant message (incremental mode) and at session end (full mode). It maintains a session-long running picture (`current-deep-eval.md`) that the coach reads each turn and that the recorder consumes at session end. Its output is also archived as `evaluation.md` in `coach-sessions/`.

Key constraints to maintain when editing:

- **Output format must be stable**: the recorder reads `current-deep-eval.md` and the coach reads it. If you change what the `submit_evaluation` tool schema produces, update how the coach prompt references it (Rule 4) and how `recorder.py` extracts `coach_style_notes` from it (`extract_coach_style_notes` function).
- **PI-readable prose**: the deep eval is archived and visible to PIs. It should be written for a human reader, not as internal monologue.
- **Use the shared `coach_issues` enum**: same constraint as the fast eval.

Change this prompt when PI feedback is about the coach repeating the same mistake across a session (pattern failure rather than single-turn failure), or when the session summaries and evaluations in `coach-sessions/` are not capturing the right information.

### `recorder-prompt.md` — The Recorder

The recorder runs once at session end. It produces three artifacts: `summary.md` (PI-readable session narrative), `metadata.json` (structured data for dashboards), and an updated `cumulative-report.md` (cross-session picture).

Key constraints to maintain when editing:

- **`summary.md` schema**: must begin with `# Session Summary:`. The recorder's output is read by the PI; the structure and length guidance is intentional.
- **`cumulative-report.md` headings**: two headings are extracted programmatically by `recorder.py`: `## Coach style notes` (fed back into the coach prompt as `${coach_style_notes}` on the next session) and `## Notes for PI` (surfaced in `metadata.json` as `has_pi_notes`). Do not rename these headings.
- **`metadata.json` schema**: any fields the recorder is asked to produce that aren't in the `RecorderArgs` tool schema in `recorder.py` will be silently dropped. Update the schema there if you add fields.

Change this prompt when PI feedback is about the *quality or content of the session summaries*, or when the cross-session cumulative report isn't capturing the right signals.

---

## Responding to PI feedback

### Step 1 — Classify the feedback

| Feedback pattern | Which prompt to change |
|---|---|
| "The coach keeps doing X on the same turn" (single-turn failure) | `fast-eval-prompt.md` (improve detection) or `instructions-v1.md` behavior rules (add/sharpen a rule) |
| "The coach keeps doing X across the whole session" (pattern failure) | `deep-eval-prompt.md` (improve detection) and/or `instructions-v1.md` behavior rules |
| "The coach is doing X wrong in a particular phase" (mode failure) | `instructions-v1.md` personality modes |
| "The session summaries are missing Y" or "the cumulative report isn't tracking Z" | `recorder-prompt.md` |
| "The evaluation file doesn't capture W" | `deep-eval-prompt.md` |

### Step 2 — Check the existing enums first

The evaluators flag two distinct things:

- **`coach_issues`** — problems with the coach's behavior (the coach said/did something it shouldn't have)
- **`student_red_flags`** — problems with how the student is using the coach (deviations from treating it like a real human professor: solution extraction, prompt injection, off-topic misuse, disrespect, inappropriate disclosure)

Before adding a new category to either enum, check whether the issue is already covered. If it is, the evaluators may already be flagging it — the problem may be that the coach isn't acting on the signal strongly enough, not that detection is missing. In that case, strengthen the relevant behavior rule rather than adding a new evaluator category.

If the issue is genuinely new and not covered:
1. Add the new category string to **both** `fast-eval-prompt.md` and `deep-eval-prompt.md` tables (the strings must match exactly).
2. Add the category to `COACH_ISSUE_CATEGORIES` or `STUDENT_RED_FLAG_CATEGORIES` in `python/ai-research-coach/ai_research_coach/recorder.py`.
3. If it's a coach issue and you want it to count toward end-of-session recurrence, also add it to `COACH_ISSUE_RECURRENCE_CATEGORIES`.
4. Add a corresponding behavior rule to `instructions-v1.md`.

### Step 3 — Edit, commit to `main`, wait ~5 minutes

Prompt files are fetched from GitHub at runtime with a short TTL cache. **No backend redeploy is needed** for prompt-only changes. After committing to `main`, the next session will use the updated prompts.

To verify a prompt change took effect, check the server logs:
```
sudo journalctl -u ai-research-coach -f | grep "HTTP Request.*github"
```

### Step 4 — Record the change

Add or update an entry in `notes/coach-behavior-notes.md` in the workspace (see the workspace `AGENTS.md` for entry format). When the fix is confirmed working, add `**Status:** Implemented (date)` to the entry. This record is the institutional memory for why prompts are the way they are.

---

## What NOT to change without careful thought

- **The `coach_issues` and `student_red_flags` enum category strings**: they are shared across the two evaluator prompts and `recorder.py`. A rename must be coordinated across all three files.
- **The `## Coach style notes` and `## Notes for PI` headings in the recorder prompt**: these are parsed programmatically.
- **The `parameters:` line in `instructions-v1.md`**: these are substituted by the frontend before the prompt is sent. Removing a parameter that the template still references causes a session-start failure.
- **The `recording-mode: split` line in `instructions-v1.md`**: removing this reverts to the legacy single-agent mode.
