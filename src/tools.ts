import Anthropic from "@anthropic-ai/sdk";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import {
  EXTENSION_LANGUAGE_MAP,
  EXTENSIONLESS_FILE_LANGUAGE_MAP,
  BINARY_CHECK_BUFFER_SIZE,
  DEFAULT_TIMEZONE,
  MAX_OUTPUT_BYTES,
  DEFAULT_TIMEOUT_MS,
  BLOCKED_BASH_PATTERNS,
  COLOURS
} from "./constants.js";

const execAsync = promisify(exec);

function expandTilde(filePath: string): string {
  if (filePath.startsWith("~/") || filePath === "~") {
    return path.join(os.homedir(), filePath.slice(1));
  }
  return filePath;
}

function stripAnsiForAgentJson(str: string): string {
  let result = "";
  let i = 0;
  while (i < str.length) {
    if (str.codePointAt(i) === 0x1b && str[i + 1] === "[") {
      // Skip past the escape sequence: ESC[ ... m
      i += 2;
      while (i < str.length && str[i] !== "m") {
        i++;
      }
      i++; // skip the 'm'
    } else {
      result += str[i];
      i++;
    }
  }
  return result;
}

export type ToolDefinition = {
  name: string;
  description: string;
  input_schema: Anthropic.Tool.InputSchema;
  execute: (input: Record<string, unknown>) => Promise<string> | string;
};

// --- get_current_datetime tool ---
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
    const timezone = (input.timezone as string) || DEFAULT_TIMEZONE;

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

// --- read_file helpers ---
function detectLanguage(filePath: string): string | undefined {
  const ext = path.extname(filePath).toLowerCase();
  if (EXTENSION_LANGUAGE_MAP[ext]) return EXTENSION_LANGUAGE_MAP[ext];

  // Handle extensionless files by name
  const base = path.basename(filePath).toLowerCase();
  return EXTENSIONLESS_FILE_LANGUAGE_MAP[base];
}

