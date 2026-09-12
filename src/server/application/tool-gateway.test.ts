import { describe, expect, it } from "vitest";
import { RegisteredToolGateway } from "@/server/application/tool-gateway";
import { BUILT_IN_TOOLS } from "@/server/store/initial-state";
import { MemoryStore } from "@/server/store/memory-store";
import { createFixtureState } from "@/server/test-support/fixtures";

function gateway() {
  return new RegisteredToolGateway(new MemoryStore(createFixtureState()));
}

function tool(name: string) {
  const definition = BUILT_IN_TOOLS.find((item) => item.name === name);
  if (!definition) throw new Error(`Missing test Tool: ${name}`);
  return definition;
}

const context = {
  runId: "run-1",
  messageId: "message-1",
  employeeId: "20000000-0000-4000-8000-000000000001",
  allowedToolNames: ["current_time", "fetch_url"]
};

describe("Registered Tool Gateway", () => {
  it("executes a read-only Tool after schema validation", async () => {
    const result = await gateway().execute({
      tool: tool("current_time"),
      args: {},
      context
    });

    expect(result.isError).not.toBe(true);
    expect(Number.isNaN(Date.parse(result.content))).toBe(false);
  });

  it("rejects unauthorized Tools and invalid arguments", async () => {
    const unauthorized = await gateway().execute({
      tool: tool("current_time"),
      args: {},
      context: { ...context, allowedToolNames: [] }
    });
    expect(unauthorized).toMatchObject({
      isError: true,
      errorKind: "unauthorized"
    });

    const invalid = await gateway().execute({
      tool: tool("fetch_url"),
      args: {},
      context
    });
    expect(invalid).toMatchObject({
      isError: true,
      errorKind: "validation"
    });

    const malformedUrl = await gateway().execute({
      tool: tool("fetch_url"),
      args: { url: "not a URL" },
      context
    });
    expect(malformedUrl).toMatchObject({
      isError: true,
      errorKind: "validation"
    });
  });

  it("rejects Tool names outside the registry", async () => {
    const result = await gateway().execute({
      tool: {
        ...tool("current_time"),
        name: "unregistered_tool"
      },
      args: {},
      context: {
        ...context,
        allowedToolNames: ["unregistered_tool"]
      }
    });

    expect(result).toMatchObject({
      isError: true,
      errorKind: "unauthorized"
    });
  });
});
