import Anthropic from "@anthropic-ai/sdk";
import type { ModelProvider } from "../provider.js";
import { AnthropicProvider } from "./anthropic.js";
import { BedrockProvider } from "./bedrock.js";

export type ProviderName = "anthropic" | "openai" | "gemini" | "bedrock";

export type ProviderFactoryResult = {
  provider: ModelProvider;
  providerName: ProviderName;
  model: string;
};

function normalizeProviderName(value: string | undefined): ProviderName {
  if (!value || value.trim() === "") {
    throw new Error(
      "AI_PROVIDER environment variable is required. Supported values: anthropic, openai, gemini, bedrock"
    );
  }

  const provider = value.trim().toLowerCase();

  if (
    provider === "anthropic" ||
    provider === "openai" ||
    provider === "gemini" ||
    provider === "bedrock"
  ) {
    return provider;
  }

  throw new Error(
    `Unsupported AI_PROVIDER '${value}'. Supported values: anthropic, openai, gemini, bedrock`
  );
}

export function createProviderFromEnv(
  maxTokens: number
): ProviderFactoryResult {
  const providerName = normalizeProviderName(process.env.AI_PROVIDER);

  switch (providerName) {
    case "anthropic": {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      const model = process.env.ANTHROPIC_MODEL;

      if (!apiKey) {
        throw new Error("ANTHROPIC_API_KEY environment variable is required");
      }

      if (!model) {
        throw new Error(
          "ANTHROPIC_MODEL environment variable is required when AI_PROVIDER=anthropic"
        );
      }

      const client = new Anthropic({ apiKey });
      const provider = new AnthropicProvider(client, { model, maxTokens });

      return { provider, providerName, model };
    }

    case "openai": {
      throw new Error(
        "AI_PROVIDER=openai is not implemented yet. Add an OpenAI adapter under src/providers/ and wire it in provider-factory."
      );
    }

    case "gemini":
      throw new Error("AI_PROVIDER=gemini is not implemented yet...");

    case "bedrock": {
      const model = process.env.BEDROCK_MODEL;
      const region = process.env.AWS_REGION;

      if (!model) {
        throw new Error(
          "BEDROCK_MODEL environment variable is required when AI_PROVIDER=bedrock\n" +
            "Example: anthropic.claude-3-5-sonnet-20241022-v2:0"
        );
      }

      if (!region) {
        throw new Error(
          "AWS_REGION environment variable is required when AI_PROVIDER=bedrock"
        );
      }

      // AWS credentials are resolved automatically by the SDK via the
      // standard credential provider chain (e.g. env vars, IAM role etc.)
      const provider = new BedrockProvider({ model, maxTokens, region });

      return { provider, providerName, model };
    }
  }
}
