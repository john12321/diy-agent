import Anthropic from "@anthropic-ai/sdk";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

function expandTilde(filePath: string): string {
  if (filePath.startsWith("~/") || filePath === "~") {
    return path.join(os.homedir(), filePath.slice(1));
  }
  return filePath;
}

export type ToolDefinition = {
  name: string;
  description: string;
  input_schema: Anthropic.Tool.InputSchema;
  execute: (input: Record<string, unknown>) => Promise<string> | string;
};

export const DateTimeTool: ToolDefinition = {
  name: "get_current_datetime",
  description: `Returns the current date and time. This is the authoritative source for the current date and time — always use this tool rather than guessing or assuming the date.

If no timezone is provided, defaults to Europe/London (UK time). You can optionally provide a different IANA timezone identifier (e.g., 'America/New_York', 'Asia/Tokyo').

Returns structured data including the ISO 8601 date, time, day of week, and UTC offset.`,
  input_schema: {
    type: "object",
    properties: {
      timezone: {
        type: "string",
        description:
          "IANA timezone identifier (e.g., 'Europe/London', 'America/New_York'). Defaults to 'Europe/London' if not provided."
      }
    },
    required: []
  },
  execute: async (input: Record<string, unknown>) => {
    const now = new Date();
    const timezone = (input.timezone as string) || "Europe/London";

    try {
      const parts = new Intl.DateTimeFormat("en-GB", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        weekday: "long",
        hour12: false
      }).formatToParts(now);

      const get = (type: string) =>
        parts.find(p => p.type === type)?.value ?? "";

      const date = `${get("year")}-${get("month")}-${get("day")}`;
      const time = `${get("hour")}:${get("minute")}:${get("second")}`;

      const result = {
        timezone,
        date,
        time,
        day_of_week: get("weekday"),
        utc_iso: now.toISOString()
      };

      return JSON.stringify(result, null, 2);
    } catch (error) {
      console.error(`Invalid timezone: ${timezone}`, error);
      return JSON.stringify({
        error: `Invalid timezone '${timezone}'.`,
        utc_iso: now.toISOString()
      });
    }
  }
};

export const ReadFileTool: ToolDefinition = {
  name: "read_file",
  description: `Reads the contents of a file at the given path. Can read any file on the system.

The path can be absolute (e.g., '/etc/hosts'), home-relative (e.g., '~/Documents/notes.txt'), or relative to the current working directory (e.g., 'src/main.ts').

If you don't know the exact file path, use the list_files tool first to discover it. For large files, use the max_lines parameter to limit output and avoid flooding the conversation context.

Returns structured JSON with file metadata (path, total lines, size) and the file content.`,
  input_schema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "Path to the file. Can be absolute, home-relative (~), or relative to the current working directory."
      },
      max_lines: {
        type: "number",
        description:
          "Maximum number of lines to return. If the file is longer, content is truncated and total_lines will indicate the full size. Defaults to 1000."
      },
      offset: {
        type: "number",
        description:
          "Line number to start reading from (1-based). Use with max_lines to read specific sections of large files. Defaults to 1."
      }
    },
    required: ["path"]
  },
  execute: async (input: Record<string, unknown>) => {
    const inputPath = input.path as string;
    const maxLines = (input.max_lines as number) || 1000;
    const offset = Math.max(1, (input.offset as number) || 1);
    const workspaceRoot = process.cwd();

    try {
      const expandedPath = expandTilde(inputPath);
      const filePath = path.isAbsolute(expandedPath)
        ? expandedPath
        : path.resolve(workspaceRoot, expandedPath);

      const stats = await fs.stat(filePath);
      if (!stats.isFile()) {
        return `Error: '${inputPath}' is not a file.`;
      }

      const content = await fs.readFile(filePath, "utf-8");
      const allLines = content.split("\n");
      const totalLines = allLines.length;

      const startIndex = offset - 1;
      const slicedLines = allLines.slice(startIndex, startIndex + maxLines);
      const truncated = startIndex + maxLines < totalLines;

      const result: Record<string, unknown> = {
        path: filePath,
        total_lines: totalLines,
        size_bytes: stats.size,
        showing_lines: `${offset}-${Math.min(offset + slicedLines.length - 1, totalLines)}`,
        truncated,
        content: slicedLines.join("\n")
      };

      return JSON.stringify(result, null, 2);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        return `Error: File '${inputPath}' not found. Use list_files to discover available files.`;
      }
      if (err.code === "EPERM" || err.code === "EACCES") {
        return `Error: Permission denied reading '${inputPath}'.`;
      }
      return `Error: Could not read file '${inputPath}'. ${err.message || String(error)}`;
    }
  }
};

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "coverage",
  "__pycache__",
  ".cache"
]);

