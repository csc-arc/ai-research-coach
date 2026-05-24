import { CompletionFunction } from "../react-ai-chat";
import { parseCompletionStream } from "./parseCompletionStream";
import { getOrPromptPasscode } from "./passcodeStorage";
import { getServerUrl } from "../serverConfig";
import { getRequiredStudentProject } from "../studentProject";

// Retry configuration for rate limit errors
const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY_MS = 10000; // 10 seconds

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const isRateLimitError = (status: number, errorMessage: string): boolean => {
  return status === 429 || errorMessage.toLowerCase().includes("rate limit");
};

/**
 * Creates a completion function that proxies through our own FastAPI backend.
 * The backend holds the OpenRouter API key; the browser sends only the passcode.
 */
export const createCompletionFunction = (): CompletionFunction => {
  return async (request, onPartialContent, signal) => {
    const serverUrl = getServerUrl();
    const passcode = await getOrPromptPasscode(serverUrl);

    if (!passcode) {
      throw new Error("Passcode is required to use the AI assistant.");
    }

    let studentId: string | undefined;
    let projectId: string | undefined;
    try {
      ({ studentId, projectId } = getRequiredStudentProject());
    } catch {
      // Not all callers have student/project context (e.g. tests); send without
    }

    const body = {
      model: request.model,
      systemMessage: request.systemMessage,
      messages: request.messages,
      tools: request.tools.length > 0 ? request.tools : undefined,
      passcode,
      student_id: studentId,
      project_id: projectId,
    };

    let response: Response | null = null;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        response = await fetch(`${serverUrl}/api/completion`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal,
        });

        if (response.ok) {
          break;
        }

        let errorDetails = response.statusText || `HTTP ${response.status}`;
        try {
          const errorBody = await response.text();
          if (errorBody) {
            try {
              const errorJson = JSON.parse(errorBody);
              errorDetails = errorJson.detail || errorJson.error?.message || errorJson.message || errorBody;
            } catch {
              errorDetails = errorBody;
            }
          }
        } catch {
          // Couldn't read body, stick with statusText
        }

        if (isRateLimitError(response.status, errorDetails) && attempt < MAX_RETRIES) {
          const delayMs = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt);
          console.warn(`Rate limit hit, retrying in ${delayMs / 1000}s (attempt ${attempt + 1}/${MAX_RETRIES})...`);
          onPartialContent(`⏳ Rate limit reached. Waiting ${Math.round(delayMs / 1000)} seconds before retrying (attempt ${attempt + 1}/${MAX_RETRIES})...`);
          await sleep(delayMs);
          continue;
        }

        lastError = new Error(`API error: ${errorDetails}`);
        break;
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          throw err;
        }
        lastError = err instanceof Error ? err : new Error(String(err));

        if (attempt < MAX_RETRIES) {
          const delayMs = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt);
          console.warn(`Network error, retrying in ${delayMs / 1000}s...`);
          await sleep(delayMs);
          continue;
        }
        break;
      }
    }

    if (lastError) {
      throw lastError;
    }

    if (!response || !response.ok) {
      throw new Error("Failed to get response from API");
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error("No response body");
    }

    const { assistantContent, toolCalls, promptTokens, completionTokens } =
      await parseCompletionStream(reader, onPartialContent);

    return {
      content: assistantContent,
      toolCalls: toolCalls || undefined,
      usage: {
        promptTokens,
        completionTokens,
      },
    };
  };
};
