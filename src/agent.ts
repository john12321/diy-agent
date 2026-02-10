import Anthropic from "@anthropic-ai/sdk";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ToolDefinition } from "./tools.js";
import { SYSTEM_PROMPT, MAX_TOOL_TURNS, COLOURS } from "./constants.js";

export class Agent {
  private readonly client: Anthropic;
  private readonly getUserMessage: () => Promise<string | null>;
  private readonly config: {
    model: string;
    maxTokens: number;
  };
  private readonly tools: ToolDefinition[];

  constructor(
    client: Anthropic,
    getUserMessage: () => Promise<string | null>,
    config: { model: string; maxTokens: number },
    tools: ToolDefinition[] = []
  ) {
    this.client = client;
    this.getUserMessage = getUserMessage;
    this.config = config;
    this.tools = tools;
  }

  async run(): Promise<void> {
    let conversation: Anthropic.MessageParam[] = [];

    // Handle Ctrl+C (SIGINT)
    let isShuttingDown = false;
    const handleSignal = async () => {
      if (isShuttingDown) return;
      isShuttingDown = true;
      if (conversation.length > 0) {
        console.log(
          `\n${COLOURS.yellow}Saving conversation...${COLOURS.reset}`
        );
        await this.saveConversation(conversation);
      }
      process.exit(0);
    };

    process.on("SIGINT", handleSignal);
    process.on("SIGTERM", handleSignal);

    try {
      console.log("Chat with Claude (type 'exit' or 'quit' to stop)");

      while (true) {
        process.stdout.write(`${COLOURS.blue}You${COLOURS.reset}: `);
        const userInput = await this.getUserMessage();

        if (userInput === null) {
          break;
        }

        const trimmedInput = userInput.trim();

        if (trimmedInput === "") {
          continue;
        }

        if (
          trimmedInput.toLowerCase() === "exit" ||
          trimmedInput.toLowerCase() === "quit"
        ) {
          break;
        }

        const userMessage: Anthropic.MessageParam = {
          role: "user",
          content: userInput
        };
        conversation.push(userMessage);
        // keep last 50 messages so we don't blow up context,
        // but ensure we don't slice in the middle of a tool-use/tool-result pair
        if (conversation.length > 50) {
          let sliceIndex = conversation.length - 50;
          // Walk forward to find a safe boundary: a 'user' message whose
          // content is a plain string (not a tool_result array)
          while (sliceIndex < conversation.length) {
            const msg = conversation[sliceIndex];
            if (msg.role === "user" && typeof msg.content === "string") {
              break;
            }
            sliceIndex++;
          }
          conversation = conversation.slice(sliceIndex);
        }

        process.stdout.write(`${COLOURS.yellow}Claude${COLOURS.reset}: `);
        const assistantMessage = await this.runInference(conversation);
        console.log(""); // New line after streaming completes

        conversation.push({
          role: "assistant",
          content: assistantMessage
        });
      }

      console.log("\nShutdown initiated...");
      await this.saveConversation(conversation);
      console.log("Goodbye!");
    } finally {
      process.off("SIGINT", handleSignal);
      process.off("SIGTERM", handleSignal);
    }
  }

  private async saveConversation(conversation: Anthropic.MessageParam[]) {
    if (conversation.length === 0) return;

    try {
      const timestamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
      const filename = `conversation-${timestamp}.json`;
      const filePath = path.join(process.cwd(), filename);

      await fs.writeFile(filePath, JSON.stringify(conversation, null, 2));
      console.log(
        `${COLOURS.green}Conversation saved to ${filePath}${COLOURS.reset}`
      );
    } catch (error) {
      console.error(
        `${COLOURS.red}Failed to save conversation: ${error}${COLOURS.reset}`
      );
    }
  }

  private async runInference(
    conversation: Anthropic.MessageParam[]
  ): Promise<Anthropic.ContentBlock[]> {
    let continueLoop = true;
    let currentContent: Anthropic.ContentBlock[] = [];
    let toolTurns = 0;

    while (continueLoop) {
      const params: Anthropic.MessageCreateParams = {
        model: this.config.model,
        max_tokens: this.config.maxTokens,
        messages: conversation,
        system: SYSTEM_PROMPT
      };

      if (this.tools.length > 0) {
        params.tools = this.tools.map(tool => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.input_schema
        }));
      }

      const response = await this.client.messages.create(params);
      currentContent = response.content;

