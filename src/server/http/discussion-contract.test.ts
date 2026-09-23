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
  createFixtureDiscussion,
  createFixtureTurnPayload,
  createFixtureState,
  discussionModelGateway,
  TEST_KEY
} from "@/server/test-support/fixtures";
import type { ModelGateway } from "@/server/application/model-gateway";

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
      sources: getServices().sources,
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
      sources: getServices().sources,
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

  it("enforces budget defaults, inheritance, patches, and view exposure over HTTP", async () => {
    const state = createFixtureState();
    state.conversations.push({
      id: "30000000-0000-4000-8000-000000000002",
      workspaceId: state.workspace.id,
      title: "Review conversation",
      memberIds: state.conversations[0].memberIds,
      retrievalExcluded: false,
      createdAt: state.workspace.createdAt,
      updatedAt: state.workspace.updatedAt
    });
    state.discussions.push(
      createFixtureDiscussion({
        id: "71000000-0000-4000-8000-000000000001",
        workspaceId: state.workspace.id,
        conversationId: "30000000-0000-4000-8000-000000000002"
      })
    );
    const store = new MemoryStore(state);
    setStoreForTests(store);
    process.env.DATABASE_URL = "postgres://discussion-contract";
    const runs = new ConversationRunService(
      store,
      new AesCredentialCipher(TEST_KEY),
      discussionModelGateway()
    );
    setServicesForTests({
      workspace: getServices().workspace,
      sources: getServices().sources,
      runs,
      discussions: new DiscussionOrchestrator(store, runs)
    });

    const defaults = await handleApiRequest(
      new Request("http://localhost/api/workspace", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          discussionBudgetDefaults: {
            maxTotalTokens: 5_000,
            maxTotalCostMicros: 2_000,
            currency: "USD"
          }
        })
      }),
      ["workspace"]
    );
    expect(defaults.status).toBe(200);
    const defaultsView = await defaults.json();
    expect(defaultsView.workspace.discussionBudgetDefaults).toEqual({
      maxTotalTokens: 5_000,
      maxTotalCostMicros: 2_000,
      currency: "USD"
    });

    const created = await handleApiRequest(
      new Request(
        "http://localhost/api/conversations/30000000-0000-4000-8000-000000000001/discussions",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": "budget-create"
          },
          body: JSON.stringify({
            title: "Budgeted discussion",
            mode: "problem",
            language: "en",
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
            facilitatorId: "20000000-0000-4000-8000-000000000002",
            maxRounds: 3
          })
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
    expect(createdView.discussion.budget).toEqual({
      maxTotalTokens: 5_000,
      maxTotalCostMicros: 2_000,
      currency: "USD"
    });
    // Inheritance stamps the merged budget onto the Discussion so later
    // Workspace default changes never rewrite history.
    expect(createdView.budget.source).toBe("discussion");
    expect(createdView.budget.tokens).toMatchObject({
      used: 0,
      hard: 5_000,
      remaining: 5_000,
      state: "ok"
    });
    expect(createdView.budget.cost).toMatchObject({
      usedMicros: 0,
      hardMicros: 2_000,
      remainingMicros: 2_000,
      state: "ok"
    });

    const patched = await handleApiRequest(
      new Request(
        `http://localhost/api/discussions/${createdView.discussion.id}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ budget: { maxTotalTokens: 400 } })
        }
      ),
      ["discussions", createdView.discussion.id]
    );
    expect(patched.status).toBe(200);
    const patchedView = await patched.json();
    expect(patchedView.discussion.budget).toEqual({
      maxTotalTokens: 400,
      maxTotalCostMicros: 2_000,
      currency: "USD"
    });
    expect(patchedView.budget.source).toBe("discussion");
    expect(patchedView.budget.tokens).toMatchObject({
      hard: 400,
      remaining: 400
    });

    const invalid = await handleApiRequest(
      new Request(
        `http://localhost/api/discussions/${createdView.discussion.id}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            budget: { softTotalTokens: 900, maxTotalTokens: 100 }
          })
        }
      ),
      ["discussions", createdView.discussion.id]
    );
    expect(invalid.status).toBe(400);

    const extended = await handleApiRequest(
      new Request(
        "http://localhost/api/discussions/71000000-0000-4000-8000-000000000001/extend",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": "budget-extend"
          },
          body: JSON.stringify({
            budget: { maxTotalTokens: 90_000 }
          })
        }
      ),
      [
        "discussions",
        "71000000-0000-4000-8000-000000000001",
        "extend"
      ]
    );
    expect(extended.status).toBe(202);
    const extendedView = await extended.json();
    expect(extendedView.discussion.budget).toMatchObject({
      maxTotalTokens: 90_000
    });
    expect(extendedView.discussion.status).toBe("running");
  });

  it("queues interventions idempotently and rejects terminal Discussions", async () => {
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
      sources: getServices().sources,
      runs,
      discussions
    });
    const view = await discussions.createDiscussion(
      "30000000-0000-4000-8000-000000000001",
      {
        title: "Queue steering",
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

    const createIntervention = (key = "intervention-one") =>
      handleApiRequest(
        new Request(
          `http://localhost/api/discussions/${view.discussion.id}/interventions`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "idempotency-key": key
            },
            body: JSON.stringify({
              kind: "material",
              content: "Use the latest incident report."
            })
          }
        ),
        ["discussions", view.discussion.id, "interventions"]
      );

    const [created, replay] = await Promise.all([
      createIntervention(),
      createIntervention()
    ]);
    expect(created.status).toBe(200);
    const createdView = await created.json();
    expect(await replay.json()).toEqual(createdView);
    expect(createdView.interventions).toEqual([
      expect.objectContaining({
        kind: "material",
        content: "Use the latest incident report.",
        status: "pending",
        idempotencyKey: "intervention-one"
      })
    ]);
    expect(
      await store.read((state) =>
        state.discussionInterventions.filter(
          (intervention) =>
            intervention.discussionId === view.discussion.id
        )
      )
    ).toEqual([
      expect.objectContaining({
        idempotencyKey: "intervention-one"
      })
    ]);

    await discussions.cancelDiscussion(view.discussion.id);
    const terminal = await createIntervention("terminal-one");
    expect(terminal.status).toBe(409);
    expect(await terminal.json()).toMatchObject({
      code: "discussion_invalid_state"
    });

    const updateMode = await handleApiRequest(
      new Request(
        `http://localhost/api/discussions/${view.discussion.id}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ mode: "review" })
        }
      ),
      ["discussions", view.discussion.id]
    );
    expect(updateMode.status).toBe(409);
    expect(await updateMode.json()).toMatchObject({
      code: "discussion_invalid_state"
    });

    for (const body of [
      { maxRounds: 4 },
      {
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
    ]) {
      const update = await handleApiRequest(
        new Request(
          `http://localhost/api/discussions/${view.discussion.id}`,
          {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body)
          }
        ),
        ["discussions", view.discussion.id]
      );
      expect(update.status).toBe(409);
      expect(await update.json()).toMatchObject({
        code: "discussion_invalid_state"
      });
    }

    const extend = await handleApiRequest(
      new Request(
        `http://localhost/api/discussions/${view.discussion.id}/extend`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": "extend-terminal"
          },
          body: "{}"
        }
      ),
      ["discussions", view.discussion.id, "extend"]
    );
    expect(extend.status).toBe(409);
    expect(await extend.json()).toMatchObject({
      code: "discussion_invalid_state"
    });
  });

  it("exposes evidence validation failures and repairs through the Discussion API", async () => {
    const store = new MemoryStore(createFixtureState());
    setStoreForTests(store);
    process.env.DATABASE_URL = "postgres://discussion-contract";
    const gateway: ModelGateway = {
      async *run() {
        const payload = createFixtureTurnPayload("positions");
        payload.claims = [
          {
            statement: "Unsupported fact",
            kind: "fact",
            confidence: "high"
          }
        ];
        yield { type: "text_completed", text: JSON.stringify(payload) };
      }
    };
    const runs = new ConversationRunService(
      store,
      new AesCredentialCipher(TEST_KEY),
      gateway
    );
    const discussions = new DiscussionOrchestrator(store, runs);
    setServicesForTests({
      workspace: getServices().workspace,
      sources: getServices().sources,
      runs,
      discussions
    });
    const view = await discussions.createDiscussion(
      "30000000-0000-4000-8000-000000000001",
      {
        title: "Reject unsupported facts",
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
    const runId = await store.read(
      (state) =>
        state.runs.find(
          (run) => run.discussionId === view.discussion.id
        )!.id
    );
    await runs.processRun(runId);

    const response = await handleApiRequest(
      new Request(
        `http://localhost/api/discussions/${view.discussion.id}`
      ),
      ["discussions", view.discussion.id]
    );
    expect(response.status).toBe(200);
    const failedView = await response.json();
    expect(failedView).toMatchObject({
      evidence: {
        validationFailureCount: 4
      }
    });
    const roundResponse = await handleApiRequest(
      new Request(
        `http://localhost/api/discussions/${view.discussion.id}/rounds/${failedView.rounds[0].id}`
      ),
      [
        "discussions",
        view.discussion.id,
        "rounds",
        failedView.rounds[0].id
      ]
    );
    expect(await roundResponse.json()).toMatchObject({
      run: { status: "completed" }
    });

    const events = await handleApiRequest(
      new Request(
        `http://localhost/api/discussions/${view.discussion.id}/events?afterSequence=0`
      ),
      ["discussions", view.discussion.id, "events"]
    );
    const reader = events.body!.getReader();
    let frame = "";
    for (let index = 0; index < 10; index += 1) {
      const { value, done } = await reader.read();
      if (done || !value) break;
      frame += new TextDecoder().decode(value);
      if (frame.includes('"type":"evidence_validation_failed"')) break;
    }
    expect(frame).toContain('"type":"evidence_validation_failed"');
    await reader.cancel();
  });
});