function isBinaryBuffer(buffer: Buffer): boolean {
  // Check first 8KB for null bytes (clue to binary content)
  const checkLength = Math.min(buffer.length, BINARY_CHECK_BUFFER_SIZE);
  for (let i = 0; i < checkLength; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

function formatLineNumbers(lines: string[], startLine: number): string {
  const maxLineNum = startLine + lines.length - 1;
  const gutterWidth = String(maxLineNum).length;
  return lines
    .map((line, i) => {
      const lineNum = String(startLine + i).padStart(gutterWidth, " ");
      return `${lineNum} | ${line}`;
    })
    .join("\n");
}

// --- Read file tool ---
export const ReadFileTool: ToolDefinition = {
  name: "read_file",
  description: `Reads the contents of a file at the given path. Can read any text file on the system. Binary files are detected and rejected.

The path can be absolute (e.g., '/etc/hosts'), home-relative (e.g., '~/Documents/notes.txt'), or relative to the current working directory (e.g., 'src/main.ts').

If you don't know the exact file path, use the use_bash tool first to discover it (e.g. find, ls, fd). For large files, use the max_lines parameter to limit output and avoid flooding the conversation context.

Features:
- Line numbers: set show_line_numbers to true to prefix every line with its number. Useful for referencing specific locations in conversation or orienting within large files.
- Search: provide a 'search' string to return only lines matching that text (case-insensitive), with surrounding context lines. Much more efficient than reading an entire file to find a specific section.
- Language detection: automatically detects the file's programming language from its extension.

Returns structured JSON with file metadata and content.`,
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
      },
      show_line_numbers: {
        type: "boolean",
        description:
          "Prefix each line with its line number (e.g. '  12 | const x = 1'). Useful for referencing specific locations in conversation or orienting within large files. Defaults to false."
      },
      search: {
        type: "string",
        description:
          "Search for lines containing this text (case-insensitive). When provided, only matching lines and their surrounding context are returned, instead of the full file. Much more efficient for locating specific code."
      },
      context_lines: {
        type: "number",
        description:
          "Number of lines of context to show above and below each search match (like grep -C). Only used with 'search'. Defaults to 3."
      }
    },
    required: ["path"]
  },
  execute: async (input: Record<string, unknown>) => {
    const inputPath = input.path as string;
    const maxLines = (input.max_lines as number) || 1000;
    const offset = Math.max(1, (input.offset as number) || 1);
    const showLineNumbers = (input.show_line_numbers as boolean) || false;
    const searchQuery = input.search as string | undefined;
    const contextLines = (input.context_lines as number) ?? 3;
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

      // Binary detection — read raw buffer first
      const rawBuffer = await fs.readFile(filePath);
      if (isBinaryBuffer(rawBuffer)) {
        return JSON.stringify({
          error: `File '${inputPath}' appears to be binary. Use use_bash (e.g. file, xxd, hexdump) to inspect binary files.`,
          path: filePath,
          size_bytes: stats.size
        });
      }

      const content = rawBuffer.toString("utf-8");
      const allLines = content.split("\n");
      const totalLines = allLines.length;
      const language = detectLanguage(filePath);

      // --- Search mode ---
      if (searchQuery) {
        const lowerQuery = searchQuery.toLowerCase();
        const matchingLineIndices: number[] = [];

        for (let i = 0; i < allLines.length; i++) {
          if (allLines[i].toLowerCase().includes(lowerQuery)) {
            matchingLineIndices.push(i);
          }
        }

        if (matchingLineIndices.length === 0) {
          return JSON.stringify({
            path: filePath,
            total_lines: totalLines,
            ...(language && { language }),
            search: searchQuery,
            matches: 0,
            content: "(no matches found)"
          });
        }

        // Build ranges with context, merging overlapping ranges
        const ranges: Array<{ start: number; end: number }> = [];
        for (const idx of matchingLineIndices) {
          const start = Math.max(0, idx - contextLines);
          const end = Math.min(allLines.length - 1, idx + contextLines);
          if (ranges.length > 0 && start <= ranges[ranges.length - 1].end + 1) {
            // Merge with previous range
            ranges[ranges.length - 1].end = end;
          } else {
            ranges.push({ start, end });
          }
        }

        // Build output with separators between non-contiguous ranges
        const sections: string[] = [];
        let outputLineCount = 0;
        for (const range of ranges) {
          const rangeLines = allLines.slice(range.start, range.end + 1);
          outputLineCount += rangeLines.length;
          if (outputLineCount > maxLines) break;

          if (showLineNumbers) {
            sections.push(formatLineNumbers(rangeLines, range.start + 1));
          } else {
            sections.push(rangeLines.join("\n"));
          }
        }

        const result: Record<string, unknown> = {
          path: filePath,
          total_lines: totalLines,
          size_bytes: stats.size,
          ...(language && { language }),
          search: searchQuery,
          matches: matchingLineIndices.length,
          match_lines: matchingLineIndices.map(i => i + 1),
          content: sections.join("\n---\n")
        };

        return JSON.stringify(result, null, 2);
      }

      // --- Normal read mode ---
      const startIndex = offset - 1;
      const slicedLines = allLines.slice(startIndex, startIndex + maxLines);
      const truncated = startIndex + maxLines < totalLines;

      const outputContent = showLineNumbers
        ? formatLineNumbers(slicedLines, offset)
        : slicedLines.join("\n");

      const result: Record<string, unknown> = {
        path: filePath,
        total_lines: totalLines,
        size_bytes: stats.size,
        ...(language && { language }),
        showing_lines: `${offset}-${Math.min(offset + slicedLines.length - 1, totalLines)}`,
        truncated,
        content: outputContent
      };

      return JSON.stringify(result, null, 2);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        return `Error: File '${inputPath}' not found. Use use_bash (e.g. find or ls) to discover available files.`;
      }
      if (err.code === "EPERM" || err.code === "EACCES") {
        return `Error: Permission denied reading '${inputPath}'.`;
      }
      return `Error: Could not read file '${inputPath}'. ${err.message || String(error)}`;
    }
  }
};

async function createNewFile(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(filePath, content, "utf-8");
}

