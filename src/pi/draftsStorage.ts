/**
 * localStorage-backed drafts data model for the PI dashboard.
 *
 * One draft set per (reviewer, draft_set_id). The "active" set for a
 * reviewer is pointed at by an index key. A reset moves the live set to a
 * trash key so the user can restore within ~24h.
 *
 * Schema is versioned; the loader upgrades or hard-resets on mismatch and
 * surfaces a `resetReason` to the caller so the UI can show a one-shot
 * notification.
 */

import type {
  AgentKey,
  DraftPromptOutput,
  FeedbackByReviewerItem,
  SynthesisFeedbackItem,
  SynthesizeDraftsResponse,
} from "./draftsApi";

export const DRAFT_SCHEMA_VERSION = 1;
export const TRASH_TTL_MS = 24 * 60 * 60 * 1000;

export interface LastSynth {
  ts: string;
  feedback_snapshot_ts: string;
  feedback_ids_included: string[];
  model: string;
  agents_md_source: "github" | "fallback";
  summary: Record<AgentKey, string | null>;
  rationale: Record<AgentKey, string | null>;
  categories: Record<
    AgentKey,
    { coach_issues: string[]; student_red_flags: string[] } | null
  >;
  warnings: Record<AgentKey, string[]>;
}

export interface DraftSet {
  schema_version: 1;
  draft_set_id: string;
  reviewer: string;
  baseline_sha: string | null;
  created_at: string;
  originals: Record<AgentKey, string>;
  drafts: Record<AgentKey, string>;
  last_synth: LastSynth | null;
  downloads: Record<AgentKey, { last_downloaded_at: string } | null>;
}

const STORAGE_PREFIX = "arc_pi_drafts";
const INDEX_PREFIX = "arc_pi_drafts_index";
const TRASH_PREFIX = "arc_pi_drafts_trash";
const TRASH_INDEX_PREFIX = "arc_pi_drafts_trash_index";

function slugify(reviewer: string): string {
  return reviewer
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "anon";
}

function keyForSet(reviewer: string, draftSetId: string): string {
  return `${STORAGE_PREFIX}:${slugify(reviewer)}:${draftSetId}`;
}

function indexKey(reviewer: string): string {
  return `${INDEX_PREFIX}:${slugify(reviewer)}`;
}

function trashKey(reviewer: string, draftSetId: string): string {
  return `${TRASH_PREFIX}:${slugify(reviewer)}:${draftSetId}`;
}

function trashIndexKey(reviewer: string): string {
  return `${TRASH_INDEX_PREFIX}:${slugify(reviewer)}`;
}

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* quota or privacy mode — drop silently */
  }
}

function safeRemove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

function uuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  // Fallback for ancient browsers.
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

const DEFAULT_AGENTS: Record<AgentKey, string> = {
  coach: "",
  fast_eval: "",
  deep_eval: "",
};

function isValidDraftSet(value: unknown): value is DraftSet {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  if (obj.schema_version !== DRAFT_SCHEMA_VERSION) return false;
  if (typeof obj.draft_set_id !== "string") return false;
  if (typeof obj.reviewer !== "string") return false;
  if (typeof obj.created_at !== "string") return false;
  if (!obj.originals || !obj.drafts || !obj.downloads) return false;
  for (const k of ["coach", "fast_eval", "deep_eval"]) {
    if (typeof (obj.originals as Record<string, unknown>)[k] !== "string") return false;
    if (typeof (obj.drafts as Record<string, unknown>)[k] !== "string") return false;
  }
  return true;
}

export interface LoadResult {
  set: DraftSet | null;
  migrated: boolean;
  resetReason: string | null;
}

export function loadAndMigrateDraftSet(reviewer: string): LoadResult {
  const id = safeGet(indexKey(reviewer));
  if (!id) return { set: null, migrated: false, resetReason: null };

  const raw = safeGet(keyForSet(reviewer, id));
  if (!raw) {
    safeRemove(indexKey(reviewer));
    return { set: null, migrated: false, resetReason: null };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    safeRemove(keyForSet(reviewer, id));
    safeRemove(indexKey(reviewer));
    return {
      set: null,
      migrated: false,
      resetReason: "Your draft set was corrupted on disk and has been reset.",
    };
  }

  if (!parsed || typeof parsed !== "object") {
    safeRemove(keyForSet(reviewer, id));
    safeRemove(indexKey(reviewer));
    return { set: null, migrated: false, resetReason: "Draft set was empty; reset." };
  }

  const objVersion = (parsed as Record<string, unknown>).schema_version;
  if (typeof objVersion === "number" && objVersion !== DRAFT_SCHEMA_VERSION) {
    safeRemove(keyForSet(reviewer, id));
    safeRemove(indexKey(reviewer));
    return {
      set: null,
      migrated: false,
      resetReason:
        "Your draft set was created under a different dashboard version " +
        "and needs to be re-synthesized; your originals have been cleared.",
    };
  }

  if (!isValidDraftSet(parsed)) {
    safeRemove(keyForSet(reviewer, id));
    safeRemove(indexKey(reviewer));
    return {
      set: null,
      migrated: false,
      resetReason:
        "Your draft set failed validation and has been reset.",
    };
  }

  return { set: parsed, migrated: false, resetReason: null };
}

