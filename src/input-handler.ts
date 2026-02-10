import * as readline from "node:readline";

export function createGetUserMessage(): () => Promise<string | null> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false
  });

  const lines: string[] = [];
  let resolvePromise: ((value: string | null) => void) | null = null;

  rl.on("line", line => {
    if (resolvePromise) {
      resolvePromise(line);
      resolvePromise = null;
    } else {
      lines.push(line);
    }
  });

  rl.on("close", () => {
    if (resolvePromise) {
      resolvePromise(null);
    }
  });

  return (): Promise<string | null> => {
    if (lines.length > 0) {
      return Promise.resolve(lines.shift()!);
    }

    return new Promise(resolve => {
      resolvePromise = resolve;
    });
  };
}
