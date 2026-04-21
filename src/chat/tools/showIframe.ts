import { QPTool, ToolExecutionContext } from "../types";

/**
 * A tool that allows the AI to display an iframe in the output panel.
 */

export const showIframeTool: QPTool = {
  toolFunction: {
    name: "show_iframe",
    description:
      "Display an iframe in the output panel with a given URL. Use this to show interactive web content, embedded applications, visualizations, or any web page to the user.",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description:
            "The URL to display in the iframe. Must be a valid URL with http:// or https:// protocol.",
        },
        title: {
          type: "string",
          description:
            "An optional title or description for the iframe content.",
        },
      },
      required: ["url"],
    },
  },

  execute: async (
    params: { url: string; title?: string },
    context: ToolExecutionContext
  ) => {
    const { url, title } = params;

    // Validate URL format
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      return {
        result: JSON.stringify({
          success: false,
          error: `Invalid URL format: "${url}". Please provide a valid URL with http:// or https:// protocol.`,
        }),
      };
    }

    // Check protocol (only allow http/https for security)
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      return {
        result: JSON.stringify({
          success: false,
          error: `Invalid URL protocol: "${parsedUrl.protocol}". Only http:// and https:// URLs are allowed.`,
        }),
      };
    }

    // Emit the iframe output
    if (context.outputEmitter) {
      const outputId = context.outputEmitter({
        type: "iframe",
        content: url, // Store the URL as content
        metadata: {
          url,
          title,
        },
      });

      return {
        result: JSON.stringify({
          success: true,
          message: "Iframe displayed successfully",
          url,
          title: title || "Untitled",
          outputId,
        }),
      };
    }

    return {
      result: JSON.stringify({
        success: false,
        error: "Output emitter not available in execution context",
      }),
    };
  },

  getDetailedDescription: () => {
    return `Use this tool to display an iframe in the output panel

**Usage:**
- Provide the URL you want to display
- Optionally provide a title/description for the content

**Notes:**
- Only http:// and https:// URLs are supported
- The iframe will be displayed with a default height and can be expanded by the user
- Users can also open the URL in a new browser tab
- Some websites may not allow being embedded in iframes (X-Frame-Options header)

**Examples:**
- Interactive data visualizations
- Embedded applications or tools
- Maps or location services
- Documentation pages
- Any web content that supports iframe embedding`;
  },
};
