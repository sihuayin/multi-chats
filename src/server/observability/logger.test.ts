import { describe, expect, it } from "vitest";
import { createLogger } from "@/server/observability/logger";

describe("Structured logger", () => {
  it("writes correlated identifiers as structured JSON", () => {
    const lines: string[] = [];
    const logger = createLogger((line) => lines.push(line));

    logger.info("tool.completed", {
      requestId: "request-1",
      runId: "run-1",
      toolCallId: "tool-call-1",
      approvalId: "approval-1"
    });

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({
      level: "info",
      event: "tool.completed",
      requestId: "request-1",
      runId: "run-1",
      toolCallId: "tool-call-1",
      approvalId: "approval-1"
    });
  });
});