export function getActiveDraftSet(reviewer: string): DraftSet | null {
  return loadAndMigrateDraftSet(reviewer).set;
}

export interface InitDraftSetArgs {
  reviewer: string;
  baseline_sha: string | null;
  originals: Record<AgentKey, string>;
}

export function initDraftSet(args: InitDraftSetArgs): DraftSet {
  const ds: DraftSet = {
    schema_version: DRAFT_SCHEMA_VERSION,
    draft_set_id: uuid(),
    reviewer: args.reviewer,
    baseline_sha: args.baseline_sha,
    created_at: new Date().toISOString(),
    originals: { ...args.originals },
    drafts: { ...args.originals },
    last_synth: null,
    downloads: { coach: null, fast_eval: null, deep_eval: null },
  };
  saveSet(ds);
  safeSet(indexKey(args.reviewer), ds.draft_set_id);
  return ds;
}

function saveSet(ds: DraftSet): void {
  safeSet(keyForSet(ds.reviewer, ds.draft_set_id), JSON.stringify(ds));
}

export function updateDraftText(
  reviewer: string,
  agent: AgentKey,
  text: string,
): DraftSet {
  const ds = getActiveDraftSet(reviewer);
  if (!ds) throw new Error("No active draft set for reviewer");
  ds.drafts = { ...ds.drafts, [agent]: text };
  // Editing a prompt invalidates the "downloaded" pin for that prompt; the
  // UI uses this to surface "unsaved changes since download".
  if (ds.downloads[agent]) {
    // Keep the timestamp so we can show "downloaded HH:MM but edited
    // since" — we do that via a separate stale-edit check rather than
    // clearing the entry.
  }
  saveSet(ds);
  return ds;
}

export function applySynthesisResult(
  reviewer: string,
  result: SynthesizeDraftsResponse,
  feedback_ids_included: string[],
): DraftSet {
  const ds = getActiveDraftSet(reviewer);
  if (!ds) throw new Error("No active draft set for reviewer");

  const summary: Record<AgentKey, string | null> = { coach: null, fast_eval: null, deep_eval: null };
  const rationale: Record<AgentKey, string | null> = { coach: null, fast_eval: null, deep_eval: null };
  const categories: Record<
    AgentKey,
    { coach_issues: string[]; student_red_flags: string[] } | null
  > = { coach: null, fast_eval: null, deep_eval: null };
  const warnings: Record<AgentKey, string[]> = { coach: [], fast_eval: [], deep_eval: [] };

  for (const out of result.prompts) {
    const k = out.name;
    if (out.new_text != null) {
      ds.drafts[k] = out.new_text;
    }
    summary[k] = out.summary || null;
    rationale[k] = out.rationale || null;
    if (k !== "coach") {
      if (out.coach_issues_categories || out.student_red_flags_categories) {
        categories[k] = {
          coach_issues: out.coach_issues_categories ?? [],
          student_red_flags: out.student_red_flags_categories ?? [],
        };
      }
    }
    warnings[k] = out.validation_warnings ?? [];
  }

  ds.last_synth = {
    ts: result.synthesized_at,
    feedback_snapshot_ts: result.feedback_snapshot_ts,
    feedback_ids_included: [...feedback_ids_included],
    model: result.model,
    agents_md_source: result.usage.agents_md_source,
    summary,
    rationale,
    categories,
    warnings,
  };
  saveSet(ds);
  return ds;
}

export function resetDraftSet(reviewer: string): void {
  const ds = getActiveDraftSet(reviewer);
  if (!ds) return;
  // Move to trash (overwriting any prior trash entry).
  safeSet(trashKey(reviewer, ds.draft_set_id), JSON.stringify(ds));
  safeSet(trashIndexKey(reviewer), ds.draft_set_id);
  safeRemove(keyForSet(reviewer, ds.draft_set_id));
  safeRemove(indexKey(reviewer));
}

export function resetDraftPrompt(reviewer: string, agent: AgentKey): DraftSet {
  const ds = getActiveDraftSet(reviewer);
  if (!ds) throw new Error("No active draft set for reviewer");
  ds.drafts = { ...ds.drafts, [agent]: ds.originals[agent] };
  ds.downloads = { ...ds.downloads, [agent]: null };
  // Clear any synthesis artifacts for this prompt so the diff editor stops
  // showing a stale "Synthesis summary" caption.
  if (ds.last_synth) {
    ds.last_synth = {
      ...ds.last_synth,
      summary: { ...ds.last_synth.summary, [agent]: null },
      rationale: { ...ds.last_synth.rationale, [agent]: null },
      warnings: { ...ds.last_synth.warnings, [agent]: [] },
    };
  }
  saveSet(ds);
  return ds;
}