async function walkDirectory(
  dir: string,
  baseDir: string,
  files: string[] = [],
  maxDepth = 5,
  currentDepth = 0
): Promise<string[]> {
  if (currentDepth >= maxDepth) return files;

  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relativePath = path.relative(baseDir, fullPath);

      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name) && !entry.name.startsWith(".")) {
          files.push(relativePath + "/");
          await walkDirectory(
            fullPath,
            baseDir,
            files,
            maxDepth,
            currentDepth + 1
          );
        }
      } else {
        files.push(relativePath);
      }
    }
  } catch (error) {
    const err = error as NodeJS.ErrnoException;

    if (err.code !== "EPERM" && err.code !== "EACCES") {
      throw error;
    } else console.error(`Permission denied accessing directory ${dir}`);
  }

  return files;
}

export const ListFilesTool: ToolDefinition = {
  name: "list_files",
  description: `Lists files and directories at a given path. Use this tool to discover file paths before calling read_file or edit_file.

The path can be absolute, home-relative (~), or relative to the current working directory. If no path is provided, lists files in the current working directory.

By default, hidden directories (starting with '.') and common build/dependency directories (node_modules, dist, .git, etc.) are excluded. Set include_hidden to true if you need to see hidden files.

Returns structured JSON with the directory path, file count, and list of files. Directories have a trailing '/'.`,
  input_schema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "Path to list. Can be absolute, home-relative (~), or relative to the current working directory. Defaults to '.' if not provided."
      },
      max_depth: {
        type: "number",
        description:
          "Maximum directory depth to recurse into. Defaults to 5. Use 1 for a shallow listing of just the top-level contents."
      },
      include_hidden: {
        type: "boolean",
        description:
          "Whether to include hidden directories (those starting with '.'). Defaults to false."
      }
    },
    required: []
  },
  execute: async (input: Record<string, unknown>) => {
    const targetPath = (input.path as string) || ".";
    const maxDepth = (input.max_depth as number) || 5;
    const includeHidden = (input.include_hidden as boolean) || false;
    const workspaceRoot = process.cwd();
    const expandedPath = expandTilde(targetPath);
    const dir = path.isAbsolute(expandedPath)
      ? expandedPath
      : path.resolve(workspaceRoot, expandedPath);

    try {
      const stats = await fs.stat(dir);
      if (!stats.isDirectory()) {
        return JSON.stringify({ error: `'${targetPath}' is not a directory.` });
      }

      // Temporarily adjust IGNORED_DIRS behaviour for hidden dirs
      const origWalk = walkDirectory;
      let files: string[];
      if (includeHidden) {
        // Do a custom walk that doesn't skip dot-dirs
        files = await walkDirectoryWithHidden(dir, dir, [], maxDepth, 0);
      } else {
        files = await origWalk(dir, dir, [], maxDepth, 0);
      }

      const result = {
        path: dir,
        total_entries: files.length,
        max_depth: maxDepth,
        files
      };

      return JSON.stringify(result, null, 2);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "EPERM" || err.code === "EACCES") {
        return JSON.stringify({
          error: `Permission denied accessing '${targetPath}'.`
        });
      }
      if (err.code === "ENOENT") {
        return JSON.stringify({
          error: `Directory '${targetPath}' does not exist.`
        });
      }
      return JSON.stringify({
        error: `Could not list files in '${targetPath}': ${err.message || String(error)}`
      });
    }
  }
};

async function walkDirectoryWithHidden(
  dir: string,
  baseDir: string,
  files: string[] = [],
  maxDepth = 5,
  currentDepth = 0
): Promise<string[]> {
  if (currentDepth >= maxDepth) return files;

  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relativePath = path.relative(baseDir, fullPath);

      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) {
          files.push(relativePath + "/");
          await walkDirectoryWithHidden(
            fullPath,
            baseDir,
            files,
            maxDepth,
            currentDepth + 1
          );
        }
      } else {
        files.push(relativePath);
      }
    }
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== "EPERM" && err.code !== "EACCES") {
      throw error;
    }
  }

  return files;
}

async function createNewFile(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(filePath, content, "utf-8");
}

