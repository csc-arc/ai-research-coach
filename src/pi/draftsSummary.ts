/**
 * Pure renderer for the "review summary" sidecar markdown.
 *
 * Takes a finalized `DraftSet` plus the feedback items folded into the
 * latest synthesis and emits a markdown string designed to be pasted into
 * a GitHub PR description. The same function is intended to feed the
 * Phase E `Open PR` flow as the PR body, so it must stay pure (no React,
 * no fetch, no DOM).
 */

import type { AgentKey } from "./draftsApi";
import type { DraftSet } from "./draftsStorage";
import type { FeedbackByReviewerItem } from "./draftsApi";

const FILENAME_BY_AGENT: Record<AgentKey, string> = {
  coach: "public/instructions-v1.md",
  fast_eval: "public/fast-eval-prompt.md",
  deep_eval: "public/deep-eval-prompt.md",
};

const PRETTY_NAME: Record<AgentKey, string> = {
  coach: "coach prompt",
  fast_eval: "fast evaluator",
  deep_eval: "deep evaluator",
};

/**
 * Heuristic: which prompt(s) is each feedback item most likely to have
 * informed? Mirrors AGENTS.md "Step 1 — Classify the feedback" table.
 */
function pickPromptsForFeedback(
  it: FeedbackByReviewerItem,
): AgentKey[] {
  if (it.kind === "session_rating") {
    const rating = (it.payload as Record<string, unknown>).rating;
    if (rating === "great") {
      const note = (it.payload as Record<string, unknown>).note;
      if (typeof note === "string" && note.trim().length > 0) {
        return ["coach", "deep_eval"];
      }
      return [];
    }
    return ["deep_eval", "coach"];
  }
  if (it.kind === "turn_annotation") {
    const tag = (it.payload as Record<string, unknown>).tag;
    if (tag === "coach_problem") return ["coach", "fast_eval"];
    if (tag === "coach_good") return ["coach"];
    if (tag === "student_issue") return ["fast_eval"];
    return ["coach"];
  }
  if (it.kind === "coach_issue_review") {
    const verdict = (it.payload as Record<string, unknown>).verdict;
    if (verdict === "agree") return ["fast_eval", "coach"];
    if (verdict === "partial") return ["fast_eval", "coach"];
    if (verdict === "disagree") return ["fast_eval"];
    return ["fast_eval"];
  }
  return [];
}

function describeFeedback(it: FeedbackByReviewerItem): string {
  const session = `${it.student} / ${it.project} / ${it.session_ts}`;
  const payload = it.payload as Record<string, unknown>;
  const note = typeof payload.note === "string" ? payload.note.trim() : "";
  const noteSuffix = note ? `: "${note.replace(/\s+/g, " ").slice(0, 240)}"` : "";
  if (it.kind === "session_rating") {
    return `Session rating (\`${payload.rating ?? "?"}\`) on ${session}${noteSuffix}.`;
  }
  if (it.kind === "turn_annotation") {
    return `Turn ${payload.turn ?? "?"} annotation (\`${payload.tag ?? "?"}\`) on ${session}${noteSuffix}.`;
  }
  if (it.kind === "coach_issue_review") {
    return `Turn ${payload.turn ?? "?"} coach-issue review (\`${payload.verdict ?? "?"}\` on \`${payload.issue_category ?? "?"}\`) on ${session}${noteSuffix}.`;
  }
  return `${it.kind} on ${session}${noteSuffix}.`;
}

/**
 * Render the markdown summary. Pass `feedback_used` as the items folded
 * into the latest synthesis (typically `last_synth.feedback_ids_included`
 * resolved against the most recent feedback list).
 */