export function markDownloaded(reviewer: string, agent: AgentKey): DraftSet {
  const ds = getActiveDraftSet(reviewer);
  if (!ds) throw new Error("No active draft set for reviewer");
  ds.downloads = {
    ...ds.downloads,
    [agent]: { last_downloaded_at: new Date().toISOString() },
  };
  saveSet(ds);
  return ds;
}

export function getTrashedDraftSet(reviewer: string): DraftSet | null {
  const id = safeGet(trashIndexKey(reviewer));
  if (!id) return null;
  const raw = safeGet(trashKey(reviewer, id));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!isValidDraftSet(parsed)) return null;
    // Expire trashes older than 24h.
    const created = new Date(parsed.created_at).getTime();
    if (Number.isFinite(created) && Date.now() - created > TRASH_TTL_MS) {
      // Don't auto-clear here; just hide it. clearTrashedDraftSet is the
      // only path that actually removes.
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function restoreLastReset(reviewer: string): DraftSet | null {
  const trashed = getTrashedDraftSet(reviewer);
  if (!trashed) return null;
  saveSet(trashed);
  safeSet(indexKey(reviewer), trashed.draft_set_id);
  // Leave the trash entry in place so the user can re-restore if needed.
  return trashed;
}

export function clearTrashedDraftSet(reviewer: string): void {
  const id = safeGet(trashIndexKey(reviewer));
  if (id) safeRemove(trashKey(reviewer, id));
  safeRemove(trashIndexKey(reviewer));
}

// ---------------------------------------------------------------------------
// New-feedback-since-last-synth math
// ---------------------------------------------------------------------------

export interface NewFeedbackComputation {
  count: number;
  sessions: number;
  items: SynthesisFeedbackItem[];
  already_folded_in_count: number;
}

/**
 * Compute the synthesis feedback payload + the counter math.
 *
 * `allFeedback` comes from the C1.5 endpoint: head-of-chain entries the
 * reviewer authored. Retracted heads are filtered out; surviving heads are
 * tagged `already_folded_in: true` if their `head_id` was in the prior
 * synthesis run's `feedback_ids_included` set.
 */
export function newFeedbackSinceLastSynth(
  ds: DraftSet | null,
  allFeedback: FeedbackByReviewerItem[],
): NewFeedbackComputation {
  const lastIncluded = new Set<string>(ds?.last_synth?.feedback_ids_included ?? []);

  const sessionKeys = new Set<string>();
  const items: SynthesisFeedbackItem[] = [];
  let alreadyFolded = 0;

  for (const f of allFeedback) {
    const retracted = (f.payload as Record<string, unknown>).retracted === true;
    if (retracted) continue;
    const folded = lastIncluded.has(f.head_id);
    if (folded) alreadyFolded += 1;
    sessionKeys.add(`${f.pi}|${f.project}|${f.student}|${f.session_ts}`);
    items.push({
      head_id: f.head_id,
      kind: f.kind,
      pi: f.pi,
      project: f.project,
      student: f.student,
      session_ts: f.session_ts,
      session_prompts_sha: f.session_prompts_sha,
      reviewer: f.reviewer,
      ts: f.ts,
      payload: f.payload,
      already_folded_in: folded,
    });
  }

  return {
    count: items.length - alreadyFolded,
    sessions: sessionKeys.size,
    items,
    already_folded_in_count: alreadyFolded,
  };
}

// ---------------------------------------------------------------------------
// Convenience: build the synthesize payload from a DraftSet
// ---------------------------------------------------------------------------

export function buildSynthesizeRequest(
  ds: DraftSet,
  computation: NewFeedbackComputation,
  modelOverride?: string,
): {
  draft_set_id: string;
  schema_version: 1;
  reviewer: string;
  baseline_sha: string | null;
  prompts: { name: AgentKey; original: string; current: string }[];
  feedback_items: SynthesisFeedbackItem[];
  model?: string;
} {
  const out: {
    name: AgentKey;
    original: string;
    current: string;
  }[] = (["coach", "fast_eval", "deep_eval"] as AgentKey[]).map((k) => ({
    name: k,
    original: ds.originals[k],
    current: ds.drafts[k],
  }));
  const req: ReturnType<typeof buildSynthesizeRequest> = {
    draft_set_id: ds.draft_set_id,
    schema_version: DRAFT_SCHEMA_VERSION,
    reviewer: ds.reviewer,
    baseline_sha: ds.baseline_sha,
    prompts: out,
    feedback_items: computation.items,
  };
  if (modelOverride) req.model = modelOverride;
  return req;
}

// Re-export helper types so consumers don't import from too many places.
export type { DraftPromptOutput };
export const _DEFAULT_AGENTS_FOR_TESTING = DEFAULT_AGENTS;
