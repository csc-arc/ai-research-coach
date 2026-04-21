import { QPTool, ToolExecutionContext } from "../types";
import { getServerUrl } from "../../serverConfig";
import { getOrPromptPasscode, promptForPasscode, storePasscode, clearPasscode } from "../passcodeStorage";
import { getRequiredStudentProject } from "../../studentProject";

// Supported image file extensions
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.bmp', '.webp'];

// Get MIME type from file extension
function getMimeType(filename: string): string {
  const ext = filename.toLowerCase().slice(filename.lastIndexOf('.'));
  const mimeTypes: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.bmp': 'image/bmp',
    '.webp': 'image/webp',
  };
  return mimeTypes[ext] || 'application/octet-stream';
}

// Check if filename has an image extension
function isImageFile(filename: string): boolean {
  const ext = filename.toLowerCase().slice(filename.lastIndexOf('.'));
  return IMAGE_EXTENSIONS.includes(ext);
}

/**
 * A tool that allows the AI to run scripts (Python or shell) via the local file server.
 */
export const runScriptTool: QPTool = {
  toolFunction: {
    name: "run_script",
    description:
      "Execute a script (Python or shell) on the local system. The script will be written to a temporary directory with a timestamp and executed with a configurable timeout. Use this to perform data analysis, computations, system operations, or any script-based tasks.",
    parameters: {
      type: "object",
      properties: {
        script: {
          type: "string",
          description:
            "The complete script to execute. Include all necessary imports and code. The script will be saved in a timestamped temporary directory.",
        },
        scriptType: {
          type: "string",
          enum: ["python", "shell"],
          description:
            "Type of script to execute. 'python' for Python scripts (.py) or 'shell' for shell scripts (.sh).",
        },
        timeout: {
          type: "number",
          description:
            "Maximum execution time in seconds (default: 10, max: 60). The script will be terminated if it runs longer than this.",
        },
      },
      required: ["script", "scriptType", "timeout"],
      additionalProperties: false,
    },
  },

  execute: async (
    params: { script: string; scriptType: string; timeout?: number },
    context: ToolExecutionContext
  ) => {
    const { script, timeout = 10 } = params;
    const scriptType = params.scriptType as 'python' | 'shell';

    // Validate script
    if (!script) {
      return {
        result: JSON.stringify({
          success: false,
          error: "Script content is required",
        }),
      };
    }

    // Validate script type
    if (!["python", "shell"].includes(scriptType)) {
      return {
        result: JSON.stringify({
          success: false,
          error: "scriptType must be 'python' or 'shell'",
        }),
      };
    }

    // Emit the script as an output item and wait for user approval
    let approved = true; // Default to approved if no approval system
    let outputId: string | null = null;

    if (context.outputEmitter && context.requestApproval) {
      // Emit the script with pending approval state and get the output ID
      outputId = context.outputEmitter({
        type: 'script',
        content: script,
        metadata: {
          pendingApproval: true,
          serverHealthCheck: 'checking',
          scriptType,
        },
      });

      // Check server health first
      if (context.updateServerHealth) {
        try {
          const healthResponse = await fetch(`${getServerUrl()}/health`, {
            method: "GET",
          });

          if (!healthResponse.ok) {
            // Server responded but not healthy
            context.updateServerHealth(outputId, 'unhealthy', `Server responded with status ${healthResponse.status}`);
          } else {
            // Server is healthy
            context.updateServerHealth(outputId, 'healthy');
          }
        } catch (error) {
          // Server is not running or unreachable
          context.updateServerHealth(outputId, 'unhealthy', error instanceof Error ? error.message : "Unknown error");
        }
      }

      // Wait for user approval (they can retry server check or cancel)
      try {
        approved = await context.requestApproval(outputId);
      } catch {
        approved = false;
      }

      if (!approved) {
        return {
          result: JSON.stringify({
            success: false,
            error: "Script execution cancelled by user",
          }),
        };
      }

      // Mark as running after approval
      if (context.updateExecutionStatus) {
        context.updateExecutionStatus(outputId, 'running');
      }
    } else if (context.outputEmitter) {
      // Fallback: emit without approval if requestApproval not available
      context.outputEmitter({
        type: 'script',
        content: script,
        metadata: {
          scriptType,
        },
      });
    }

    const serverUrl = getServerUrl();

    // Resolve the student/project context. If either is missing, fail fast
    // with a clear error before prompting for a passcode.
    let studentId: string;
    let projectId: string;
    try {
      ({ studentId, projectId } = getRequiredStudentProject());
    } catch (e) {
      if (context.updateExecutionStatus && outputId) {
        context.updateExecutionStatus(outputId, 'failed');
      }
      return {
        result: JSON.stringify({
          success: false,
          error: e instanceof Error ? e.message : "student_id/project_id not set",
        }),
      };
    }

    // Helper function to make the API request with a passcode
    const makeRequest = async (passcode: string) => {
      return await fetch(`${serverUrl}/api/run-script`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          script,
          scriptType,
          timeout,
          passcode,
          student_id: studentId,
          project_id: projectId,
        }),
      });
    };

    try {
      // Try to get passcode (from storage or prompt)
      let passcode = await getOrPromptPasscode(serverUrl);
      
      if (!passcode) {
        // User cancelled the prompt
        if (context.updateExecutionStatus && outputId) {
          context.updateExecutionStatus(outputId, 'failed');
        }
        return {
          result: JSON.stringify({
            success: false,
            error: "Passcode required but not provided",
          }),
        };
      }

      let response = await makeRequest(passcode);

      // If passcode is invalid (401), clear it and retry once
      if (response.status === 401) {
        clearPasscode(serverUrl);
        
        // Prompt for new passcode
        passcode = promptForPasscode(serverUrl);
        
        if (!passcode) {
          // User cancelled the retry prompt
          if (context.updateExecutionStatus && outputId) {
            context.updateExecutionStatus(outputId, 'failed');
          }
          return {
            result: JSON.stringify({
              success: false,
              error: "Invalid passcode. Authentication cancelled.",
            }),
          };
        }
        
        // Store the new passcode and retry
        storePasscode(serverUrl, passcode);
        response = await makeRequest(passcode);
      }

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        // Mark as failed
        if (context.updateExecutionStatus && outputId) {
          context.updateExecutionStatus(outputId, 'failed');
        }
        return {
          result: JSON.stringify({
            success: false,
            error: errorData.error || errorData.detail || `HTTP ${response.status}: ${response.statusText}`,
            hint: "Make sure the ai-research-coach server is reachable. To run locally: ai-research-coach start-server --passcode <your-passcode>",
          }),
        };
      }

      const data = await response.json();

      if (!data.success) {
        // Mark as failed
        if (context.updateExecutionStatus && outputId) {
          context.updateExecutionStatus(outputId, 'failed');
        }
        return {
          result: JSON.stringify({
            success: false,
            error: data.error || "Unknown error from file server",
          }),
        };
      }

      // Emit image outputs for created image files
      if (context.outputEmitter && data.createdFiles && Array.isArray(data.createdFiles)) {
        for (const filename of data.createdFiles) {
          if (isImageFile(filename)) {
            try {
              // Construct the relative path to the image file (within the session workspace)
              const imagePath = `${data.scriptDir}/${filename}`;

              // Fetch the image content as binary, scoped to this student/project
              const imageResponse = await fetch(
                `${getServerUrl()}/files/${studentId}/${projectId}/${imagePath}`
              );
              
              if (imageResponse.ok) {
                // Read as blob and convert to base64
                const blob = await imageResponse.blob();
                const arrayBuffer = await blob.arrayBuffer();
                const bytes = new Uint8Array(arrayBuffer);
                let binary = '';
                for (let i = 0; i < bytes.byteLength; i++) {
                  binary += String.fromCharCode(bytes[i]);
                }
                const base64Content = btoa(binary);
                
                // Emit the image output
                context.outputEmitter({
                  type: 'image',
                  content: base64Content,
                  metadata: {
                    relativePath: imagePath,
                    mimeType: getMimeType(filename),
                  },
                });
              }
            } catch (error) {
              console.error(`Failed to load image ${filename}:`, error);
            }
          }
        }
      }

      // Emit iframe outputs for created .figpack directories
      if (context.outputEmitter && data.createdDirectories && Array.isArray(data.createdDirectories)) {
        for (const dirname of data.createdDirectories) {
          if (dirname.endsWith('.figpack')) {
            try {
              // Construct the URL to the index.html file in the .figpack directory (session-scoped)
              const indexUrl = `${getServerUrl()}/files/${studentId}/${projectId}/${data.scriptDir}/${dirname}/index.html`;
              
              // Verify that index.html exists before creating the iframe
              try {
                const checkResponse = await fetch(indexUrl, { method: 'HEAD' });
                if (!checkResponse.ok) {
                  console.warn(`index.html not found in ${dirname}, skipping iframe output`);
                  continue;
                }
              } catch (error) {
                console.warn(`Failed to verify index.html in ${dirname}:`, error);
                continue;
              }
              
              // Emit the iframe output
              // Add a timestamp parameter to prevent caching issues
              const urlWithCacheBuster = `${indexUrl}?t=${Date.now()}`;
              context.outputEmitter({
                type: 'iframe',
                content: '',
                metadata: {
                  url: urlWithCacheBuster,
                  title: dirname,
                },
              });
            } catch (error) {
              console.error(`Failed to create iframe output for ${dirname}:`, error);
            }
          }
        }
      }

      // Mark as completed
      if (context.updateExecutionStatus && outputId) {
        context.updateExecutionStatus(outputId, 'completed');
      }

      // Emit the output after execution
      if (context.outputEmitter) {
        const outputContent = data.stdout || '';
        const stderrContent = data.stderr || '';
        const combinedOutput = stderrContent
          ? `${outputContent}\n\n--- stderr ---\n${stderrContent}`
          : outputContent;

        context.outputEmitter({
          type: 'script-execution-output',
          content: combinedOutput || '(no output)',
          metadata: {
            exitCode: data.exitCode,
            scriptPath: data.scriptPath,
            stderr: data.stderr,
            scriptType,
          },
        });
      }

      return {
        result: JSON.stringify({
          success: true,
          scriptDir: data.scriptDir,
          scriptPath: data.scriptPath,
          exitCode: data.exitCode,
          stdout: data.stdout,
          stderr: data.stderr,
          timeout: data.timeout,
          message: data.message,
        }),
      };
    } catch (error) {
      // Mark as failed
      if (context.updateExecutionStatus && outputId) {
        context.updateExecutionStatus(outputId, 'failed');
      }
      return {
        result: JSON.stringify({
          success: false,
          error: `Failed to connect to file server: ${error instanceof Error ? error.message : "Unknown error"}`,
          hint: "Make sure the ai-research-coach server is reachable. To run locally: ai-research-coach start-server --passcode <your-passcode>",
        }),
      };
    }
  },

  getDetailedDescription: () => {
    return `Execute a script (Python or shell) with a configurable timeout. The script is saved to a timestamped temporary directory.

Examples:
- Python: { "script": "print('Hello, World!')", "scriptType": "python", "timeout": 10 }
- Shell: { "script": "#!/bin/bash\\necho 'Hello, World!'", "scriptType": "shell", "timeout": 10 }

Do not create any potentially harmful scripts.

If the user explicitly asks about a certain directory on their system, you can use that path in your scripts. Otherwise, you should stick to working in the temporary script directory.

For Python scripts, if creating plots, write to image files rather than using .show()

Returns exit code, stdout, stderr, and the script location. Timeout defaults to 10 seconds (max 60).

If the script generates image files, those will be shown to the user, although you will not have direct access to their contents.

If the script creates a directory with a name ending in .figpack (e.g., example.figpack) containing an index.html file, it will be displayed to the user as an embedded iframe. You do not need to create the iframe yourself.

`;
  },
};
