export interface Message {
  role: "user" | "assistant";
  content: string | ContentBlock[];
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export interface ModelResponse {
  content: ContentBlock[];
  stop_reason: "tool_use" | "end_turn" | "max_tokens";
}

export interface ToolInputSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: ToolInputSchema;
  execute: (input: Record<string, unknown>) => Promise<string> | string;
}

export type ProviderToolChoice = "auto" | "any" | { tool: string };

export interface GenerateResponseOptions {
  toolChoice?: ProviderToolChoice;
}

export interface ModelProvider {
  generateResponse(
    messages: Message[],
    tools: ToolDefinition[],
    systemPrompt?: string,
    options?: GenerateResponseOptions
  ): Promise<ModelResponse>;
}
