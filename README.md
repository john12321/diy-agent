# DIY Agent

This is a simple, extensible conversational AI agent that runs in your terminal and supports pluggable model providers (currently Anthropic, AWS Bedrock, and OpenAI-compatible Chat Completions APIs). It's designed to be easy to understand, modify, and extend with new tools.

It is a TS implementation of <https://ampcode.com/how-to-build-an-agent> to get some practice building an agent.

## Features

- **Conversational Interface**: Chat with Claude from your terminal.
- **Tool Use**: The agent can use a predefined set of tools to interact with your system (e.g., read/write files, get the current date/time, make a CCT Calculation for LTFT).
- **File Editing Logic**: The `edit_file` tool shows a diff in the CLI and includes a confirmation step before making changes to your files.
- **Universal Tool Use**: The agent can also access a universal `use_bash` tool which is handy for finding your files before destroying them `edit_file`.
- **Conversation History**: Automatically saves your conversation to a JSON file when you exit.
- **Graceful Shutdown**: Handles `Ctrl+C` to ensure conversations are saved before exiting.
- **Tool Timeout**: Tools will time out after 30 seconds to prevent hangs.
- **Input Validation**: Basic validation for tool inputs.
- **Context Management**: Keeps the last 50 messages in the conversation history to avoid exceeding context window limits.

## Setup

1.  **Clone the repository:**

    ```bash
    git clone <repository-url>
    cd diy-agent
    ```

2.  **Install dependencies:**

    ```bash
    npm install
    ```

3.  **Set up your environment variables:**
    Copy `.env.example` to `.env` and choose a provider.

    ```bash
    cp .env.example .env
    ```

    **Anthropic**

    ```
    AI_PROVIDER="anthropic"
    ANTHROPIC_API_KEY="your-api-key-here"
    ANTHROPIC_MODEL="claude-sonnet-4-20250514"
    ```

    **AWS Bedrock**

    ```
    AI_PROVIDER="bedrock"
    BEDROCK_MODEL="anthropic.claude..."
    AWS_REGION="eu-west-2"
    ```

    **OpenAI-compatible API**

    ```
    AI_PROVIDER="openai"
    OPENAI_API_KEY="your-api-key-here"
    OPENAI_MODEL="gpt-4o-mini"
    # Optional: defaults to https://api.openai.com/v1
    OPENAI_BASE_URL="https://api.openai.com/v1"
    ```

    Bedrock credentials are resolved by the AWS SDK credential provider chain (e.g.: `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`, `AWS_PROFILE`, IAM role credentials).

### Quick provider switch

If your `.env` already contains valid keys/models for each provider, you can temporarily switch provider per run:

```bash
AI_PROVIDER=anthropic npm run dev
AI_PROVIDER=bedrock npm run dev
AI_PROVIDER=openai npm run dev
```

## Usage

### Build the project

This will compile the TypeScript files into JavaScript in the `dist` directory.

```bash
npm run build
```

### Start the agent

To run the agent after building:

```bash
npm run start
```

### Development mode

To run the agent directly with `ts-node` for development (which compiles and runs on the fly):

```bash
npm run dev
```

Once the agent is running, you can type your messages in the terminal. To exit, type `exit` or `quit`, or press `Ctrl+C`.
