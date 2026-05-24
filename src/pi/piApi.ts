/**
 * Client-side helpers for the PI dashboard backend (`/api/pi/*`).
 *
 * All endpoints are gated by the `ARC_PI_PASSCODE` configured on the
 * server. The browser stores the passcode in sessionStorage (cleared on
 * tab close) and forwards it on every request via `X-PI-Passcode`.
 */

import { getServerUrl } from "../serverConfig";

const PI_PASSCODE_KEY = "arc_pi_passcode";

export function getPiPasscode(): string | null {
  try {
    return sessionStorage.getItem(PI_PASSCODE_KEY);
  } catch {
    return null;
  }
}

export function setPiPasscode(value: string): void {
  try {
    sessionStorage.setItem(PI_PASSCODE_KEY, value);
  } catch {
    /* ignore — privacy mode may block sessionStorage */
  }
}

export function clearPiPasscode(): void {
  try {
    sessionStorage.removeItem(PI_PASSCODE_KEY);
  } catch {
    /* ignore */
  }
}

const REVIEWER_NAME_KEY = "arc_pi_reviewer_name";

export function getReviewerName(): string | null {
  try {
    return localStorage.getItem(REVIEWER_NAME_KEY);
  } catch {
    return null;
  }
}

export function setReviewerName(name: string): void {
  try {
    localStorage.setItem(REVIEWER_NAME_KEY, name);
  } catch {
    /* ignore */
  }
}

export function clearReviewerName(): void {
  try {
    localStorage.removeItem(REVIEWER_NAME_KEY);
  } catch {
    /* ignore */
  }
}

export class PiApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function piFetch<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
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

// ---------------------------------------------------------------------------
// Index + session bundle
// ---------------------------------------------------------------------------

export type IndexTree = Record<string, Record<string, Record<string, string[]>>>;

export interface IndexResponse {
  tree: IndexTree;
  cached: boolean;
}

export function fetchIndex(): Promise<IndexResponse> {
  return piFetch<IndexResponse>("/api/pi/index");
}

export interface TranscriptMessage {
  role: "user" | "assistant" | string;
  content?: string;
  timestamp?: string;
  [key: string]: unknown;
}

export interface FastEvalCoachIssue {
  category: string;
  observation: string;
  suggested_correction: string;
}

export interface FastEvalStudentRedFlag {
  category: string;
  observation: string;
  suggested_response: string;
}

export interface FastEvalArgs {
  coach_issues?: FastEvalCoachIssue[];
  student_red_flags?: FastEvalStudentRedFlag[];
  open_threads?: string[];
  mode_effectiveness?: string;
  suggested_next_move?: string;
}

export interface FastEvalTurnEntry {
  turn: number;
  ts: string;
  user_message_preview?: string;
  fast_eval: FastEvalArgs;
}

export interface SessionMetadata {
  student_id?: string;
  project_id?: string;
  pi?: string;
  session_start?: string;
  session_end?: string;
  duration_seconds?: number;
  message_count?: number;
  status?: string;
  prompts_sha?: string;
  prompts?: Record<string, string>;
  models?: Record<string, string>;
  engagement?: string | null;
  coach_issue_count?: number | null;
  coach_issue_categories?: string[];
  failure_reason?: string;
  abrupt?: boolean;
  project_description_sha?: string;
  [key: string]: unknown;
}

export interface FeedbackEntryBase {
  id: string;
  reviewer: string;
  ts: string;
  note?: string;
  supersedes?: string;
  retracted?: boolean;
}

export interface SessionRatingEntry extends FeedbackEntryBase {
  rating: "great" | "ok" | "poor";
}

export interface TurnAnnotationEntry extends FeedbackEntryBase {
  turn: number;
  tag: "coach_problem" | "coach_good" | "student_issue" | "note";
}

export interface CoachIssueReviewEntry extends FeedbackEntryBase {
  turn: number;
  issue_category: string;
  verdict: "agree" | "disagree" | "partial";
}

export interface FeedbackBundle {
  session_ratings?: SessionRatingEntry[];
  turn_annotations?: TurnAnnotationEntry[];
  coach_issue_reviews?: CoachIssueReviewEntry[];
}

export interface SessionBundle {
  summary: string | null;
  transcript: TranscriptMessage[];
  evaluation: string | null;
  metadata: SessionMetadata | null;
  fast_eval_turns: FastEvalTurnEntry[] | null;
  cumulative_report: string | null;
  feedback: FeedbackBundle | null;
}

export function fetchSessionBundle(
  pi: string,
  project: string,
  student: string,
  ts: string,
): Promise<SessionBundle> {
  const path = `/api/pi/session/${encodeURIComponent(pi)}/${encodeURIComponent(
    project,
  )}/${encodeURIComponent(student)}/${encodeURIComponent(ts)}`;
  return piFetch<SessionBundle>(path);
}

