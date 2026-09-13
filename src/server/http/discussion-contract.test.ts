import { afterEach, describe, expect, it } from "vitest";
import { ConversationRunService } from "@/server/application/conversation-run-service";
import { DiscussionOrchestrator } from "@/server/application/discussion-orchestrator";
import {
  getServices,
  setServicesForTests
} from "@/server/application/services";
import { handleApiRequest } from "@/server/http/router";
import { AesCredentialCipher } from "@/server/security/credential-cipher";
import { setStoreForTests } from "@/server/store";
import { MemoryStore } from "@/server/store/memory-store";
import {
  createFixtureState,
  discussionModelGateway,
  TEST_KEY
} from "@/server/test-support/fixtures";

const originalDatabaseUrl = process.env.DATABASE_URL;

afterEach(() => {
  setServicesForTests(undefined);
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
});

describe("Discussion HTTP contract", () => {
  it("creates and starts a Discussion with idempotent commands", async () => {
    const store = new MemoryStore(createFixtureState());
    setStoreForTests(store);
    process.env.DATABASE_URL = "postgres://discussion-contract";
    const runs = new ConversationRunService(
      store,
      new AesCredentialCipher(TEST_KEY),
      discussionModelGateway()
    );
    setServicesForTests({
      workspace: getServices().workspace,
      runs,
      discussions: new DiscussionOrchestrator(store, runs)
    });
    const requestBody = {
      title: "Choose a persistence model",
      mode: "solution",
      language: "en",
      participants: [
        {
          employeeId: "20000000-0000-4000-8000-000000000001",
          role: "analyst",
          objective: "Define the boundary."
        },
        {
          employeeId: "20000000-0000-4000-8000-000000000002",
          role: "facilitator",
          objective: "Synthesize the recommendation."
        }
      ],
      facilitatorId: "20000000-0000-4000-8000-000000000002",
      maxRounds: 3
    };

    const created = await handleApiRequest(
      new Request(
        "http://localhost/api/conversations/30000000-0000-4000-8000-000000000001/discussions",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": "create-one"
          },
          body: JSON.stringify(requestBody)
        }
      ),
      [
        "conversations",
        "30000000-0000-4000-8000-000000000001",
        "discussions"
      ]
    );
    expect(created.status).toBe(201);
    const createdView = await created.json();
    expect(createdView).toMatchObject({
      discussion: {
        title: "Choose a persistence model",
        status: "draft"
      },
      availableActions: ["edit", "start", "cancel"],
      budget: { usedRounds: 0, maxRounds: 3 }
    });

    const replay = await handleApiRequest(
      new Request(
        "http://localhost/api/conversations/30000000-0000-4000-8000-000000000001/discussions",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": "create-one"
          },
          body: JSON.stringify(requestBody)
        }
      ),
      [
        "conversations",
        "30000000-0000-4000-8000-000000000001",
        "discussions"
      ]
    );
    expect(await replay.json()).toEqual(createdView);
    expect(await store.read((state) => state.discussions)).toHaveLength(1);

    const discussionId = createdView.discussion.id;
    const invalidSkip = await handleApiRequest(
      new Request(
        `http://localhost/api/discussions/${discussionId}/skip`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}"
        }
      ),
      ["discussions", discussionId, "skip"]
    );
    expect(invalidSkip.status).toBe(400);
    expect(await invalidSkip.json()).toMatchObject({
      code: "validation_error"
    });

    const startRequest = () =>
      handleApiRequest(
        new Request(
          `http://localhost/api/discussions/${discussionId}/start`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "idempotency-key": "start-one"
            },
            body: "{}"
          }
        ),
        ["discussions", discussionId, "start"]
      );
    const [started, replayStarted] = await Promise.all([
      startRequest(),
      startRequest()
    ]);
    expect([started.status, replayStarted.status]).toEqual([202, 202]);
    const startedView = await started.json();
    expect(await replayStarted.json()).toEqual(startedView);
    expect(
      await store.read((state) =>
        state.runs.filter((run) => run.discussionId === discussionId)
      )
    ).toHaveLength(1);
    expect(startedView).toMatchObject({
      discussion: { status: "running" },
      rounds: [{ phase: "positions", status: "running" }],
      activeRun: { status: "queued" }
    });

    const roundId = startedView.rounds[0].id;
    const detail = await handleApiRequest(
      new Request(
        `http://localhost/api/discussions/${discussionId}/rounds/${roundId}`
      ),
      ["discussions", discussionId, "rounds", roundId]
    );
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({
      id: roundId,
      phase: "positions",
      run: { id: startedView.activeRun.id }
    });

    const stopped = await handleApiRequest(
      new Request(`http://localhost/api/discussions/${discussionId}/stop`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "pause" })
      }),
      ["discussions", discussionId, "stop"]
    );
    expect(stopped.status).toBe(200);
    expect(await stopped.json()).toMatchObject({
      discussion: { status: "interrupted" }
    });
  });

  it("streams Discussion events separately from Run events", async () => {
    const store = new MemoryStore(createFixtureState());
    setStoreForTests(store);
    process.env.DATABASE_URL = "postgres://discussion-contract";
    const runs = new ConversationRunService(
      store,
      new AesCredentialCipher(TEST_KEY),
      discussionModelGateway()
    );
    const discussions = new DiscussionOrchestrator(store, runs);
    setServicesForTests({
      workspace: getServices().workspace,
      runs,
      discussions
    });
    const view = await discussions.createDiscussion(
      "30000000-0000-4000-8000-000000000001",
      {
        title: "Analyze the risk",
        mode: "problem",
        participants: [
          {
            employeeId: "20000000-0000-4000-8000-000000000001",
            role: "analyst"
          },
          {
            employeeId: "20000000-0000-4000-8000-000000000002",
            role: "facilitator"
          }
        ],
        facilitatorId: "20000000-0000-4000-8000-000000000002"
      }
    );
    await discussions.startDiscussion(view.discussion.id);

    const response = await handleApiRequest(
      new Request(
        `http://localhost/api/discussions/${view.discussion.id}/events?afterSequence=0`
      ),
      ["discussions", view.discussion.id, "events"]
    );
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const { value } = await reader.read();
    const frame = new TextDecoder().decode(value);
    expect(frame).toContain('"type":"discussion_started"');
    expect(frame).toContain('"discussionId":"');
    await reader.cancel();
  });
});