export const EditFileTool: ToolDefinition = {
  name: "edit_file",
  description: `Make edits to a text file by replacing an exact string match, or create a new file.

To edit an existing file: provide 'path', 'old_str' (the exact text to find), and 'new_str' (the replacement). 'old_str' must match exactly — use the read_file tool first to see the current contents and copy the exact text you want to replace.

To create a new file: provide 'path' and 'new_str' only (omit 'old_str'). Parent directories will be created automatically.

The path can be absolute, home-relative (~), or relative to the current working directory. If you don't know the exact path, use list_files to discover it first.`,
  input_schema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "Path to the file. Can be absolute, home-relative (~), or relative to the current working directory."
      },
      old_str: {
        type: "string",
        description:
          "The exact string to find and replace in the file. Omit when creating a new file."
      },
      new_str: {
        type: "string",
        description:
          "The replacement string. For new files, this becomes the entire file content."
      }
    },
    required: ["path", "new_str"]
  },
  execute: async (input: Record<string, unknown>) => {
    const oldStr = input.old_str as string | undefined;
    const newStr = input.new_str as string;
    const inputPath = input.path as string;
    const workspaceRoot = process.cwd();

    const expandedPath = expandTilde(inputPath);
    const filePath = path.isAbsolute(expandedPath)
      ? expandedPath
      : path.resolve(workspaceRoot, expandedPath);

    if (oldStr !== undefined && oldStr === newStr) {
      return JSON.stringify({
        error: "'old_str' and 'new_str' must be different."
      });
    }

    try {
      let fileExists = false;
      try {
        await fs.access(filePath);
        fileExists = true;
      } catch {
        fileExists = false;
      }

      if (!fileExists) {
        if (oldStr) {
          return JSON.stringify({
            error: `File '${inputPath}' not found. Cannot replace text in a file that doesn't exist. Use list_files to check available files.`
          });
        }
        await createNewFile(filePath, newStr);
        return JSON.stringify({
          success: true,
          action: "created",
          path: filePath
        });
      }

      if (!oldStr) {
        return JSON.stringify({
          error:
            "'old_str' is required when editing an existing file. To see the current contents, use read_file first."
        });
      }

      const content = await fs.readFile(filePath, "utf-8");

      const occurrences = content.split(oldStr).length - 1;
      if (occurrences === 0) {
        return JSON.stringify({
          error: `String not found in '${inputPath}'. Use read_file to check the current file contents and copy the exact text.`
        });
      }
      if (occurrences > 1) {
        return JSON.stringify({
          error: `Found ${occurrences} occurrences of old_str in '${inputPath}'. Include more surrounding context in old_str to match exactly one location.`
        });
      }

      const newContent = content.replace(oldStr, newStr);
      await fs.writeFile(filePath, newContent, "utf-8");

      return JSON.stringify({
        success: true,
        action: "edited",
        path: filePath
      });
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "EPERM" || err.code === "EACCES") {
        return JSON.stringify({
          error: `Permission denied writing to '${inputPath}'.`
        });
      }
      return JSON.stringify({
        error: `Could not edit file '${inputPath}'. ${err.message || String(error)}`
      });
    }
  }
};

