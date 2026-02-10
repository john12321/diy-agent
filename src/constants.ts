// --- Language detection constants ---

export const EXTENSION_LANGUAGE_MAP: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".jsx": "jsx",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".rb": "ruby",
  ".rs": "rust",
  ".go": "go",
  ".java": "java",
  ".kt": "kotlin",
  ".swift": "swift",
  ".cs": "csharp",
  ".cpp": "cpp",
  ".c": "c",
  ".h": "c",
  ".hpp": "cpp",
  ".css": "css",
  ".scss": "scss",
  ".html": "html",
  ".vue": "vue",
  ".svelte": "svelte",
  ".json": "json",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
  ".xml": "xml",
  ".md": "markdown",
  ".sql": "sql",
  ".sh": "bash",
  ".bash": "bash",
  ".zsh": "zsh",
  ".dockerfile": "dockerfile",
  ".tf": "terraform",
  ".lua": "lua",
  ".r": "r",
  ".php": "php",
  ".ex": "elixir",
  ".exs": "elixir"
};

export const EXTENSIONLESS_FILE_LANGUAGE_MAP: Record<string, string> = {
  dockerfile: "dockerfile",
  makefile: "makefile",
  rakefile: "ruby",
  gemfile: "ruby",
  ".gitignore": "gitignore",
  ".env": "dotenv"
};

// --- Binary file detection ---

export const BINARY_CHECK_BUFFER_SIZE = 8192; // 8KB

// --- DateTime tool defaults ---

export const DEFAULT_TIMEZONE = "Europe/London";

// --- Bash tool configuration ---

export const MAX_OUTPUT_BYTES = 100_000;
export const DEFAULT_TIMEOUT_MS = 30_000;

export const BLOCKED_BASH_PATTERNS = [
  /\brm\s+-[^\s]*r[^\s]*f/, // rm -rf, rm -fr, etc.
  /\brm\s+-[^\s]*f[^\s]*r/,
  /\bmkfs\b/,
  /\bdd\s+.*of=\/dev/,
  /:\(\)\{ :\|:& \};:/, // fork bomb
  /\b>\/dev\/sd[a-z]/,
  /\bshutdown\b/,
  /\breboot\b/
];

// --- Agent configuration ---

export const SYSTEM_PROMPT = `You are a helpful assistant with access to various tools. Follow these principles:

- Always use tools rather than guessing. In particular, never assume the current date or time — use the get_current_datetime tool.
- The user is based in the UK. When interpreting dates, assume DD/MM/YYYY (UK format) unless the user specifies otherwise. If ambiguous, ask for clarification.
- When a tool returns an error, read the error message carefully — it often suggests the correct recovery action.
- Present tool results in a clear, conversational way. Do not dump raw JSON to the user.

Tool selection guidance:
- For file discovery, searching, and any filesystem exploration, use use_bash (e.g. find, ls, tree, grep, fd). It supports glob patterns, piped output, and regex natively.
- For reading file contents, use read_file. For editing files, use edit_file.
- For anything else on the command line (git, system info, text processing, etc.), use use_bash.`;

export const MAX_TOOL_TURNS = 10;

// --- ANSI colour codes ---
export const COLOURS = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  blue: "\u001b[94m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\u001b[93m",
  red: "\x1b[31m",
  grey: "\x1b[90m",
  bgRed: "\x1b[41m",
  bgGreen: "\x1b[42m"
};

export const MAX_TOKENS = 4096;
