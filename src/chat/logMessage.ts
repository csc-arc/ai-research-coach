import { getServerUrl } from "../serverConfig";
import { getStoredPasscode } from "./passcodeStorage";

/**
 * Optional paste-detection signal for user-role messages.
 *
 * Field names are snake_case to match the wire format and the JSONL row
 * directly. Only sent on user-role messages — assistant messages must
 * not carry paste metadata. See
 * `notes/dev-0526/plans/paste-detection-plan.md`.
 */
export interface LogMessagePasteMeta {
  paste_event_count: number;
  paste_char_count: number;
  final_char_count: number;
}

/**
 * POST a chat message to the backend so it can be appended to chat-log.jsonl
 * for the active session and trigger evaluators.
 *
 * Fire-and-forget at call sites — never block the chat on log failures.
 *
 * Tool-role messages are intentionally not logged here. The evaluators do not
 * see raw tool output; their prompts acknowledge this blind spot.
 *
 * `pasteMeta` is omitted from the POST body when undefined, so historical
 * records stay clean (absence-vs-zero distinction is preserved).
 */
export async function logMessage(
  studentId: string,
  projectId: string,
  role: "user" | "assistant",
  content: string,
  pasteMeta?: LogMessagePasteMeta,
): Promise<void> {
  const serverUrl = getServerUrl();
  const passcode = getStoredPasscode(serverUrl);
  if (!passcode) return;

  try {
    const body: Record<string, unknown> = {
      passcode,
      student_id: studentId,
      project_id: projectId,
      role,
      content: typeof content === "string" ? content : JSON.stringify(content),
      timestamp: new Date().toISOString(),
    };
    if (pasteMeta && role === "user") {
      body.paste_event_count = pasteMeta.paste_event_count;
      body.paste_char_count = pasteMeta.paste_char_count;
      body.final_char_count = pasteMeta.final_char_count;
    }
    const response = await fetch(`${serverUrl}/api/log-message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      console.warn(`logMessage: ${response.status} ${response.statusText}`);
    }
  } catch (e) {
    // fire-and-forget — never block the chat on log failures, but surface
    // in the console so developers notice during testing
    console.warn("logMessage failed:", e);
  }
}
