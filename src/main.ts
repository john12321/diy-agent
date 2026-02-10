import Anthropic from "@anthropic-ai/sdk";
import "dotenv/config";
import { createGetUserMessage } from "./input-handler.js";
import { Agent } from "./agent.js";
import {
  DateTimeTool,
  EditFileTool,
  ReadFileTool,
  LtftCalculatorTool,
  UseBashTool
} from "./tools.js";
import { MAX_TOKENS } from "./constants.js";

const config = {
  apiKey: process.env.ANTHROPIC_API_KEY,
  model: process.env.ANTHROPIC_MODEL,
  maxTokens: MAX_TOKENS
};

if (!config.apiKey) {
  throw new Error("ANTHROPIC_API_KEY environment variable is required");
}

const client = new Anthropic({
  apiKey: config.apiKey
});

const getUserMessage = createGetUserMessage();

const tools = [
  DateTimeTool,
  ReadFileTool,
  EditFileTool,
  LtftCalculatorTool,
  UseBashTool
];

if (config.model) {
  const agent = new Agent(
    client,
    getUserMessage,
    { model: config.model, maxTokens: config.maxTokens },
    tools
  );

  try {
    await agent.run();
  } catch (error) {
    if (error instanceof Error) {
      console.error(`Error: ${error.message}`);
    } else {
      console.error("Error:", error);
    }
  }
} else {
  console.error(
    "Error: You need to set the ANTHROPIC_MODEL for your chat agent."
  );
}