// --- Edit file helpers ---
function generateDiff(
  oldContent: string,
  newContent: string,
  filePath: string,
  contextLines = 3
): string {
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");

  // Find changed regions by comparing lines
  const changes: Array<{
    oldStart: number;
    oldCount: number;
    newStart: number;
    newCount: number;
    oldChunk: string[];
    newChunk: string[];
  }> = [];

  let i = 0;
  let j = 0;
  while (i < oldLines.length || j < newLines.length) {
    if (
      i < oldLines.length &&
      j < newLines.length &&
      oldLines[i] === newLines[j]
    ) {
      i++;
      j++;
      continue;
    }

    // Found a difference — expand to find the full changed region
    const changeOldStart = i;
    const changeNewStart = j;

    // Find where lines match again
    let found = false;
    for (let lookAhead = 1; lookAhead < 50 && !found; lookAhead++) {
      // Check if old[i + lookAhead] matches new[j]
      for (let oi = 0; oi <= lookAhead; oi++) {
        const ni = lookAhead - oi;
        if (
          i + oi < oldLines.length &&
          j + ni < newLines.length &&
          oldLines[i + oi] === newLines[j + ni]
        ) {
          // Check a few more lines to confirm sync
          let synced = true;
          for (let k = 1; k < 3 && synced; k++) {
            if (
              i + oi + k < oldLines.length &&
              j + ni + k < newLines.length &&
              oldLines[i + oi + k] !== newLines[j + ni + k]
            ) {
              synced = false;
            }
          }
          if (synced) {
            changes.push({
              oldStart: changeOldStart,
              oldCount: oi,
              newStart: changeNewStart,
              newCount: ni,
              oldChunk: oldLines.slice(changeOldStart, i + oi),
              newChunk: newLines.slice(changeNewStart, j + ni)
            });
            i += oi;
            j += ni;
            found = true;
            break;
          }
        }
      }
    }

    if (!found) {
      // Couldn't re-sync — rest of file changed
      changes.push({
        oldStart: changeOldStart,
        oldCount: oldLines.length - changeOldStart,
        newStart: changeNewStart,
        newCount: newLines.length - changeNewStart,
        oldChunk: oldLines.slice(changeOldStart),
        newChunk: newLines.slice(changeNewStart)
      });
      break;
    }
  }

  if (changes.length === 0) return "(no changes)";

  // Format as enhanced unified diff with colours
  const diffLines: string[] = [
    `${COLOURS.bold}${COLOURS.grey}${"─".repeat(80)}${COLOURS.reset}`,
    `${COLOURS.bold}${COLOURS.cyan} ${filePath}${COLOURS.reset}`,
    `${COLOURS.bold}${COLOURS.grey}${"─".repeat(80)}${COLOURS.reset}`,
    ""
  ];

  for (const change of changes) {
    const ctxBefore = Math.min(contextLines, change.oldStart);
    const ctxAfterOld = Math.min(
      contextLines,
      oldLines.length - (change.oldStart + change.oldCount)
    );
    const ctxAfterNew = Math.min(
      contextLines,
      newLines.length - (change.newStart + change.newCount)
    );

    const blockOldStart = change.oldStart - ctxBefore + 1;
    const blockOldLen = ctxBefore + change.oldCount + ctxAfterOld;
    const blockNewStart = change.newStart - ctxBefore + 1;
    const blockNewLen =
      ctxBefore + change.newCount + Math.min(ctxAfterOld, ctxAfterNew);

    diffLines.push(
      `${COLOURS.bold}${COLOURS.cyan}@@ Lines before & after: ${blockOldStart}-${blockOldStart + blockOldLen - 1} → ${blockNewStart}-${blockNewStart + blockNewLen - 1} @@${COLOURS.reset}`
    );

    // Context before (dimmed)
    for (let k = change.oldStart - ctxBefore; k < change.oldStart; k++) {
      const lineNum = String(k + 1).padStart(4, " ");
      diffLines.push(
        `${COLOURS.grey}${lineNum} │${COLOURS.reset}${COLOURS.dim}   ${oldLines[k]}${COLOURS.reset}`
      );
    }

    // Removed lines (red with background for emphasis)
    for (let idx = 0; idx < change.oldChunk.length; idx++) {
      const lineNum = String(change.oldStart + idx + 1).padStart(4, " ");
      diffLines.push(
        `${COLOURS.grey}${lineNum} │${COLOURS.reset}${COLOURS.red}${COLOURS.bold} - ${change.oldChunk[idx]}${COLOURS.reset}`
      );
    }

    // Added lines (green with background for emphasis)
    for (let idx = 0; idx < change.newChunk.length; idx++) {
      const lineNum = String(change.newStart + idx + 1).padStart(4, " ");
      diffLines.push(
        `${COLOURS.grey}${lineNum} │${COLOURS.reset}${COLOURS.green}${COLOURS.bold} + ${change.newChunk[idx]}${COLOURS.reset}`
      );
    }

    // Context after (dimmed)
    for (let k = 0; k < ctxAfterOld; k++) {
      const idx = change.oldStart + change.oldCount + k;
      if (idx < oldLines.length) {
        const lineNum = String(idx + 1).padStart(4, " ");
        diffLines.push(
          `${COLOURS.grey}${lineNum} │${COLOURS.reset}${COLOURS.dim}   ${oldLines[idx]}${COLOURS.reset}`
        );
      }
    }

    diffLines.push(""); // Blank line between blocks
  }

  diffLines.push(
    `${COLOURS.bold}${COLOURS.grey}${"─".repeat(80)}${COLOURS.reset}`
  );

  return diffLines.join("\n");
}

