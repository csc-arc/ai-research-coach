import { QPTool, ToolExecutionContext } from "../types";
import { getServerUrl } from "../../serverConfig";
import { getOrPromptPasscode } from "../passcodeStorage";
import { getRequiredStudentProject } from "../../studentProject";

interface EndSessionContext extends ToolExecutionContext {
  pi?: string;
  sessionStart?: string;
  onSessionEnded?: (status: string, error?: string) => void;
}

export const endSessionTool: QPTool = {
  toolFunction: {
    name: "end_session",
    description:
      "End the current research session. The backend writes the per-session archive (transcript, summary, evaluation, metadata), refreshes the cumulative report, and pushes to coach-sessions. Call this tool when the student indicates they are done for now. After this tool returns, deliver a brief, warm closing message.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },

  execute: async (_params: object, context: EndSessionContext) => {
    let studentId: string;
    let projectId: string;
    try {
      ({ studentId, projectId } = getRequiredStudentProject());
    } catch (e) {
      const msg = e instanceof Error ? e.message : "student_id/project_id not set";
      return {
        result: JSON.stringify({
          status: "recorder_failed",
          coach_message_hint:
            "There was an internal problem and your session could not be saved. Please reach out if this persists.",
          error: msg,
        }),
      };
    }

    const pi = context.pi;
    const sessionStart = context.sessionStart;

    if (!pi || !sessionStart) {
      return {
        result: JSON.stringify({
          status: "recorder_failed",
          coach_message_hint:
            "There was an internal problem and your session could not be saved. Please reach out if this persists.",
          error: "pi or sessionStart missing in tool context",
        }),
      };
    }

    const serverUrl = getServerUrl();
    const passcode = await getOrPromptPasscode(serverUrl);
    if (!passcode) {
      return {
        result: JSON.stringify({
          status: "recorder_failed",
          coach_message_hint:
            "There was an internal problem and your session could not be saved.",
          error: "passcode required",
        }),
      };
    }

    try {
      const response = await fetch(`${serverUrl}/api/end-session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          passcode,
          student_id: studentId,
          project_id: projectId,
          pi,
          session_start: sessionStart,
          session_end: new Date().toISOString(),
          abrupt: false,
        }),
      });

      const data = await response.json().catch(() => ({}));
      let status = (data?.status as string) || "recorder_failed";
      let commitSha = data?.commit_sha as string | undefined;
      let error = data?.error as string | undefined;
      const token = data?.recorder_token as string | undefined;

      // Poll until the background recorder task reaches a terminal status.
      if (status === "running" && token) {
        const deadline = Date.now() + 5 * 60_000;
        const POLL_INTERVAL_MS = 2000;
        while (status === "running" && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
          try {
            const poll = await fetch(
              `${serverUrl}/api/session-status?token=${encodeURIComponent(token)}` +
                `&passcode=${encodeURIComponent(passcode)}`,
            );
            const pdata = await poll.json().catch(() => ({}));
            status = (pdata?.status as string) || "recorder_failed";
            commitSha = pdata?.commit_sha as string | undefined;
            error = pdata?.error as string | undefined;
          } catch {
            // Network blip mid-poll — keep trying until deadline.
            // The recorder is still running server-side.
          }
        }
        if (status === "running") {
          status = "recorder_failed";
          error = "poll_timeout";
        }
      }

      // Fire onSessionEnded with the final terminal status, after polling completes.
      // Calling it before the loop would fire with status="running", leaving
      // recorderTriggeredRef unset and allowing beforeunload to double-fire.
      if (context.onSessionEnded) {
        try {
          context.onSessionEnded(status, error);
        } catch {
          // ignore
        }
      }

      let coachMessageHint = "";
      switch (status) {
        case "recorded":
        case "already_recorded":
          coachMessageHint =
            "The session was saved successfully. Deliver a brief, warm closing message that acknowledges what was accomplished and points to a clear next step.";
          break;
        case "queued_retry":
          coachMessageHint =
            "The session was archived locally but the push to coach-sessions failed; it has been queued for retry. Tell the student warmly that the session is saved and you'll see them next time. Do not mention the queued push.";
          break;
        case "recorder_failed":
        default:
          coachMessageHint =
            "There was an internal problem saving the session. Apologize briefly and ask the student to try again later. Do not pretend the save succeeded.";
          break;
      }

      return {
        result: JSON.stringify({
          status,
          commit_sha: commitSha,
          coach_message_hint: coachMessageHint,
          error,
        }),
      };
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : "Unknown error";
      return {
        result: JSON.stringify({
          status: "recorder_failed",
          coach_message_hint:
            "There was an internal problem saving the session. Apologize briefly and ask the student to try again later.",
          error: errMsg,
        }),
      };
    }
  },

  getDetailedDescription: () => {
    return `End the current research session. Call this tool when the student says they are done for now (e.g., "I'm done", "let's stop here", "I'll come back later"). The backend writes the per-session archive (transcript, summary, evaluation, metadata) and refreshes the cumulative report, then pushes to coach-sessions — all invisibly.

Takes no parameters. Returns a JSON object with:
- status: "recorded" | "already_recorded" | "queued_retry" | "recorder_failed"
  ("running" is a transient internal state; you will never see it in normal flow)
- coach_message_hint: a short instruction for how you should phrase your closing message
- error: optional error string (only on failures)
- recorder_token: internal token used for polling; ignore this field

After this tool returns, deliver a brief, warm closing that follows the coach_message_hint guidance.`;
  },
};