export function renderReviewSummary(
  ds: DraftSet,
  feedback_used: FeedbackByReviewerItem[],
): string {
  const last = ds.last_synth;
  const lines: string[] = [];
  lines.push("# PI Working Draft Review Summary");
  lines.push("");
  lines.push(`- Reviewer: ${ds.reviewer}`);
  lines.push(`- Draft set: ${ds.draft_set_id}`);
  lines.push(`- Created: ${ds.created_at}`);
  if (last) {
    lines.push(`- Last synthesis: ${last.ts} (${last.model})`);
  } else {
    lines.push("- Last synthesis: (none yet — synthesize before publishing)");
  }
  lines.push(
    `- Baseline: csc-arc/ai-research-coach@${
      ds.baseline_sha ? ds.baseline_sha.slice(0, 7) : "(not pinned)"
    }`,
  );

  const sessionKeys = new Set(
    feedback_used.map((f) => `${f.pi}|${f.project}|${f.student}|${f.session_ts}`),
  );
  lines.push(
    `- Feedback items folded in: ${feedback_used.length} across ${sessionKeys.size} session${
      sessionKeys.size === 1 ? "" : "s"
    }`,
  );

  // Bucket feedback by prompt(s) it likely informed.
  const byAgent: Record<AgentKey, FeedbackByReviewerItem[]> = {
    coach: [],
    fast_eval: [],
    deep_eval: [],
  };
  const seenForOther = new Set<string>();
  for (const f of feedback_used) {
    const targets = pickPromptsForFeedback(f);
    if (targets.length === 0) {
      seenForOther.add(f.head_id);
      continue;
    }
    for (const t of targets) byAgent[t].push(f);
  }

  lines.push("");
  lines.push("## What changed in each prompt");
  for (const k of (Object.keys(FILENAME_BY_AGENT) as AgentKey[])) {
    lines.push("");
    lines.push(`### \`${FILENAME_BY_AGENT[k]}\` — ${PRETTY_NAME[k]}`);
    lines.push("");

    const summary = last?.summary[k] ?? null;
    const rationale = last?.rationale[k] ?? null;
    const dirty = ds.drafts[k].trim() !== ds.originals[k].trim();

    if (!dirty) {
      lines.push("**No change.**");
      if (rationale) {
        lines.push("");
        lines.push(`Rationale: ${rationale.replace(/\n+/g, "\n> ")}`);
      } else if (summary) {
        lines.push("");
        lines.push(`Rationale: ${summary}`);
      }
      continue;
    }
    lines.push(`**One-line summary:** ${summary ?? "(no synthesis summary on file)"}`);
    if (rationale) {
      lines.push("");
      lines.push("**Rationale:**");
      lines.push("");
      const quoted = rationale
        .split(/\r?\n/)
        .map((line) => `> ${line}`)
        .join("\n");
      lines.push(quoted);
    }

    const drivers = byAgent[k];
    if (drivers.length > 0) {
      lines.push("");
      lines.push("**Feedback that drove the change:**");
      for (const f of drivers) {
        lines.push(`- ${describeFeedback(f)}`);
      }
    }

    const warnings = last?.warnings[k] ?? [];
    if (warnings.length > 0) {
      lines.push("");
      lines.push("**Validation warnings (non-blocking):**");
      for (const w of warnings) lines.push(`- ${w}`);
    }
  }

  if (seenForOther.size > 0) {
    lines.push("");
    lines.push("## Other feedback considered");
    lines.push("");
    lines.push(
      "These items were sent to the synthesizer but did not clearly map to a single prompt under the AGENTS.md classification table. They're listed here so nothing was silently dropped.",
    );
    for (const f of feedback_used) {
      if (!seenForOther.has(f.head_id)) continue;
      lines.push(`- ${describeFeedback(f)}`);
    }
  }

  lines.push("");
  lines.push("## How to publish (manual)");
  lines.push("");
  lines.push("1. Open `csc-arc/ai-research-coach`.");
  lines.push("2. Create a branch `pi-drafts/<reviewer-slug>/<draft_set_id>`.");
  lines.push(
    "3. Replace each changed prompt file with the downloaded copy (strip the `<!-- ... -->` provenance comment block before merging).",
  );
  lines.push("4. Open a PR. Paste this summary as the body.");
  lines.push(
    "5. Wait ~5 minutes after merge for the GitHub Pages cache; the next session will pick up the new prompts.",
  );

  lines.push("");
  lines.push("## How to publish (Phase E — when shipped)");
  lines.push("");
  lines.push(
    "Click `Open PR` in `/pi/drafts`. The endpoint pushes a branch named `pi-drafts/<reviewer>/<draft_set_id>`, drops one commit per changed prompt with the provenance stripped, and uses this summary as the PR body.",
  );

  return lines.join("\n");
}

export function provenanceCommentBlock(
  ds: DraftSet,
  agent: AgentKey,
  feedbackUsedCount: number,
  sessionsCount: number,
): string {
  const last = ds.last_synth;
  const warnings = last?.warnings[agent] ?? [];
  const lines: string[] = [
    "<!--",
    `PI working draft generated ${last?.ts ?? new Date().toISOString()}`,
    `Reviewer: ${ds.reviewer}`,
    `Draft set ID: ${ds.draft_set_id}`,
    `Synthesized from ${feedbackUsedCount} feedback items across ${sessionsCount} sessions`,
    `Baseline: csc-arc/ai-research-coach@${ds.baseline_sha ?? "(not pinned)"}`,
    `Synthesis model: ${last?.model ?? "(none)"}`,
    `agents_md_source: ${last?.agents_md_source ?? "(none)"}`,
    `Validation warnings: ${warnings.length}`,
  ];
  for (const w of warnings) lines.push(`  - ${w}`);
  lines.push("-->");
  return lines.join("\n");
}

export function filenameForAgent(agent: AgentKey): string {
  switch (agent) {
    case "coach":
      return "instructions-v1.md";
    case "fast_eval":
      return "fast-eval-prompt.md";
    case "deep_eval":
      return "deep-eval-prompt.md";
  }
}