      const toolUseBlocks = currentContent.filter(
        (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
      );

      if (toolUseBlocks.length > 0 && response.stop_reason === "tool_use") {
        toolTurns++;
        if (toolTurns > MAX_TOOL_TURNS) {
          console.log(
            `\n${COLOURS.red}[Stopping: exceeded ${MAX_TOOL_TURNS} tool turns]${COLOURS.reset}`
          );
          break;
        }
        const toolResults = await this.executeTools(toolUseBlocks);
        conversation.push(
          {
            role: "assistant",
            content: currentContent
          },
          {
            role: "user",
            content: toolResults
          }
        );
      } else {
        // Print text blocks ONLY when no more tool use
        for (const block of currentContent) {
          if (block.type === "text") {
            process.stdout.write(block.text);
          }
        }
        continueLoop = false;
      }
    }

    return currentContent;
  }

  private async executeTools(
    toolUseBlocks: Anthropic.ToolUseBlock[]
  ): Promise<Anthropic.ToolResultBlockParam[]> {
    const results = await Promise.all(
      toolUseBlocks.map(async toolUse => {
        console.log(
          `\n${COLOURS.cyan}[Tool Use: ${toolUse.name}]${COLOURS.reset}`
        );

        // Only log input if it's not empty
        if (
          toolUse.input &&
          typeof toolUse.input === "object" &&
          !Array.isArray(toolUse.input) &&
          Object.keys(toolUse.input).length > 0
        ) {
          console.log(`Input: ${JSON.stringify(toolUse.input, null, 2)}`);
        }

        const toolDef = this.tools.find(t => t.name === toolUse.name);

        if (!toolDef) {
          console.log(
            `${COLOURS.red}[Error: Tool ${toolUse.name} not found]${COLOURS.reset}`
          );
          return {
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: `Error: Tool ${toolUse.name} not found`,
            is_error: true
          } as Anthropic.ToolResultBlockParam;
        }

        try {
          this.validateInput(toolUse.input, toolDef.input_schema);

          // Special handling for edit_file with confirm: true - require user approval
          if (
            toolUse.name === "edit_file" &&
            toolUse.input &&
            typeof toolUse.input === "object" &&
            "confirm" in toolUse.input &&
            toolUse.input.confirm === true
          ) {
            process.stdout.write(
              `\n${COLOURS.yellow}⚠️  Do you approve these changes? (yes/no): ${COLOURS.reset}`
            );
            const approval = await this.getUserMessage();

            if (
              approval?.trim().toLowerCase() !== "yes" &&
              approval?.trim().toLowerCase() !== "y"
            ) {
              console.log(
                `${COLOURS.red}[Edit cancelled by user]${COLOURS.reset}`
              );
              return {
                type: "tool_result",
                tool_use_id: toolUse.id,
                content: JSON.stringify({
                  error: "Edit cancelled by user. The changes were not made."
                }),
                is_error: true
              } as Anthropic.ToolResultBlockParam;
            }
            console.log(
              `${COLOURS.green}[User approved - proceeding with edit]${COLOURS.reset}`
            );
          }

          const executionPromise = toolDef.execute(
            toolUse.input as Record<string, unknown>
          );

          const timeoutPromise = new Promise<string>((_, reject) => {
            setTimeout(
              () => reject(new Error("Tool execution timed out after 30s")),
              30000
            );
          });

          const result = await Promise.race([executionPromise, timeoutPromise]);

          // Truncate result for logging
          const logResult =
            result.length > 100
              ? result.slice(0, 100) + "... (truncated)"
              : result;

          console.log(
            `${COLOURS.green}[Tool use result: ${logResult}]${COLOURS.reset}`
          );

          return {
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: result
          } as Anthropic.ToolResultBlockParam;
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          console.log(`${COLOURS.red}[Error: ${errorMessage}]${COLOURS.reset}`);

          return {
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: errorMessage,
            is_error: true
          } as Anthropic.ToolResultBlockParam;
        }
      })
    );

    console.log("");
    return results;
  }
  private validateInput(
    input: unknown,
    schema: Anthropic.Tool.InputSchema
  ): void {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      throw new Error("Input must be a valid object");
    }

    const jsonSchema = schema as { required?: string[] };
    if (jsonSchema.required && Array.isArray(jsonSchema.required)) {
      const inputObj = input as Record<string, unknown>;
      const missing = jsonSchema.required.filter(field => !(field in inputObj));
      if (missing.length > 0) {
        throw new Error(`Missing required fields: ${missing.join(", ")}`);
      }
    }
  }
}
