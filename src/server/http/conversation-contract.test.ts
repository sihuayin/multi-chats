import { afterEach, describe, expect, it } from "vitest";
import { getServices, setServicesForTests } from "@/server/application/services";
import { handleApiRequest } from "@/server/http/router";
import { MemoryStore } from "@/server/store/memory-store";
import { setStoreForTests } from "@/server/store";
import {
  createFixtureState,
  TEST_KEY
} from "@/server/test-support/fixtures";
import { AesCredentialCipher } from "@/server/security/credential-cipher";
import { ConversationRunService } from "@/server/application/conversation-run-service";
import { FakeModelGateway } from "@/server/adapters/model/model-gateway";

const originalModelMode = process.env.MODEL_MODE;
const originalDatabaseUrl = process.env.DATABASE_URL;

afterEach(() => {
  setServicesForTests(undefined);
  if (originalModelMode === undefined) delete process.env.MODEL_MODE;
  else process.env.MODEL_MODE = originalModelMode;
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
});

describe("Conversation HTTP and SSE contract", () => {
  it("translates a mentioned Message into an ordered persisted Run event stream", async () => {
    process.env.MODEL_MODE = "fake";
    process.env.DATABASE_URL = "postgres://contract-test";
    const store = new MemoryStore(createFixtureState());
    setStoreForTests(store);
    setServicesForTests({
      workspace: getServices().workspace,
      runs: new ConversationRunService(
        store,
        new AesCredentialCipher(TEST_KEY),
        new FakeModelGateway()
      )
    });

    const startedResponse = await handleApiRequest(
      new Request("http://localhost/api/conversations/conversation/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          content: "@alice prepare the launch brief"
        })
      }),
      [
        "conversations",
        "30000000-0000-4000-8000-000000000001",
        "messages"
      ]
    );
    expect(startedResponse.status).toBe(202);
    const started = (await startedResponse.json()) as {
      run: { id: string };
    };
    expect(started.run.id).toBeTruthy();

    const { runs } = getServices();
    const streamResponse = await handleApiRequest(
      new Request(
        `http://localhost/api/runs/${started.run.id}/events?after=0`
      ),
      ["runs", started.run.id, "events"]
    );
    expect(streamResponse.status).toBe(200);
    const reader = streamResponse.body!.getReader();
    const decoder = new TextDecoder();
    const processing = runs.processRun(started.run.id);
    let streamText = "";
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      streamText += decoder.decode(chunk.value, { stream: true });
      if (streamText.includes("run_completed")) break;
    }
    const completed = await processing;
    expect(completed.status).toBe("completed");
    const events = streamText
      .split("\n\n")
      .map((frame) =>
        frame
          .split("\n")
          .find((line) => line.startsWith("data: "))
          ?.slice("data: ".length)
      )
      .filter((data): data is string => Boolean(data))
      .map((data) => JSON.parse(data) as { sequence: number; type: string });

    expect(events.map((event) => event.sequence)).toEqual(
      [...events].map((event) => event.sequence).sort((left, right) => left - right)
    );
    const eventTypes = events.map((event) => event.type);
    expect(eventTypes[0]).toBe("run_started");
    expect(eventTypes[1]).toBe("employee_turn_started");
    expect(eventTypes.slice(2, -2).every((type) => type === "message_delta")).toBe(
      true
    );
    expect(eventTypes.at(-2)).toBe("message_completed");
    expect(eventTypes.at(-1)).toBe("run_completed");

    const messages = await runs.listMessages(
      "30000000-0000-4000-8000-000000000001"
    );
    expect(messages.at(-1)).toMatchObject({
      authorType: "employee",
      status: "complete"
    });
  });
});
