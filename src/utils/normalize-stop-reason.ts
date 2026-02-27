import type { ModelResponse } from "../provider.js";

export function normalizeStopReason(
  stopReason: unknown
): ModelResponse["stop_reason"] {
  switch (stopReason) {
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    case "end_turn":
    case "stop_sequence":
    case "guardrail_intervened":
    case "content_filtered":
    case null:
    case undefined:
    default:
      return "end_turn";
  }
}
