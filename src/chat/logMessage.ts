import { getServerUrl } from "../serverConfig";
import { getStoredPasscode } from "./passcodeStorage";

/**
 * POST a chat message to the backend so it can be appended to chat-log.jsonl
 * for the active session and trigger evaluators.
 *
 * Fire-and-forget at call sites — never block the chat on log failures.
 *
 * Tool-role messages are intentionally not logged here. The evaluators do not
 * see raw tool output; their prompts acknowledge this blind spot.
 */
export async function logMessage(
  studentId: string,
  projectId: string,
  role: "user" | "assistant",
  content: string,
): Promise<void> {
  const serverUrl = getServerUrl();
  const passcode = getStoredPasscode(serverUrl);
  if (!passcode) return;

  try {
    const response = await fetch(`${serverUrl}/api/log-message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        passcode,
        student_id: studentId,
        project_id: projectId,
        role,
        content: typeof content === "string" ? content : JSON.stringify(content),
        timestamp: new Date().toISOString(),
      }),
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