export const LtftCalculatorTool: ToolDefinition = {
  name: "ltft_calculator",
  description: `Calculates the new CCT (Certificate of Completion of Training) date for an NHS Doctor changing to Less Than Full Time (LTFT) training.

IMPORTANT instructions for calling this tool:
- All dates MUST be provided in ISO 8601 format: YYYY-MM-DD. Convert any user-provided dates to this format before calling. If the user gives a date like "04/05/2026" and the context is UK, interpret it as 4th May 2026 (DD/MM/YYYY) and pass "2026-05-04". If there is genuine ambiguity about which part is the day vs month, ask the user to clarify BEFORE calling this tool.
- All percentages MUST be provided as a decimal between 0 and 1 (e.g., 80% → 0.8, 50% → 0.5, full-time → 1.0). Convert any user-provided percentage to this format before calling.
- The proposed_start_date cannot be in the past.
- Don't guess today's date - if you need to know the current date, call the get_current_datetime tool and use that to determine if proposed_start_date is valid and to calculate the new CCT date.
- Standard LTFT percentages are 50%, 60%, 70%, 80% (and 100% for return to full-time).`,

  input_schema: {
    type: "object",
    properties: {
      programme_name: {
        type: "string",
        description:
          "Name of the training programme (optional, defaults to 'Programme')."
      },
      current_cct_date: {
        type: "string",
        description: "Current CCT date in YYYY-MM-DD format."
      },
      current_work_percentage: {
        type: "number",
        description:
          "Current WTE as a decimal between 0 and 1 (e.g., 1.0 for full-time, 0.6 for 60%)."
      },
      proposed_work_percentage: {
        type: "number",
        description:
          "Proposed WTE as a decimal between 0 and 1 (e.g., 0.8 for 80%)."
      },
      proposed_start_date: {
        type: "string",
        description:
          "Date the proposed LTFT change starts, in YYYY-MM-DD format."
      }
    },
    required: [
      "current_cct_date",
      "current_work_percentage",
      "proposed_work_percentage",
      "proposed_start_date"
    ]
  },
  execute: async (input: Record<string, unknown>) => {
    try {
      const programmeName = (input.programme_name as string) || "Programme";
      const currentCctStr = input.current_cct_date as string;
      const wteCurrent = input.current_work_percentage as number;
      const wteProposed = input.proposed_work_percentage as number;
      const startDateStr = input.proposed_start_date as string;

      // --- Validate dates (parse as UTC to avoid local timezone shifts) ---
      const endDate = new Date(`${currentCctStr}T00:00:00Z`);
      const startDate = new Date(`${startDateStr}T00:00:00Z`);

      if (Number.isNaN(endDate.getTime())) {
        return `Error: Invalid current CCT date '${currentCctStr}'. Expected YYYY-MM-DD format.`;
      }
      if (Number.isNaN(startDate.getTime())) {
        return `Error: Invalid proposed start date '${startDateStr}'. Expected YYYY-MM-DD format.`;
      }

      // --- Validate percentages ---
      if (wteCurrent <= 0 || wteCurrent > 1) {
        return `Error: current_work_percentage must be between 0 (exclusive) and 1 (inclusive). Got ${wteCurrent}.`;
      }
      if (wteProposed <= 0 || wteProposed > 1) {
        return `Error: proposed_work_percentage must be between 0 (exclusive) and 1 (inclusive). Got ${wteProposed}.`;
      }

      // --- Business logic validation ---
      const today = new Date();
      today.setUTCHours(0, 0, 0, 0);

      if (startDate < today) {
        return `Error: Proposed start date ${startDateStr} is in the past.`;
      }

      if (startDate > endDate) {
        return `Error: Proposed start date ${startDateStr} is after the current CCT date ${currentCctStr}.`;
      }

      // --- Warnings ---
      const warnings: string[] = [];

      const weeks16InMs = 16 * 7 * 24 * 60 * 60 * 1000;
      if (startDate.getTime() - today.getTime() < weeks16InMs) {
        warnings.push(
          "The proposed start date is within 16 weeks. This is classed as 'short notice' and will only be approved for exceptional circumstances."
        );
      }

      const standardWtes = [0.5, 0.6, 0.7, 0.8, 1.0];
      if (!standardWtes.some(s => Math.abs(s - wteProposed) < 0.01)) {
        warnings.push(
          `Proposed percentage ${(wteProposed * 100).toFixed(0)}% is not a standard LTFT percentage (50%, 60%, 70%, 80%, 100%). Non-standard percentages require Dean approval and are not usually approved.`
        );
      }

      // --- Calculation ---
      const msPerDay = 1000 * 60 * 60 * 24;
      const remainingDays = Math.ceil(
        (endDate.getTime() - startDate.getTime()) / msPerDay
      );
      const adjustedDays = Math.ceil(
        (remainingDays * wteCurrent) / wteProposed
      );
      const extensionDays = adjustedDays - remainingDays;

      const newCctDate = new Date(endDate.getTime() + extensionDays * msPerDay);
      const fmt = (d: Date) => d.toISOString().split("T")[0];

      // --- Structured result for the LLM to present nicely ---
      const result: Record<string, unknown> = {
        programme: programmeName,
        current_cct_date: fmt(endDate),
        proposed_start_date: fmt(startDate),
        current_wte: `${(wteCurrent * 100).toFixed(0)}%`,
        proposed_wte: `${(wteProposed * 100).toFixed(0)}%`,
        remaining_days_in_current_period: remainingDays,
        adjusted_days_at_new_wte: adjustedDays,
        extension_days: extensionDays,
        new_cct_date: fmt(newCctDate),
        warnings: warnings.length > 0 ? warnings : undefined
      };
      return JSON.stringify(result, null, 2);
    } catch (error) {
      const err = error as Error;
      return `Error calculating CCT change: ${err.message || String(error)}`;
    }
  }
};
