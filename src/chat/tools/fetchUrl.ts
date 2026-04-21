import { QPTool, ToolExecutionContext } from "../types";

/**
 * A tool that allows the AI to fetch content from external URLs.
 */

export const fetchUrlTool: QPTool = {
  toolFunction: {
    name: "fetch_url",
    description:
      "Fetch content from an external URL to retrieve information.",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description:
            "The URL to fetch content from. Must be a valid URL.",
        },
        reason: {
          type: "string",
          description:
            "A brief explanation of why you need to fetch this URL and what information you're looking for.",
        },
      },
      required: ["url"],
    },
  },

  execute: async (
    params: { url: string; reason?: string },
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _context: ToolExecutionContext
  ) => {
    const { url, reason } = params;

    // Validate URL format
    try {
      new URL(url);
    } catch {
      return {
        result: JSON.stringify({
          success: false,
          error: `Invalid URL format: "${url}". Please provide a valid URL.`,
        }),
      };
    }

    try {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          Accept: "application/json,text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
      });

      if (!response.ok) {
        return {
          result: JSON.stringify({
            success: false,
            error: `Failed to fetch URL: HTTP ${response.status} ${response.statusText}`,
            url,
          }),
        };
      }

      const contentType = response.headers.get("content-type") || "";
      let content: string;

      let jsonContent: unknown = null;
      if (contentType.includes("application/json")) {
        jsonContent = await response.json();
        content = JSON.stringify(jsonContent, null, 2);
      } else {
        // For HTML/text content, get the raw text
        const html = await response.text();
        // Extract meaningful text from HTML, removing scripts and styles
        content = extractTextFromHtml(html);
      }

      // Truncate if too long (to avoid overwhelming the context)
      const maxLength = 25000;
      const truncated = content.length > maxLength;
      const finalContent = truncated
        ? content.substring(0, maxLength) + "\n\n[Content truncated due to length...]"
        : content;

      return {
        result: JSON.stringify(
          {
            success: true,
            url,
            reason: reason || "Not specified",
            contentLength: content.length,
            truncated,
            // For JSON responses, include the parsed object directly to avoid double-stringification
            // For HTML/text responses, include the extracted text
            content: jsonContent && !truncated ? jsonContent : finalContent,
          },
          null,
          2
        ),
      };
    } catch (error) {
      return {
        result: JSON.stringify({
          success: false,
          error: `Error fetching URL: ${error instanceof Error ? error.message : "Unknown error"}`,
          url,
        }),
      };
    }
  },

  getDetailedDescription: () => {
    return `Use this tool to fetch content from external URLs

**Usage:**
- Provide the URL you want to fetch
- Optionally explain why you need to fetch it

**Notes:**
- Content is returned as text extracted from the webpage
- Very long content will be truncated
- If fetching fails, an error message will explain why`;
  },
};

/**
 * Extract readable text from HTML, removing scripts, styles, and excessive whitespace
 */
function extractTextFromHtml(html: string): string {
  // Remove script and style elements
  let text = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, " ");
  text = text.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, " ");

  // Remove HTML comments
  text = text.replace(/<!--[\s\S]*?-->/g, " ");

  // Remove HTML tags but keep their content
  text = text.replace(/<[^>]+>/g, " ");

  // Decode common HTML entities
  text = text.replace(/&nbsp;/g, " ");
  text = text.replace(/&amp;/g, "&");
  text = text.replace(/&lt;/g, "<");
  text = text.replace(/&gt;/g, ">");
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#39;/g, "'");
  text = text.replace(/&rsquo;/g, "'");
  text = text.replace(/&lsquo;/g, "'");
  text = text.replace(/&rdquo;/g, '"');
  text = text.replace(/&ldquo;/g, '"');
  text = text.replace(/&mdash;/g, "—");
  text = text.replace(/&ndash;/g, "–");

  // Collapse multiple whitespace characters into single spaces
  text = text.replace(/\s+/g, " ");

  // Trim
  text = text.trim();

  return text;
}
