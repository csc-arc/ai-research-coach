/**
 * Client for the PI drafts backend (`/api/pi/synthesize-drafts` and
 * `/api/pi/feedback-by-reviewer`). Reuses the existing `piFetch<T>`
 * passcode plumbing.
 *
 * The backend builds transcript excerpts itself; the frontend ships only
 * head-of-chain feedback identifiers + their payloads.
 */

import { getServerUrl } from "../serverConfig";
import { PiApiError, getPiPasscode } from "./piApi";

export type AgentKey = "coach" | "fast_eval" | "deep_eval";

export const AGENT_KEYS: AgentKey[] = ["coach", "fast_eval", "deep_eval"];

export interface DraftPromptInput {
  name: AgentKey;
  original: string;
  current: string;
}

export interface SynthesisFeedbackItem {
  head_id: string;
  kind: "session_rating" | "turn_annotation" | "coach_issue_review";
  pi: string;
  project: string;
  student: string;
  session_ts: string;
  session_prompts_sha: string | null;
  reviewer: string;
  ts: string;
  payload: Record<string, unknown>;
  already_folded_in: boolean;
}

export interface SynthesizeDraftsRequest {
  draft_set_id: string;
  schema_version: 1;
  reviewer: string;
  baseline_sha: string | null;
  prompts: DraftPromptInput[];
  feedback_items: SynthesisFeedbackItem[];
  model?: string;
}

export interface DraftPromptOutput {
  name: AgentKey;
  new_text: string | null;
  summary: string;
  rationale: string;
  coach_issues_categories: string[] | null;
  student_red_flags_categories: string[] | null;
  validation_warnings: string[];
}

export interface SynthesisUsage {
  model: string;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  elapsed_seconds: number;
  agents_md_source: "github" | "fallback";
}

export interface SynthesizeDraftsResponse {
  draft_set_id: string;
  synthesized_at: string;
  feedback_snapshot_ts: string;
  model: string;
  prompts: DraftPromptOutput[];
  usage: SynthesisUsage;
  baseline_sha: string | null;
  feedback_item_count: number;
  warnings: string[];
}

export interface FeedbackByReviewerItem {
  head_id: string;
  kind: "session_rating" | "turn_annotation" | "coach_issue_review";
  pi: string;
  project: string;
  student: string;
  session_ts: string;
  session_prompts_sha: string | null;
  reviewer: string;
  ts: string;
  payload: Record<string, unknown>;
}

export interface FeedbackByReviewerResponse {
  items: FeedbackByReviewerItem[];
  cached: boolean;
  snapshot_ts: string;
}

async function piFetchLocal<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  // Local copy of the piFetch wrapper from piApi.ts. Kept here so the drafts
  // module doesn't accidentally drift away from the same passcode contract.
  const passcode = getPiPasscode();
  if (!passcode) {
    throw new PiApiError("PI passcode missing — please re-enter.", 401);
  }
  const headers: Record<string, string> = {
    "X-PI-Passcode": passcode,
    "Content-Type": "application/json",
    ...((init.headers as Record<string, string>) || {}),
  };
  const response = await fetch(`${getServerUrl()}${path}`, {
    ...init,
    headers,
  });
  if (!response.ok) {
    let detail: string = response.statusText || `HTTP ${response.status}`;
    try {
      const body = await response.text();
      try {
        const json = JSON.parse(body);
        detail = json.detail || json.error || body;
      } catch {
        if (body) detail = body;
      }
    } catch {
      /* ignore */
    }
    throw new PiApiError(detail, response.status);
  }
  return (await response.json()) as T;
}

export function postSynthesizeDrafts(
  req: SynthesizeDraftsRequest,
): Promise<SynthesizeDraftsResponse> {
  return piFetchLocal<SynthesizeDraftsResponse>("/api/pi/synthesize-drafts", {
    method: "POST",
    body: JSON.stringify(req),
  });
}

export function fetchFeedbackByReviewer(
  reviewer: string,
): Promise<FeedbackByReviewerResponse> {
  const qs = `?reviewer=${encodeURIComponent(reviewer)}`;
  return piFetchLocal<FeedbackByReviewerResponse>(
    `/api/pi/feedback-by-reviewer${qs}`,
  );
}

/**
 * Fetch the current head-of-main content for the three editable prompts.
 * Used to seed `originals` on first draft-set creation. Reuses the existing
 * `/api/pi/prompt/{name}?sha=live` endpoint.
 */
export async function fetchHeadOfMainPrompts(): Promise<{
  baseline_sha: string | null;
  originals: Record<AgentKey, string>;
}> {
  const names: { agent: AgentKey; promptName: string }[] = [
    { agent: "coach", promptName: "coach-instructions" },
    { agent: "fast_eval", promptName: "fast-eval" },
    { agent: "deep_eval", promptName: "deep-eval" },
  ];
  const results = await Promise.all(
    names.map(({ promptName }) =>
      piFetchLocal<{ sha: string; filename: string; content: string }>(
        `/api/pi/prompt/${encodeURIComponent(promptName)}?sha=live`,
      ),
    ),
  );
  const originals: Record<AgentKey, string> = { coach: "", fast_eval: "", deep_eval: "" };
  let baseline_sha: string | null = null;
  results.forEach((r, i) => {
    originals[names[i].agent] = r.content;
    // The /prompt/ endpoint returns the resolved SHA per file; they should
    // all match (head of main), so any of them works as the baseline.
    if (!baseline_sha && r.sha && !r.sha.startsWith("local:")) {
      baseline_sha = r.sha;
    }
  });
  return { baseline_sha, originals };
}
