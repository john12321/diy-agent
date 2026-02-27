import "dotenv/config";
import { createGetUserMessage } from "./input-handler.js";
import { Agent } from "./agent.js";
import { createProviderFromEnv } from "./providers/provider-factory.js";
import {
  DateTimeTool,
  EditFileTool,
  ReadFileTool,
  LtftCalculatorTool,
  UseBashTool
} from "./tools.js";
import { MAX_TOKENS } from "./constants.js";

const getUserMessage = createGetUserMessage();

const tools = [
  DateTimeTool,
  ReadFileTool,
  EditFileTool,
  LtftCalculatorTool,
  UseBashTool
];

try {
  const { provider, providerName, model } = createProviderFromEnv(MAX_TOKENS);
  console.log(`Using provider: ${providerName} (model: ${model})`);
  const agent = new Agent(provider, getUserMessage, tools);

  await agent.run();
} catch (error) {
  if (error instanceof Error) {
    console.error(`Error: ${error.message}`);
  } else {
    console.error("Error:", error);
  }
}
