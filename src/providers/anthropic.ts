import Anthropic from "@anthropic-ai/sdk";
import type {
  ContentBlock,
  GenerateResponseOptions,
  Message,
  ModelProvider,
  ModelResponse,
  ToolDefinition
} from "../provider.js";
import { normalizeStopReason } from "../utils/normalize-stop-reason.js";

type AnthropicProviderConfig = {
  model: string;
  maxTokens: number;
};

export class AnthropicProvider implements ModelProvider {
  private readonly client: Anthropic;
  private readonly config: AnthropicProviderConfig;

  constructor(client: Anthropic, config: AnthropicProviderConfig) {
    this.client = client;
    this.config = config;
  }

  async generateResponse(
    messages: Message[],
    tools: ToolDefinition[],
    systemPrompt?: string,
    _options?: GenerateResponseOptions
  ): Promise<ModelResponse> {
    const response = await this.client.messages.create({
      model: this.config.model,
      max_tokens: this.config.maxTokens,
      messages: messages as Anthropic.MessageParam[],
      system: systemPrompt,
      tools: tools.map(tool => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.input_schema as Anthropic.Tool.InputSchema
      }))
    });

    return {
      content: response.content as ContentBlock[],
      stop_reason: normalizeStopReason(response.stop_reason)
    };
  }
}
