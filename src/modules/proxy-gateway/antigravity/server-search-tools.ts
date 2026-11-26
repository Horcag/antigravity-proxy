import { isPlainObject, isString } from 'lodash-es';
import type { GeminiToolDeclaration, Tool } from './types';

const SERVER_SEARCH_TOOL_TYPES = new Set([
  'web_search_20250305',
  'web_search_20260209',
  'google_search',
  'google_search_retrieval',
  'builtin_web_search',
]);

const SERVER_SEARCH_TOOL_NAMES = new Set([
  'google_search',
  'web_search_20250305',
  'web_search_20260209',
  'google_search_retrieval',
  'builtin_web_search',
]);

function hasCustomFunctionParameters(schema: unknown): boolean {
  if (!isPlainObject(schema)) {
    return false;
  }
  const props = (schema as { properties?: unknown }).properties;
  return isPlainObject(props) && Object.keys(props as Record<string, unknown>).length > 0;
}

/**
 * Distinguishes provider/server-side web search grounding markers from custom
 * client function tools that happen to be named `web_search`.
 */
export function isBuiltinServerSearchTool(tool: Tool | GeminiToolDeclaration): boolean {
  const toolType = (tool as { type?: unknown }).type;
  if (isString(toolType) && SERVER_SEARCH_TOOL_TYPES.has(toolType.toLowerCase())) {
    return true;
  }

  const toolName = (tool as { name?: unknown }).name;
  if (isString(toolName)) {
    const normalizedName = toolName.toLowerCase();
    if (SERVER_SEARCH_TOOL_NAMES.has(normalizedName)) {
      return true;
    }
    if (
      normalizedName === 'web_search' &&
      !hasCustomFunctionParameters((tool as { input_schema?: unknown }).input_schema)
    ) {
      return true;
    }
  }

  const openaiTool = tool as {
    function?: { name?: unknown; parameters?: unknown };
  };
  if (isString(openaiTool.function?.name)) {
    const normalizedFnName = openaiTool.function.name.toLowerCase();
    if (SERVER_SEARCH_TOOL_NAMES.has(normalizedFnName)) {
      return true;
    }
    if (
      normalizedFnName === 'web_search' &&
      !hasCustomFunctionParameters(openaiTool.function.parameters)
    ) {
      return true;
    }
  }

  if ('functionDeclarations' in tool && tool.functionDeclarations) {
    for (const decl of tool.functionDeclarations) {
      if (decl.name && SERVER_SEARCH_TOOL_NAMES.has(decl.name.toLowerCase())) {
        return true;
      }
    }
  }

  if ('googleSearch' in tool && tool.googleSearch) {
    return true;
  }
  if ('googleSearchRetrieval' in tool && tool.googleSearchRetrieval) {
    return true;
  }

  return false;
}

/**
 * Detects if server-side networking/grounding tools are present.
 * Supports server-side Claude Tool and Gemini GeminiToolDeclaration formats.
 */
export function detectsNetworkingTool(tools?: (Tool | GeminiToolDeclaration)[]): boolean {
  if (!tools) {
    return false;
  }

  return tools.some((tool) => isBuiltinServerSearchTool(tool));
}