// ---------------------------------------------------------------------------
// Prompt history & content
// ---------------------------------------------------------------------------

export interface PromptHistoryEntry {
  sha: string;
  committed_at: string;
  commit_subject: string;
}

export interface PromptHistoryResponse {
  history: PromptHistoryEntry[];
  cached: boolean;
}

export function fetchPromptHistory(
  promptName: string,
): Promise<PromptHistoryResponse> {
  return piFetch<PromptHistoryResponse>(
    `/api/pi/prompt-history/${encodeURIComponent(promptName)}`,
  );
}

export interface PromptContentResponse {
  sha: string;
  filename: string;
  content: string;
}

export function fetchPromptAtSha(
  promptName: string,
  sha: string,
): Promise<PromptContentResponse> {
  const qs = `?sha=${encodeURIComponent(sha)}`;
  return piFetch<PromptContentResponse>(
    `/api/pi/prompt/${encodeURIComponent(promptName)}${qs}`,
  );
}

// ---------------------------------------------------------------------------
// Prompt divergence — has the prompt file moved on main since the session ran?
// ---------------------------------------------------------------------------

export interface PromptDivergenceCommit {
  sha: string;
  committed_at: string;
  commit_subject: string;
}

export interface PromptDivergenceFileEntry {
  modified: boolean;
  commits?: PromptDivergenceCommit[];
  error?: string;
}

export interface PromptsDivergenceResponse {
  since_sha: string;
  head_sha: string | null;
  comparable: boolean;
  reason?: string;
  prompts: Record<string, PromptDivergenceFileEntry>;
  any_modified: boolean;
  cached?: boolean;
}

export function fetchPromptsDivergence(
  sinceSha: string,
): Promise<PromptsDivergenceResponse> {
  return piFetch<PromptsDivergenceResponse>(
    `/api/pi/prompts-divergence?since=${encodeURIComponent(sinceSha)}`,
  );
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

export type PromptMode = "original" | "sha" | "text";

export interface PromptSelector {
  mode: PromptMode;
  value?: string;
}

export interface ReplayRequest {
  pi: string;
  project: string;
  student: string;
  session_ts: string;
  turn: number;
  coach_prompt: PromptSelector;
  fast_eval_prompt: PromptSelector;
  deep_eval_prompt: PromptSelector;
  coach_model?: string;
  fast_eval_model?: string;
  deep_eval_model?: string;
}

export interface ReplayResponse {
  deep_eval_md: string;
  deep_eval_args: Record<string, unknown> | null;
  fast_eval_md: string;
  fast_eval_args: FastEvalArgs | null;
  coach_response: string;
  coach_system_message: string;
  models_used: { coach: string; fast_eval: string; deep_eval: string };
  original_prompts_sha: string | null;
}

export function postReplay(req: ReplayRequest): Promise<ReplayResponse> {
  return piFetch<ReplayResponse>("/api/pi/replay-turn", {
    method: "POST",
    body: JSON.stringify(req),
  });
}

// ---------------------------------------------------------------------------
// Feedback
// ---------------------------------------------------------------------------

export interface FeedbackPostBase {
  pi: string;
  project: string;
  student: string;
  session_ts: string;
  reviewer: string;
  note?: string;
  supersedes?: string;
  retracted?: boolean;
}

export interface SessionFeedbackPost extends FeedbackPostBase {
  rating: "great" | "ok" | "poor";
}

export interface TurnFeedbackPost extends FeedbackPostBase {
  turn: number;
  tag: "coach_problem" | "coach_good" | "student_issue" | "note";
}

export interface IssueFeedbackPost extends FeedbackPostBase {
  turn: number;
  issue_category: string;
  verdict: "agree" | "disagree" | "partial";
}

export interface FeedbackPostResponse {
  id: string;
  committed?: boolean;
  pushed?: boolean;
  push_error?: string;
}

export function postSessionFeedback(
  body: SessionFeedbackPost,
): Promise<FeedbackPostResponse> {
  return piFetch<FeedbackPostResponse>("/api/pi/feedback/session", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function postTurnFeedback(
  body: TurnFeedbackPost,
): Promise<FeedbackPostResponse> {
  return piFetch<FeedbackPostResponse>("/api/pi/feedback/turn", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function postIssueFeedback(
  body: IssueFeedbackPost,
): Promise<FeedbackPostResponse> {
  return piFetch<FeedbackPostResponse>("/api/pi/feedback/issue", {
    method: "POST",
    body: JSON.stringify(body),
  });
}
