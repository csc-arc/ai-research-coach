import { Tool, ToolContext } from "../../react-ai-chat";
import type { ToolExecutionContext } from "../types";
import { fetchUrlTool } from "./fetchUrl";
import { runScriptTool } from "./runScript";
import { showIframeTool } from "./showIframe";

export const fetchUrl: Tool = {
  toolFunction: fetchUrlTool.toolFunction,
  execute: async (params: unknown, context: ToolContext) => {
    return fetchUrlTool.execute(params, context as unknown as ToolExecutionContext);
  },
  getDetailedDescription: fetchUrlTool.getDetailedDescription,
};

export const showIframe: Tool = {
  toolFunction: showIframeTool.toolFunction,
  execute: async (params: unknown, context: ToolContext) => {
    return showIframeTool.execute(params, context as unknown as ToolExecutionContext);
  },
  getDetailedDescription: showIframeTool.getDetailedDescription,
};

/**
 * All available tools for the chat
 */
export const tools: Tool[] = [
  fetchUrl,
  runScriptTool,
  showIframe,
];