function getChangeSnippet(
  content: string,
  changedStr: string,
  contextLines = 3
): { start_line: number; end_line: number; snippet: string } {
  const lines = content.split("\n");
  const changeStart = content.indexOf(changedStr);
  if (changeStart === -1) {
    return { start_line: 1, end_line: 1, snippet: "" };
  }

  const linesBefore = content.slice(0, changeStart).split("\n");
  const startLine = linesBefore.length;
  const changeLines = changedStr.split("\n").length;
  const endLine = startLine + changeLines - 1;

  const snippetStart = Math.max(0, startLine - 1 - contextLines);
  const snippetEnd = Math.min(lines.length, endLine + contextLines);
  const snippetLines = lines.slice(snippetStart, snippetEnd);

  return {
    start_line: snippetStart + 1,
    end_line: snippetEnd,
    snippet: formatLineNumbers(snippetLines, snippetStart + 1)
  };
}

// --- edit_file tool
export const EditFileTool: ToolDefinition = {
  name: "edit_file",
  description: `Make edits to a text file. Supports several operations:

**IMPORTANT: This tool ALWAYS shows a preview first and requires confirmation before writing.**
- First call: omit 'confirm' parameter (or set to false) to see a preview diff
- Second call: include 'confirm: true' to actually write the changes

**replace** (default): Replace an exact string match with new text.
  - Provide 'old_str' and 'new_str'. old_str must match exactly once in the file.
  - Use read_file (with show_line_numbers) first to see the current contents and copy exact text.

**insert_before** / **insert_after**: Insert new_str before or after old_str without removing old_str.
  - Set 'mode' to 'insert_before' or 'insert_after'. Provide 'old_str' (the anchor) and 'new_str' (the content to insert).
  - Great for adding imports, methods, or config entries next to existing code.

**append**: Add content to the end of a file.
  - Set 'mode' to 'append'. Provide only 'new_str'. No old_str needed.

**create**: Create a new file.
  - Provide 'path' and 'new_str' only (omit 'old_str'). Parent directories are created automatically.

The path can be absolute, home-relative (~), or relative to the current working directory.`,
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
          "The exact string to find in the file. Used as the target for 'replace' mode, or as the anchor for 'insert_before'/'insert_after' mode. Omit when creating a new file or using 'append' mode."
      },
      new_str: {
        type: "string",
        description:
          "The replacement/insertion content. For new files, this becomes the entire file content."
      },
      mode: {
        type: "string",
        enum: ["replace", "insert_before", "insert_after", "append"],
        description:
          "The edit operation. 'replace' (default): replace old_str with new_str. 'insert_before': insert new_str before old_str. 'insert_after': insert new_str after old_str. 'append': add new_str to end of file."
      },
      confirm: {
        type: "boolean",
        description:
          "Set to true to confirm and actually write the changes. If false or omitted, only returns a preview diff without writing. ALWAYS preview first before confirming."
      }
    },
    required: ["path", "new_str"]
  },
  execute: async (input: Record<string, unknown>) => {
    const oldStr = input.old_str as string | undefined;
    const newStr = input.new_str as string;
    const inputPath = input.path as string;
    const mode = (input.mode as string) || "replace";
    const confirm = (input.confirm as boolean) || false;
    const workspaceRoot = process.cwd();

    const expandedPath = expandTilde(inputPath);
    const filePath = path.isAbsolute(expandedPath)
      ? expandedPath
      : path.resolve(workspaceRoot, expandedPath);

    // --- Validate mode ---
    const validModes = ["replace", "insert_before", "insert_after", "append"];
    if (!validModes.includes(mode)) {
      return JSON.stringify({
        error: `Invalid mode '${mode}'. Must be one of: ${validModes.join(", ")}`
      });
    }

    if (mode === "replace" && oldStr !== undefined && oldStr === newStr) {
      return JSON.stringify({
        error: "'old_str' and 'new_str' must be different in replace mode."
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

      // --- Create new file ---
      if (!fileExists) {
        if (oldStr || mode === "append") {
          return JSON.stringify({
            error: `File '${inputPath}' not found. Cannot edit a file that doesn't exist. Use use_bash (e.g. find or ls) to check available files.`
          });
        }

        // Preview for file creation
        if (!confirm) {
          return JSON.stringify({
            preview: true,
            action: "create",
            path: filePath,
            lines: newStr.split("\n").length,
            content_preview:
              newStr.length > 500
                ? newStr.slice(0, 500) + "\n... [truncated]"
                : newStr,
            message: "Set 'confirm: true' to create this file."
          });
        }

        await createNewFile(filePath, newStr);
        return JSON.stringify({
          success: true,
          action: "created",
          path: filePath,
          lines: newStr.split("\n").length
        });
      }

      const content = await fs.readFile(filePath, "utf-8");

      // --- Append mode ---
      if (mode === "append") {
        const separator = content.endsWith("\n") ? "" : "\n";
        const newContent = content + separator + newStr;

        if (!confirm) {
          const diff = generateDiff(content, newContent, inputPath);
          console.log(`\n${diff}\n`);
          return JSON.stringify({
            preview: true,
            action: "append",
            path: filePath,
            diff: stripAnsiForAgentJson(diff),
            message: "Set 'confirm: true' to write these changes."
          });
        }

        await fs.writeFile(filePath, newContent, "utf-8");
        const addedLines = newStr.split("\n").length;
        return JSON.stringify({
          success: true,
          action: "appended",
          path: filePath,
          lines_added: addedLines,
          new_total_lines: newContent.split("\n").length
        });
      }

      // --- Modes that require old_str ---
      if (!oldStr) {
        return JSON.stringify({
          error:
            "'old_str' is required for replace, insert_before, and insert_after modes. To see the current contents, use read_file first."
        });
      }

      const occurrences = content.split(oldStr).length - 1;
      if (occurrences === 0) {
        return JSON.stringify({
          error: `String not found in '${inputPath}'. Use read_file (with show_line_numbers and/or search) to check the current file contents and copy the exact text.`
        });
      }
      if (occurrences > 1) {
        return JSON.stringify({
          error: `Found ${occurrences} occurrences of old_str in '${inputPath}'. Include more surrounding context in old_str to match exactly one location.`
        });
      }

      // --- Build new content based on mode ---
      let newContent: string;
      let actionLabel: string;

      switch (mode) {
        case "insert_before":
          newContent = content.replace(oldStr, newStr + "\n" + oldStr);
          actionLabel = "inserted_before";
          break;
        case "insert_after":
          newContent = content.replace(oldStr, oldStr + "\n" + newStr);
          actionLabel = "inserted_after";
          break;
        default: // replace
          newContent = content.replace(oldStr, newStr);
          actionLabel = "replaced";
          break;
      }

      // --- Preview mode: return diff without writing ---
      if (!confirm) {
        const diff = generateDiff(content, newContent, inputPath);
        console.log(`\n${diff}\n`);
        const changedText =
          mode === "replace"
            ? newStr
            : mode === "insert_before"
              ? newStr + "\n" + oldStr
              : oldStr + "\n" + newStr;
        const snippet = getChangeSnippet(newContent, changedText);

        return JSON.stringify({
          preview: true,
          action: actionLabel,
          path: filePath,
          diff: stripAnsiForAgentJson(diff),
          change_location: {
            start_line: snippet.start_line,
            end_line: snippet.end_line
          },
          message: "Set 'confirm: true' to write these changes."
        });
      }

      // --- Write and return result with context ---
      await fs.writeFile(filePath, newContent, "utf-8");

      const changedText =
        mode === "replace"
          ? newStr
          : mode === "insert_before"
            ? newStr + "\n" + oldStr
            : oldStr + "\n" + newStr;
      const snippet = getChangeSnippet(newContent, changedText);

      const result: Record<string, unknown> = {
        success: true,
        action: actionLabel,
        path: filePath,
        change_location: {
          start_line: snippet.start_line,
          end_line: snippet.end_line
        },
        snippet: snippet.snippet
      };

      return JSON.stringify(result, null, 2);
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

// --- LTFT calculator tool ---
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

// --- Use Bash tool ---
export const UseBashTool: ToolDefinition = {
  name: "use_bash",
  description: `Executes a bash command and returns its output (stdout and stderr).

This is a general-purpose tool for running shell commands — use it for anything that's easier or more powerful via the command line than Node.js built-ins. Great for:

- File searches:  find, fd, locate
- Content search: grep, ripgrep (rg), awk, sed
- File info:      stat, file, du, wc
- System info:    uname, df, whoami, which
- Text processing: sort, uniq, head, tail, cut, tr, jq
- Git operations:  git log, git diff, git status
- Chained pipelines: find . -name '*.ts' | xargs grep 'TODO'

The command runs from the current working directory (the project root) with a 30-second timeout by default. You can set a custom timeout and working directory if needed.

Destructive commands (rm -rf, mkfs, dd to devices, etc.) are blocked for safety.

Prefer this over list_files when you need glob patterns, piped output, regex search, or anything the shell does better.`,
  input_schema: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description:
          "The bash command to execute. Can include pipes, redirects, subshells, etc."
      },
      working_directory: {
        type: "string",
        description:
          "Working directory for the command. Defaults to the project root (cwd). Supports absolute paths and ~ expansion."
      },
      timeout_ms: {
        type: "number",
        description:
          "Timeout in milliseconds. The command is killed if it exceeds this. Defaults to 30000 (30 seconds)."
      }
    },
    required: ["command"]
  },
  execute: async (input: Record<string, unknown>) => {
    const command = input.command as string;
    const timeoutMs = (input.timeout_ms as number) || DEFAULT_TIMEOUT_MS;
    const cwdInput = input.working_directory as string | undefined;
    const workspaceRoot = process.cwd();

    // A bit of safety-checking
    for (const pattern of BLOCKED_BASH_PATTERNS) {
      if (pattern.test(command)) {
        return JSON.stringify({
          error: `Command blocked for safety. Matched disallowed pattern: ${pattern.source}`
        });
      }
    }

    // Resolve working directory
    let cwd = workspaceRoot;
    if (cwdInput) {
      const expanded = expandTilde(cwdInput);
      cwd = path.isAbsolute(expanded)
        ? expanded
        : path.resolve(workspaceRoot, expanded);
    }

    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd,
        timeout: timeoutMs,
        maxBuffer: MAX_OUTPUT_BYTES,
        shell: "/bin/bash",
        env: { ...process.env, LANG: "en_US.UTF-8" }
      });

      const result: Record<string, unknown> = {
        exit_code: 0,
        working_directory: cwd
      };

      if (stdout) {
        result.stdout =
          stdout.length > MAX_OUTPUT_BYTES
            ? stdout.slice(0, MAX_OUTPUT_BYTES) + "\n... [output truncated]"
            : stdout;
      }
      if (stderr) {
        result.stderr = stderr;
      }

      return JSON.stringify(result, null, 2);
    } catch (error: unknown) {
      const err = error as {
        code?: string | number;
        killed?: boolean;
        signal?: string;
        stdout?: string;
        stderr?: string;
        message?: string;
      };

      // Command ran but returned non-zero exit code
      if (err.stdout !== undefined || err.stderr !== undefined) {
        const result: Record<string, unknown> = {
          exit_code: typeof err.code === "number" ? err.code : 1,
          working_directory: cwd
        };
        if (err.killed || err.signal === "SIGTERM") {
          result.error = `Command timed out after ${timeoutMs}ms and was killed.`;
        }
        if (err.stdout) result.stdout = err.stdout;
        if (err.stderr) result.stderr = err.stderr;

        return JSON.stringify(result, null, 2);
      }

      return JSON.stringify({
        error: `Failed to execute command: ${err.message || String(error)}`
      });
    }
  }
};
