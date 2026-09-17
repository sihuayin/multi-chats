import { describe, expect, it } from "vitest";
import { ConversationRunService } from "@/server/application/conversation-run-service";
import { createDiscussionBriefRevision } from "@/server/application/discussion-brief";
import {
  DiscussionOrchestrator,
  hasDiscussionConverged
} from "@/server/application/discussion-orchestrator";
import { contentAvailability } from "@/server/application/discussion-protocol";
import { AesCredentialCipher } from "@/server/security/credential-cipher";
import { MemoryStore } from "@/server/store/memory-store";
import {
  createFixtureDiscussion,
  createFixtureBrief,
  createFixtureModelPricing,
  createFixtureProviderAttempt,
  createFixtureState,
  discussionModelGateway,
  RecordingModelGateway,
  TEST_KEY
} from "@/server/test-support/fixtures";
import type {
  AppState,
  Discussion,
  DiscussionRound,
  DiscussionTurnPayload
} from "@/server/domain/types";
import type { ModelGateway } from "@/server/application/model-gateway";

describe("DiscussionOrchestrator", () => {
  it("detects convergence from consecutive quiet Cross-response Rounds", () => {
    const base = createFixtureDiscussion();
    const supported = (statement: string): DiscussionTurnPayload => ({
      summary: statement,
      claims: [
        {
          statement,
          kind: "fact",
          evidenceIds: ["external:https://example.com/evidence"],
          confidence: "high"
        }
      ],
      assumptions: [],
      risks: [],
      openQuestions: [],
      agreements: [],
      disagreements: [],
      corrections: []
    });
    const crossRound = (
      id: string,
      payloads: DiscussionTurnPayload[]
    ): DiscussionRound => {
      const round = structuredClone(base.rounds[0]);
      round.id = id;
      round.phase = "cross_response";
      round.turns.forEach((turn, index) => {
        turn.payload = payloads[index % payloads.length];
      });
      return round;
    };

    const first = crossRound("cross-1", [supported("  Release Risk  ")]);
    const second = crossRound("cross-2", [supported("ｒｅｌｅａｓｅ risk")]);
    const third = crossRound("cross-3", [supported("RELEASE RISK")]);
    expect(hasDiscussionConverged([first])).toBe(false);
    // One quiet Round is not enough; two consecutive quiet Rounds converge.
    expect(hasDiscussionConverged([first, second])).toBe(false);
    expect(hasDiscussionConverged([first, second, third])).toBe(true);

    const freshQuestion = crossRound("cross-4", [
      { ...supported("Release Risk"), openQuestions: ["Is rollback safe?"] }
    ]);
    expect(
      hasDiscussionConverged([first, second, third, freshQuestion])
    ).toBe(false);

    const freshCorrection = crossRound("cross-5", [
      { ...supported("Release Risk"), corrections: ["Earlier estimate was wrong."] }
    ]);
    expect(hasDiscussionConverged([freshQuestion, freshCorrection])).toBe(false);

    const freshEvidence = crossRound("cross-6", [
      {
        ...supported("Release Risk"),
        claims: [
          {
            statement: "Release Risk",
            kind: "fact",
            evidenceIds: ["external:https://example.com/new-source"],
            confidence: "high"
          }
        ]
      }
    ]);
    expect(hasDiscussionConverged([first, freshEvidence])).toBe(false);

    // Unsupported claims, assumptions, and risks are not tracked categories.
    const untracked = crossRound("cross-7", [
      {
        ...supported("Release Risk"),
        claims: [{ statement: "A fresh opinion", confidence: "medium" }],
        assumptions: ["New assumption"],
        risks: ["Straße"]
      }
    ]);
    expect(hasDiscussionConverged([first, second, untracked])).toBe(true);

    // Pending mandatory interventions block convergence.
    expect(
      hasDiscussionConverged([first, second, third], {
        pendingInterventions: 1
      })
    ).toBe(false);
  });

  it("starts a Discussion with a Positions phase Run", async () => {
    const state = createFixtureState();
    const discussion = createFixtureDiscussion({
      workspaceId: state.workspace.id,
      conversationId: state.conversations[0].id
    });
    discussion.status = "draft";
    discussion.currentRound = 0;
    discussion.rounds = [];
    state.discussions.push(discussion);
    const store = new MemoryStore(state);
    const runs = new ConversationRunService(
      store,
      new AesCredentialCipher(TEST_KEY),
      new RecordingModelGateway()
    );
    const orchestrator = new DiscussionOrchestrator(store, runs);

    await orchestrator.startDiscussion(discussion.id);

    const persisted = await store.read((current) => {
      const value = current.discussions.find(
        (item) => item.id === discussion.id
      )!;
      return {
        discussion: value,
        runs: current.runs.filter(
          (run) => run.discussionId === discussion.id
        )
      };
    });
    expect(persisted.discussion).toMatchObject({
      status: "running",
      currentRound: 1,
      promptProfileVersion: "discussion-prompts.v4",
      rounds: [
        {
          roundNumber: 1,
          phase: "positions",
          status: "running"
        }
      ]
    });
    expect(persisted.discussion.events?.map((event) => event.type)).toEqual([
      "discussion_started",
      "phase_started"
    ]);
    expect(
      persisted.discussion.events?.map((event) => event.sequence)
    ).toEqual([1, 2]);
    expect(persisted.discussion.events?.[1].payload).toMatchObject({
      runId: persisted.runs[0].id,
      roundId: persisted.discussion.rounds[0].id
    });
    expect(persisted.runs).toHaveLength(1);
    expect(persisted.runs[0]).toMatchObject({
      status: "queued",
      discussionId: discussion.id,
      discussionRound: 1
    });
  });

  it("allows only one active Discussion per Conversation", async () => {
    const state = createFixtureState();
    const first = createFixtureDiscussion({
      workspaceId: state.workspace.id,
      conversationId: state.conversations[0].id
    });
    const second = createFixtureDiscussion({
      id: "70000000-0000-4000-8000-000000000002",
      workspaceId: state.workspace.id,
      conversationId: state.conversations[0].id
    });
    first.status = "draft";
    second.status = "draft";
    first.rounds = [];
    second.rounds = [];
    state.discussions.push(first, second);
    const store = new MemoryStore(state);
    const orchestrator = new DiscussionOrchestrator(
      store,
      new ConversationRunService(
        store,
        new AesCredentialCipher(TEST_KEY),
        new RecordingModelGateway()
      )
    );

    await expect(
      orchestrator.startDiscussion(first.id)
    ).rejects.toMatchObject({ code: "discussion_active_conflict" });
  });

  it("auto-advances a completed Positions phase into Cross-response", async () => {
    const state = createFixtureState();
    const discussion = createFixtureDiscussion({
      workspaceId: state.workspace.id,
      conversationId: state.conversations[0].id
    });
    discussion.status = "draft";
    discussion.currentRound = 0;
    discussion.rounds = [];
    state.discussions.push(discussion);
    const store = new MemoryStore(state);
    const runs = new ConversationRunService(
      store,
      new AesCredentialCipher(TEST_KEY),
      discussionModelGateway()
    );
    const orchestrator = new DiscussionOrchestrator(store, runs);
    await orchestrator.startDiscussion(discussion.id);
    const positionsRunId = await store.read(
      (current) =>
        current.runs.find((run) => run.discussionId === discussion.id)!.id
    );

    await runs.processRun(positionsRunId);
    await orchestrator.advanceDiscussion(discussion.id);

    const persisted = await store.read((current) => ({
      discussion: current.discussions.find(
        (item) => item.id === discussion.id
      )!,
      runs: current.runs.filter(
        (run) => run.discussionId === discussion.id
      )
    }));
    expect(persisted.discussion).toMatchObject({
      status: "running",
      currentRound: 2,
      rounds: [
        {
          roundNumber: 1,
          phase: "positions",
          status: "completed"
        },
        {
          roundNumber: 2,
          phase: "cross_response",
          status: "running"
        }
      ]
    });
    expect(persisted.discussion.events?.map((event) => event.type)).toEqual([
      "discussion_started",
      "phase_started",
      "provider_attempt_started",
      "evidence_validated",
      "provider_attempt_completed",
      "provider_attempt_started",
      "evidence_validated",
      "provider_attempt_completed",
      "phase_completed",
      "phase_started"
    ]);
    expect(persisted.runs).toHaveLength(2);
    expect(persisted.runs[1]).toMatchObject({
      status: "queued",
      discussionRound: 2
    });
  });

  it("queues a Facilitator-only Synthesis Run after the content budget is exhausted", async () => {
    const state = createFixtureState();
    const discussion = createFixtureDiscussion({
      workspaceId: state.workspace.id,
      conversationId: state.conversations[0].id
    });
    discussion.status = "draft";
    discussion.currentRound = 0;
    discussion.maxRounds = 2;
    discussion.rounds = [];
    state.discussions.push(discussion);
    const store = new MemoryStore(state);
    const runs = new ConversationRunService(
      store,
      new AesCredentialCipher(TEST_KEY),
      discussionModelGateway()
    );
    const orchestrator = new DiscussionOrchestrator(store, runs);
    await orchestrator.startDiscussion(discussion.id);

    await processLatestDiscussionRun(store, runs, discussion.id);
    await setTurnPayloads(store, discussion.id, 1, ["Position A", "Position B"]);
    await orchestrator.advanceDiscussion(discussion.id);

    await processLatestDiscussionRun(store, runs, discussion.id);
    await setTurnPayloads(store, discussion.id, 2, [
      "Cross-response A",
      "Cross-response B"
    ]);
    await orchestrator.advanceDiscussion(discussion.id);

    const persisted = await store.read((current) => ({
      discussion: current.discussions.find(
        (item) => item.id === discussion.id
      )!,
      runs: current.runs.filter(
        (run) => run.discussionId === discussion.id
      )
    }));
    expect(persisted.discussion).toMatchObject({
      status: "running",
      currentRound: 2,
      rounds: [
        { phase: "positions", status: "completed" },
        { phase: "cross_response", status: "completed" },
        {
          roundNumber: 3,
          phase: "synthesis",
          status: "running",
          activeParticipantIds: [
            discussion.facilitatorParticipantId
          ],
          turns: [{ role: "facilitator", status: "pending" }]
        }
      ]
    });
    expect(
      persisted.discussion.events?.map((event) => event.type)
    ).toContain("discussion_budget_exhausted");
    expect(persisted.runs.at(-1)).toMatchObject({
      status: "queued",
      discussionRound: 3,
      memberSnapshot: [
        discussion.participants.find(
          (participant) =>
            participant.id === discussion.facilitatorParticipantId
        )!.employeeId
      ]
    });
  });

  it("queues early Synthesis when a Cross-response Round adds no new values", async () => {
    const state = createFixtureState();
    const discussion = createFixtureDiscussion({
      workspaceId: state.workspace.id,
      conversationId: state.conversations[0].id
    });
    discussion.status = "draft";
    discussion.currentRound = 0;
    discussion.maxRounds = 5;
    discussion.rounds = [];
    state.discussions.push(discussion);
    const store = new MemoryStore(state);
    const runs = new ConversationRunService(
      store,
      new AesCredentialCipher(TEST_KEY),
      discussionModelGateway()
    );
    const orchestrator = new DiscussionOrchestrator(store, runs);
    await orchestrator.startDiscussion(discussion.id);

    await processLatestDiscussionRun(store, runs, discussion.id);
    await setTurnPayloads(store, discussion.id, 1, ["Position A", "Position B"]);
    await orchestrator.advanceDiscussion(discussion.id);

    await processLatestDiscussionRun(store, runs, discussion.id);
    await setTurnPayloads(store, discussion.id, 2, ["Alpha", "Beta"]);
    await orchestrator.advanceDiscussion(discussion.id);

    await processLatestDiscussionRun(store, runs, discussion.id);
    await setTurnPayloads(store, discussion.id, 3, ["alpha", "beta"]);
    const converged = await orchestrator.advanceDiscussion(discussion.id);

    expect(converged.status).toBe("running");
    expect(converged.rounds.at(-1)).toMatchObject({
      roundNumber: 4,
      phase: "synthesis",
      status: "running"
    });
    expect(converged.events?.map((event) => event.type)).toContain(
      "discussion_converged"
    );
    expect(converged.events?.map((event) => event.type)).not.toContain(
      "discussion_budget_exhausted"
    );
  });

  it("stops an active phase as interrupted and resumable", async () => {
    const { store, runs, orchestrator, discussion } =
      await createRunningDiscussion();
    const runId = await store.read(
      (state) =>
        state.runs.find(
          (run) =>
            run.discussionId === discussion.id &&
            run.status === "queued"
        )!.id
    );

    const stopped = await orchestrator.stopDiscussion(discussion.id, {
      reason: "User paused the Discussion"
    });

    expect(stopped.status).toBe("interrupted");
    expect(await runs.getRunById(runId)).toMatchObject({
      status: "cancelled"
    });
    expect(
      stopped.rounds.at(-1)
    ).toMatchObject({ status: "interrupted" });
    expect(stopped.events?.at(-1)).toMatchObject({
      type: "discussion_stopped",
      payload: { reason: "User paused the Discussion" }
    });

    const resumed = await orchestrator.retryPhase(discussion.id);
    expect(resumed.status).toBe("running");
    expect(
      await store.read((state) =>
        state.runs.filter(
          (run) =>
            run.discussionId === discussion.id &&
            run.status === "queued"
        ).length
      )
    ).toBe(1);
  });

  it("cancels an active phase and moves the Discussion to a terminal state", async () => {
    const { store, runs, orchestrator, discussion } =
      await createRunningDiscussion();
    const runId = await store.read(
      (state) =>
        state.runs.find(
          (run) =>
            run.discussionId === discussion.id &&
            run.status === "queued"
        )!.id
    );

    const cancelled = await orchestrator.cancelDiscussion(discussion.id, {
      reason: "No longer needed"
    });

    expect(cancelled.status).toBe("cancelled");
    expect(await runs.getRunById(runId)).toMatchObject({
      status: "cancelled"
    });
    expect(cancelled.rounds.at(-1)).toMatchObject({
      status: "cancelled"
    });
    expect(cancelled.events?.at(-1)).toMatchObject({
      type: "discussion_cancelled",
      payload: { reason: "No longer needed" }
    });
  });

  it("retries a failed phase with a new attempt Run and preserves prior Turns", async () => {
    const { store, runs, orchestrator, discussion } =
      await createRunningDiscussion({
        gateway: failingGateway("phase failed")
      });
    await processLatestDiscussionRun(store, runs, discussion.id);
    await orchestrator.advanceDiscussion(discussion.id);
    const previousRunId = await store.read(
      (state) =>
        state.runs.find((run) => run.discussionId === discussion.id)!.id
    );

    const retried = await orchestrator.retryPhase(discussion.id, {
      reason: "Retry the failed phase"
    });

    const round = retried.rounds.at(-1)!;
    expect(retried.status).toBe("running");
    expect(round.status).toBe("running");
    expect(round.turns).toHaveLength(4);
    expect(round.turns.map((turn) => turn.attempt)).toEqual([1, 1, 2, 2]);
    expect(round.turns[0]).toMatchObject({
      status: "failed"
    });
    expect(round.turns[2]).toMatchObject({
      status: "pending"
    });
    expect(round.runId).not.toBe(previousRunId);
    expect(retried.events?.at(-2)).toMatchObject({
      type: "discussion_resumed",
      payload: { operation: "retry" }
    });
  });

  it("skips a Participant and retries only the remaining Participants", async () => {
    const { store, runs, orchestrator, discussion } =
      await createRunningDiscussion({
        participantCount: 3,
        gateway: failingGateway("phase failed")
      });
    await processLatestDiscussionRun(store, runs, discussion.id);
    await orchestrator.advanceDiscussion(discussion.id);
    const skippedEmployeeId =
      discussion.participants[2].employeeId;

    const skipped = await orchestrator.skipParticipant(discussion.id, {
      employeeId: skippedEmployeeId,
      reason: "Participant unavailable"
    });

    expect(
      skipped.rounds
        .at(-1)!
        .turns.find((turn) => turn.employeeId === skippedEmployeeId)
    ).toMatchObject({
      status: "cancelled",
      cancelReason: "skipped_by_user"
    });
    expect(skipped.events?.at(-1)).toMatchObject({
      type: "participant_skipped",
      payload: {
        employeeId: skippedEmployeeId,
        reason: "Participant unavailable"
      }
    });

    const retried = await orchestrator.retryPhase(discussion.id);
    expect(retried.rounds.at(-1)?.activeParticipantIds).toEqual(
      discussion.participants
        .slice(0, 2)
        .map((participant) => participant.id)
    );
    const queuedRun = await store.read((state) =>
      state.runs.find(
        (run) =>
          run.discussionId === discussion.id &&
          run.status === "queued"
      )
    );
    expect(queuedRun?.memberSnapshot).toEqual(
      discussion.participants
        .slice(0, 2)
        .map((participant) => participant.employeeId)
    );
  });

  it("requires sufficient content for Synthesis unless the user forces it", async () => {
    const state = createFixtureState();
    const discussion = createFixtureDiscussion({
      workspaceId: state.workspace.id,
      conversationId: state.conversations[0].id
    });
    discussion.status = "interrupted";
    delete discussion.promptProfileVersion;
    discussion.latestBriefArtifactId = "brief-context";
    state.discussions.push(discussion);
    state.artifacts.push({
      id: "brief-context",
      workspaceId: state.workspace.id,
      ownerType: "discussion",
      ownerId: discussion.id,
      type: "json",
      name: "Latest Brief",
      content: JSON.stringify(createFixtureBrief(discussion.id)),
      kind: "discussion_brief",
      schemaVersion: 2,
      revision: 1,
      createdAt: state.workspace.createdAt,
      updatedAt: state.workspace.updatedAt
    });
    const store = new MemoryStore(state);
    const engine = discussionModelGateway();
    const runs = new ConversationRunService(
      store,
      new AesCredentialCipher(TEST_KEY),
      engine
    );
    const orchestrator = new DiscussionOrchestrator(store, runs);

    await expect(
      orchestrator.synthesize(discussion.id)
    ).rejects.toMatchObject({ code: "discussion_insufficient_turns" });

    const forced = await orchestrator.synthesize(discussion.id, {
      force: true,
      reason: "Proceed with the available material"
    });
    expect(forced).toMatchObject({
      status: "running",
      promptProfileVersion: "discussion-prompts.v4"
    });
    const synthesis = forced.rounds.at(-1)!;
    expect(synthesis).toMatchObject({
      phase: "synthesis",
      status: "running",
      activeParticipantIds: [discussion.facilitatorParticipantId],
      turns: [{ role: "facilitator", status: "pending" }]
    });
    expect(
      await store.read((current) =>
        current.runs.find(
          (run) => run.discussionId === discussion.id
        )
      )
    ).toMatchObject({
      status: "queued",
      memberSnapshot: [
        discussion.participants.find(
          (participant) =>
            participant.id === discussion.facilitatorParticipantId
        )!.employeeId
      ]
    });

    await processLatestDiscussionRun(store, runs, discussion.id);
    expect(engine.requests[0].prompt).toContain(
      "SQLite and PostgreSQL are supported."
    );
    const reviewed = await orchestrator.advanceDiscussion(discussion.id);
    expect(reviewed.status).toBe("review");
    expect(reviewed.events?.at(-1)).toMatchObject({
      type: "discussion_review_requested"
    });
    const briefArtifact = await store.read((current) =>
      current.artifacts.find(
        (artifact) => artifact.id === reviewed.latestBriefArtifactId
      )
    );
    expect(briefArtifact).toMatchObject({
      ownerType: "discussion",
      ownerId: discussion.id,
      type: "json",
      kind: "discussion_brief",
      schemaVersion: 2,
      revision: 2,
      previousArtifactId: "brief-context"
    });
    expect(JSON.parse(briefArtifact!.content)).toMatchObject({
      promptProfileVersion: "discussion-prompts.v4"
    });
    expect(reviewed.events?.map((event) => event.type)).toContain(
      "brief_created"
    );
  });

  it("replaces the Facilitator without rewriting historical Round snapshots", async () => {
    const { orchestrator, discussion } =
      await createRunningDiscussion({ participantCount: 3 });
    await orchestrator.stopDiscussion(discussion.id);
    const historicalRound = structuredClone(
      (await orchestrator.getDiscussion(discussion.id)).rounds.at(-1)!
    );
    const replacement = discussion.participants[2];

    const replaced = await orchestrator.replaceFacilitator(discussion.id, {
      employeeId: replacement.employeeId,
      reason: "Original Facilitator is unavailable"
    });

    expect(
      replaced.participants.find(
        (participant) => participant.id === replacement.id
      )?.role
    ).toBe("facilitator");
    expect(replaced.facilitatorParticipantId).toBe(replacement.id);
    expect(replaced.events?.at(-1)).toMatchObject({
      type: "facilitator_replaced",
      payload: {
        facilitatorParticipantId: replacement.id,
        employeeId: replacement.employeeId
      }
    });
    expect(
      replaced.rounds.find((round) => round.id === historicalRound.id)
    ).toBeDefined();
    expect(
      replaced.rounds
        .find((round) => round.id === historicalRound.id)!
        .turns.map((turn) => turn.id)
    ).toEqual(historicalRound.turns.map((turn) => turn.id));
    expect(
      replaced.rounds.find((round) => round.id === historicalRound.id)
        ?.participantSnapshot
    ).toEqual(historicalRound.participantSnapshot);
    expect(
      replaced.rounds
        .find((round) => round.id === historicalRound.id)
        ?.turns.map((turn) => turn.role)
    ).toEqual(historicalRound.turns.map((turn) => turn.role));
  });

  it("does not create a Brief revision when Synthesis validation fails", async () => {
    const state = createFixtureState();
    const discussion = createFixtureDiscussion({
      workspaceId: state.workspace.id,
      conversationId: state.conversations[0].id
    });
    discussion.status = "interrupted";
    state.discussions.push(discussion);
    const store = new MemoryStore(state);
    const runs = new ConversationRunService(
      store,
      new AesCredentialCipher(TEST_KEY),
      {
        async *run() {
          yield { type: "text_delta", delta: "not a brief" };
          yield { type: "text_completed", text: "not a brief" };
        }
      }
    );
    const orchestrator = new DiscussionOrchestrator(store, runs);
    const started = await orchestrator.synthesize(discussion.id, {
      force: true
    });
    await processLatestDiscussionRun(
      store,
      runs,
      started.id
    );
    const interrupted = await orchestrator.advanceDiscussion(discussion.id);

    expect(interrupted.status).toBe("interrupted");
    expect(interrupted.latestBriefArtifactId).toBeUndefined();
    expect(await store.read((current) => current.artifacts)).toEqual([]);
  });

  it("confirms the latest Brief into one draft Task atomically", async () => {
    const state = createFixtureState();
    const discussion = createFixtureDiscussion({
      workspaceId: state.workspace.id,
      conversationId: state.conversations[0].id
    });
    discussion.status = "review";
    discussion.sourceTaskId = "source-task";
    const brief = createFixtureBrief(discussion.id);
    brief.options.push({
      id: "relational",
      title: "Normalize the state",
      summary: "Use relational tables.",
      benefits: ["Strong queries"],
      costs: ["More migrations"],
      risks: ["More schema work"]
    });
    createDiscussionBriefRevision(
      state,
      discussion,
      JSON.stringify(brief),
      {
        id: () => "brief-revision-1",
        now: () => state.workspace.createdAt
      }
    );
    state.tasks.push({
      id: "source-task",
      workspaceId: state.workspace.id,
      conversationId: discussion.conversationId,
      title: "Source Task",
      goal: "Remain unchanged.",
      assigneeIds: [state.employees[0].id],
      status: "draft",
      history: [],
      createdAt: state.workspace.createdAt,
      updatedAt: state.workspace.updatedAt
    });
    state.discussions.push(discussion);
    const store = new MemoryStore(state);
    const orchestrator = new DiscussionOrchestrator(
      store,
      new ConversationRunService(
        store,
        new AesCredentialCipher(TEST_KEY),
        discussionModelGateway()
      )
    );

    const confirmed = await orchestrator.confirmBrief(discussion.id, {
      briefArtifactId: "brief-revision-1",
      selectedOptionId: "relational",
      taskTitle: "Implement relational persistence",
      taskGoal: "Normalize the aggregate."
    });

    expect(confirmed.task).toMatchObject({
      conversationId: discussion.conversationId,
      discussionId: discussion.id,
      confirmedBriefArtifactId: "brief-revision-1",
      title: "Implement relational persistence",
      goal: "Normalize the aggregate.",
      assigneeIds: [
        discussion.participants[1].employeeId,
        discussion.participants[0].employeeId
      ],
      status: "draft"
    });
    expect(confirmed.discussion).toMatchObject({
      status: "completed",
      confirmedBriefArtifactId: "brief-revision-1",
      confirmedTaskId: confirmed.task.id,
      sourceTaskId: "source-task"
    });
    expect(confirmed.discussion.events?.at(-1)).toMatchObject({
      type: "discussion_confirmed",
      payload: {
        confirmedBriefArtifactId: "brief-revision-1",
        selectedOptionId: "relational",
        confirmedTaskId: confirmed.task.id
      }
    });
    expect(
      await store.read((current) =>
        current.tasks.find((task) => task.id === "source-task")
      )
    ).toMatchObject({
      title: "Source Task",
      goal: "Remain unchanged."
    });
  });

  it("rolls back confirmation and leaves the Discussion in review on failure", async () => {
    const state = createFixtureState();
    const discussion = createFixtureDiscussion({
      workspaceId: state.workspace.id,
      conversationId: state.conversations[0].id
    });
    discussion.status = "review";
    createDiscussionBriefRevision(
      state,
      discussion,
      JSON.stringify(createFixtureBrief(discussion.id)),
      {
        id: () => "brief-revision-1",
        now: () => state.workspace.createdAt
      }
    );
    state.discussions.push(discussion);
    const store = new MemoryStore(state);
    const orchestrator = new DiscussionOrchestrator(
      store,
      new ConversationRunService(
        store,
        new AesCredentialCipher(TEST_KEY),
        discussionModelGateway()
      )
    );

    await expect(
      orchestrator.confirmBrief(discussion.id, {
        assigneeIds: ["missing-employee"]
      })
    ).rejects.toMatchObject({
      code: "discussion_invalid_participants"
    });

    const persisted = await store.read((current) => ({
      discussion: current.discussions.find(
        (item) => item.id === discussion.id
      )!,
      tasks: current.tasks
    }));
    expect(persisted.discussion).toMatchObject({
      status: "review"
    });
    expect(persisted.discussion.confirmedTaskId).toBeUndefined();
    expect(persisted.tasks).toEqual([]);
  });

  it("moves a worker-interrupted phase to interrupted without automatic retry", async () => {
    const { store, runs, orchestrator, discussion } =
      await createRunningDiscussion({
        options: {
          maxActiveDurationMs: Number.MAX_SAFE_INTEGER,
          maxPhaseDurationMs: Number.MAX_SAFE_INTEGER
        }
      });
    const runId = await store.read(
      (state) =>
        state.runs.find((run) => run.discussionId === discussion.id)!.id
    );
    await store.update((state) => {
      const run = state.runs.find((item) => item.id === runId)!;
      run.status = "running";
      run.startedAt = state.workspace.createdAt;
    });

    await runs.recoverInterruptedRuns();
    await orchestrator.recoverInterruptedDiscussions();

    const persisted = await store.read((current) => ({
      discussion: current.discussions.find(
        (item) => item.id === discussion.id
      )!,
      runs: current.runs.filter(
        (run) => run.discussionId === discussion.id
      )
    }));
    expect(persisted.discussion.status).toBe("interrupted");
    expect(persisted.discussion.rounds.at(-1)).toMatchObject({
      status: "interrupted"
    });
    expect(persisted.runs).toHaveLength(1);
    expect(persisted.runs[0].status).toBe("interrupted");
    expect(persisted.discussion.events?.at(-1)).toMatchObject({
      type: "discussion_interrupted",
      payload: { code: "worker_restart" }
    });
  });

  it("applies an intervention immediately when no Run is active", async () => {
    const { store, orchestrator, discussion } =
      await createRunningDiscussion();
    await orchestrator.stopDiscussion(discussion.id);

    const view = await orchestrator.addIntervention(discussion.id, {
      kind: "material",
      content: "Use the payroll dataset for validation."
    });

    expect(view.interventions).toContainEqual(
      expect.objectContaining({
        kind: "material",
        content: "Use the payroll dataset for validation.",
        status: "applied",
        appliedPhase: "positions",
        resultingDiscussionRevision: 2
      })
    );
    const persisted = await store.read(
      (state) =>
        state.discussions.find((item) => item.id === discussion.id)!
    );
    expect(persisted.revision).toBe(2);
    expect(persisted.events?.at(-1)).toMatchObject({
      type: "intervention_applied"
    });
  });

  it("queues interventions during a Run and applies them at the phase boundary", async () => {
    const { store, runs, orchestrator, discussion } =
      await createRunningDiscussion();

    const queued = await orchestrator.addIntervention(discussion.id, {
      kind: "constraint",
      content: "Keep the migration reversible."
    });
    expect(queued.interventions).toContainEqual(
      expect.objectContaining({
        kind: "constraint",
        status: "pending",
        appliedPhase: undefined
      })
    );

    await processLatestDiscussionRun(store, runs, discussion.id);
    await orchestrator.advanceDiscussion(discussion.id);

    const persisted = await store.read((state) => ({
      discussion: state.discussions.find(
        (item) => item.id === discussion.id
      )!,
      intervention: state.discussionInterventions.find(
        (item) => item.discussionId === discussion.id
      )!
    }));
    expect(persisted.intervention).toMatchObject({
      kind: "constraint",
      status: "applied",
      appliedPhase: "positions",
      resultingDiscussionRevision: 1
    });
    expect(persisted.discussion.constraints).toContain(
      "Keep the migration reversible."
    );
    expect(
      persisted.discussion.events?.map((event) => event.type)
    ).toEqual(
      expect.arrayContaining(["intervention_queued", "intervention_applied"])
    );
  });

  it("keeps the legacy constraint command backward compatible", async () => {
    const { store, orchestrator, discussion } =
      await createRunningDiscussion();
    await orchestrator.stopDiscussion(discussion.id);

    const view = await orchestrator.addConstraints(discussion.id, {
      constraints: ["Keep the API stable."],
      questions: ["What is the rollback path?"],
      note: "Focus on migration risk."
    });

    expect(
      view.interventions
        .map((intervention) => intervention.kind)
        .filter((kind) =>
          ["constraint", "question", "focus"].includes(kind)
        )
    ).toEqual(["constraint", "question", "focus"]);
    const persisted = await store.read(
      (state) =>
        state.discussions.find((item) => item.id === discussion.id)!
    );
    expect(persisted).toMatchObject({
      constraints: ["Keep the API stable."],
      questions: ["What is the rollback path?"],
      note: "Focus on migration risk.",
      revision: 4
    });
  });

  it("invalidates review when a new intervention is applied", async () => {
    const { store, orchestrator, discussion } =
      await createRunningDiscussion();
    await orchestrator.stopDiscussion(discussion.id);
    await store.update((state) => {
      const current = state.discussions.find(
        (item) => item.id === discussion.id
      )!;
      current.status = "review";
    });

    const view = await orchestrator.addIntervention(discussion.id, {
      kind: "correction",
      content: "The previous recommendation used stale evidence."
    });

    expect(view.discussion.status).toBe("interrupted");
    expect(view.interventions.at(-1)).toMatchObject({
      kind: "correction",
      status: "applied"
    });
    expect(
      await store.read((state) =>
        state.discussions
          .find((item) => item.id === discussion.id)
          ?.events?.at(-1)
      )
    ).toMatchObject({
      type: "discussion_interrupted",
      payload: { code: "intervention_requires_resynthesis" }
    });
  });

  it("records mode, participant, and budget changes as interventions", async () => {
    const { store, orchestrator, discussion } =
      await createRunningDiscussion();
    await orchestrator.stopDiscussion(discussion.id);
    await store.update((state) => {
      const current = state.discussions.find(
        (item) => item.id === discussion.id
      )!;
      current.status = "review";
    });

    const view = await orchestrator.updateDiscussion(discussion.id, {
      mode: "review",
      maxRounds: 4,
      participants: discussion.participants.map((participant) => ({
        employeeId: participant.employeeId,
        role: participant.role,
        objective: participant.objective
      })),
      facilitatorId:
        discussion.participants.find(
          (participant) =>
            participant.id === discussion.facilitatorParticipantId
        )!.employeeId
    });

    expect(view.discussion).toMatchObject({
      status: "interrupted",
      mode: "review",
      maxRounds: 4
    });
    expect(
      view.interventions.map((intervention) => intervention.kind)
    ).toEqual(
      expect.arrayContaining([
        "mode_change",
        "participant_change",
        "budget_change"
      ])
    );
    expect(
      view.interventions.every(
        (intervention) =>
          intervention.status === "applied" &&
          intervention.resultingDiscussionRevision !== undefined
      )
    ).toBe(true);
  });

  it("preserves intervention queue order across stop and resume", async () => {
    const { store, orchestrator, discussion } =
      await createRunningDiscussion();
    await orchestrator.addIntervention(discussion.id, {
      kind: "constraint",
      content: "First queued intervention."
    });
    await orchestrator.stopDiscussion(discussion.id);
    await orchestrator.addIntervention(discussion.id, {
      kind: "correction",
      content: "Second queued intervention."
    });
    await orchestrator.retryPhase(discussion.id);

    const queued = await store.read((state) =>
      state.discussionInterventions
        .filter(
          (intervention) =>
            intervention.discussionId === discussion.id &&
            ["First queued intervention.", "Second queued intervention."].includes(
              intervention.content
            )
        )
        .sort((left, right) =>
          left.createdAt.localeCompare(right.createdAt)
        )
    );
    expect(
      queued.map((intervention) => [
        intervention.content,
        intervention.status,
        intervention.resultingDiscussionRevision
      ])
    ).toEqual([
      ["First queued intervention.", "applied", 2],
      ["Second queued intervention.", "applied", 3]
    ]);
  });

  it("uses stable phase and total timeout codes", async () => {
    let now = "2026-01-01T00:00:00.000Z";
    const { store, runs, orchestrator, discussion } =
      await createRunningDiscussion({
        options: {
          clock: () => now,
          maxActiveDurationMs: 60_000,
          maxPhaseDurationMs: 30_000
        }
      });
    await store.update((state) => {
      const current = state.discussions.find(
        (item) => item.id === discussion.id
      )!;
      current.rounds.at(-1)!.startedAt = now;
    });
    now = "2026-01-01T00:00:31.000Z";
    await orchestrator.reconcileDiscussions();
    expect(
      (await orchestrator.getDiscussion(discussion.id)).events?.at(-1)
    ).toMatchObject({
      type: "discussion_interrupted",
      payload: { code: "discussion_phase_timeout" }
    });

    now = "2026-01-01T00:00:00.000Z";
    const total = await createRunningDiscussion({
      options: {
        clock: () => now,
        maxActiveDurationMs: 60_000,
        maxPhaseDurationMs: 120_000
      }
    });
    await total.store.update((state) => {
      const current = state.discussions.find(
        (item) => item.id === total.discussion.id
      )!;
      current.startedAt = now;
      current.rounds.at(-1)!.startedAt = now;
    });
    now = "2026-01-01T00:01:01.000Z";
    await total.orchestrator.reconcileDiscussions();
    expect(
      (await total.orchestrator.getDiscussion(total.discussion.id)).events?.at(
        -1
      )
    ).toMatchObject({
      type: "discussion_interrupted",
      payload: { code: "discussion_total_timeout" }
    });
    expect(
      await store.read((state) =>
        state.discussions.find((item) => item.id === discussion.id)?.status
      )
    ).toBe("interrupted");
    expect(await runs.getRunById(
      (await store.read(
        (state) =>
          state.runs.find((run) => run.discussionId === discussion.id)!.id
      ))
    )).toMatchObject({ status: "cancelled" });
  });
});

async function createRunningDiscussion(
  options: {
    participantCount?: number;
    gateway?: ModelGateway;
    options?: ConstructorParameters<typeof DiscussionOrchestrator>[2];
  } = {}
) {
  const state = createFixtureState();
  const discussion = createFixtureDiscussion({
    workspaceId: state.workspace.id,
    conversationId: state.conversations[0].id
  });
  discussion.status = "draft";
  discussion.currentRound = 0;
  discussion.rounds = [];
  if ((options.participantCount ?? 2) > 2) {
    const employeeId = "20000000-0000-4000-8000-000000000003";
    state.employees.push({
      id: employeeId,
      workspaceId: state.workspace.id,
      name: "Carol",
      identity: "You challenge assumptions.",
      providerCredentialId: state.providers[0].id,
      modelId: "test-model",
      skillIds: [],
      active: true,
      createdAt: state.workspace.createdAt,
      updatedAt: state.workspace.updatedAt
    });
    state.conversations[0].memberIds.push(employeeId);
    discussion.participants.push({
      id: "participant-skeptic",
      employeeId,
      role: "skeptic",
      objective: "Challenge assumptions.",
      order: 3
    });
  }
  state.discussions.push(discussion);
  const store = new MemoryStore(state);
  const runs = new ConversationRunService(
    store,
    new AesCredentialCipher(TEST_KEY),
    options.gateway ?? discussionModelGateway()
  );
  const orchestrator = new DiscussionOrchestrator(
    store,
    runs,
    options.options
  );
  await orchestrator.startDiscussion(discussion.id);
  return { store, runs, orchestrator, discussion };
}

function failingGateway(message: string): ModelGateway {
  return {
    async *run() {
      yield { type: "error", message, kind: "terminal" };
    }
  };
}

describe("DiscussionOrchestrator convergence and synthesis governance", () => {
  function governanceHarness(state: AppState) {
    const store = new MemoryStore(state);
    const runs = new ConversationRunService(
      store,
      new AesCredentialCipher(TEST_KEY),
      discussionModelGateway()
    );
    return {
      store,
      runs,
      orchestrator: new DiscussionOrchestrator(store, runs)
    };
  }

  function draftDiscussion(state: AppState, maxRounds: number): Discussion {
    const discussion = createFixtureDiscussion({
      workspaceId: state.workspace.id,
      conversationId: state.conversations[0].id
    });
    discussion.status = "draft";
    discussion.currentRound = 0;
    discussion.maxRounds = maxRounds;
    discussion.rounds = [];
    state.discussions.push(discussion);
    return discussion;
  }

  async function setSupportedPayloads(
    store: MemoryStore,
    discussionId: string,
    roundNumber: number,
    marker: string,
    recommend = false
  ): Promise<void> {
    await store.update((state) => {
      const round = state.discussions
        .find((item) => item.id === discussionId)!
        .rounds.find((item) => item.roundNumber === roundNumber)!;
      round.turns.forEach((turn, index) => {
        turn.payload = {
          summary: `${marker} ${index}`,
          claims: [
            {
              statement: `${marker} claim ${index}`,
              kind: "fact",
              evidenceIds: [
                `external:https://example.com/${marker}-${index}`
              ],
              confidence: "high"
            }
          ],
          assumptions: [],
          risks: [],
          openQuestions: [],
          agreements: [],
          disagreements: [],
          corrections: [],
          ...(recommend
            ? {
                convergence: {
                  recommended: true,
                  reasons: ["Analysis looks complete."]
                }
              }
            : {})
        };
      });
    });
  }

  it("treats model convergence recommendations as advisory only", async () => {
    const state = createFixtureState();
    const discussion = draftDiscussion(state, 5);
    const { store, runs, orchestrator } = governanceHarness(state);

    await orchestrator.startDiscussion(discussion.id);
    await processLatestDiscussionRun(store, runs, discussion.id);
    await setSupportedPayloads(store, discussion.id, 1, "position", true);
    await orchestrator.advanceDiscussion(discussion.id);
    await processLatestDiscussionRun(store, runs, discussion.id);
    await setSupportedPayloads(store, discussion.id, 2, "cross-two", true);

    const advanced = await orchestrator.advanceDiscussion(discussion.id);

    // Fresh supported values exist, so the recommendation cannot converge
    // the Discussion: another Cross-response Round is scheduled.
    expect(advanced.status).toBe("running");
    expect(advanced.rounds.at(-1)).toMatchObject({
      roundNumber: 3,
      phase: "cross_response"
    });
    expect(
      (advanced.events ?? []).some(
        (event) => event.type === "discussion_converged"
      )
    ).toBe(false);
  });

  it("blocks convergence while a mandatory intervention is pending", async () => {
    const state = createFixtureState();
    const discussion = draftDiscussion(state, 5);
    const { store, runs, orchestrator } = governanceHarness(state);

    await orchestrator.startDiscussion(discussion.id);
    await processLatestDiscussionRun(store, runs, discussion.id);
    await setTurnPayloads(store, discussion.id, 1, ["Position A", "Position B"]);
    await orchestrator.advanceDiscussion(discussion.id);
    await processLatestDiscussionRun(store, runs, discussion.id);
    await setTurnPayloads(store, discussion.id, 2, ["Cross A", "Cross B"]);
    await orchestrator.advanceDiscussion(discussion.id);
    await processLatestDiscussionRun(store, runs, discussion.id);
    await setTurnPayloads(store, discussion.id, 3, ["Cross A", "Cross B"]);

    await orchestrator.addIntervention(
      discussion.id,
      { kind: "constraint", content: "Keep PostgreSQL optional." },
      {}
    );

    const blocked = await orchestrator.advanceDiscussion(discussion.id);
    expect(blocked.rounds.at(-1)).toMatchObject({
      roundNumber: 4,
      phase: "cross_response"
    });
    expect(
      (blocked.events ?? []).some(
        (event) => event.type === "discussion_converged"
      )
    ).toBe(false);

    await processLatestDiscussionRun(store, runs, discussion.id);
    await setTurnPayloads(store, discussion.id, 4, ["Cross A", "Cross B"]);
    const converged = await orchestrator.advanceDiscussion(discussion.id);
    expect(converged.rounds.at(-1)).toMatchObject({ phase: "synthesis" });
    expect(
      (converged.events ?? []).some(
        (event) => event.type === "discussion_converged"
      )
    ).toBe(true);
  });

  it("gives round, token, and cost limits precedence over convergence", async () => {
    const state = createFixtureState();
    const discussion = draftDiscussion(state, 3);
    const { store, runs, orchestrator } = governanceHarness(state);

    await orchestrator.startDiscussion(discussion.id);
    await processLatestDiscussionRun(store, runs, discussion.id);
    await setTurnPayloads(store, discussion.id, 1, ["Position A", "Position B"]);
    await orchestrator.advanceDiscussion(discussion.id);
    await processLatestDiscussionRun(store, runs, discussion.id);
    await setTurnPayloads(store, discussion.id, 2, ["Cross A", "Cross B"]);
    await orchestrator.advanceDiscussion(discussion.id);
    await processLatestDiscussionRun(store, runs, discussion.id);
    await setTurnPayloads(store, discussion.id, 3, ["Cross A", "Cross B"]);

    // Two consecutive quiet Rounds coincide with the round cap: the cap
    // reason wins.
    const advanced = await orchestrator.advanceDiscussion(discussion.id);
    expect(advanced.rounds.at(-1)).toMatchObject({ phase: "synthesis" });
    const types = (advanced.events ?? []).map((event) => event.type);
    expect(types).toContain("discussion_budget_exhausted");
    expect(types).not.toContain("discussion_converged");
  });

  it("terminates at the round cap when values never stop changing", async () => {
    const state = createFixtureState();
    const discussion = draftDiscussion(state, 3);
    const { store, runs, orchestrator } = governanceHarness(state);

    await orchestrator.startDiscussion(discussion.id);
    await processLatestDiscussionRun(store, runs, discussion.id);
    await setSupportedPayloads(store, discussion.id, 1, "position");
    await orchestrator.advanceDiscussion(discussion.id);
    await processLatestDiscussionRun(store, runs, discussion.id);
    await setSupportedPayloads(store, discussion.id, 2, "cross-two");
    await orchestrator.advanceDiscussion(discussion.id);
    await processLatestDiscussionRun(store, runs, discussion.id);
    await setSupportedPayloads(store, discussion.id, 3, "cross-three");

    const advanced = await orchestrator.advanceDiscussion(discussion.id);
    expect(advanced.rounds.at(-1)).toMatchObject({ phase: "synthesis" });
    expect(
      (advanced.events ?? []).some(
        (event) => event.type === "discussion_converged"
      )
    ).toBe(false);
  });

  it("gives token budget exhaustion precedence over a satisfied convergence rule", async () => {
    const state = createFixtureState();
    const discussion = draftDiscussion(state, 5);
    discussion.budget = { maxTotalTokens: 100_000, softTotalTokens: 40 };
    const { store, runs, orchestrator } = governanceHarness(state);

    await orchestrator.startDiscussion(discussion.id);
    await processLatestDiscussionRun(store, runs, discussion.id);
    await setTurnPayloads(store, discussion.id, 1, ["Position A", "Position B"]);
    await orchestrator.advanceDiscussion(discussion.id);
    await processLatestDiscussionRun(store, runs, discussion.id);
    await setTurnPayloads(store, discussion.id, 2, ["Cross A", "Cross B"]);
    await orchestrator.advanceDiscussion(discussion.id);
    await processLatestDiscussionRun(store, runs, discussion.id);
    await setTurnPayloads(store, discussion.id, 3, ["Cross A", "Cross B"]);
    // Two consecutive quiet Rounds would converge, but the soft token
    // budget is exhausted first.
    await store.update((current) => {
      current.providerAttempts.push(
        createFixtureProviderAttempt({
          id: "convergence-budget-1",
          workspaceId: current.workspace.id,
          discussionId: discussion.id,
          purpose: "discussion_turn",
          usage: {
            inputTokens: 50,
            outputTokens: 0,
            totalTokens: 50,
            source: "provider"
          }
        })
      );
    });

    const advanced = await orchestrator.advanceDiscussion(discussion.id);

    expect(advanced.rounds.at(-1)).toMatchObject({ phase: "synthesis" });
    const types = (advanced.events ?? []).map((event) => event.type);
    expect(types).toContain("discussion_budget_exhausted");
    expect(types).not.toContain("discussion_converged");
  });

  it("never converges on Cross-response Rounds without validated payloads", () => {
    const base = createFixtureDiscussion();
    const crossRound = (id: string, withPayload: boolean): DiscussionRound => {
      const round = structuredClone(base.rounds[0]);
      round.id = id;
      round.phase = "cross_response";
      round.turns.forEach((turn) => {
        if (withPayload) return;
        turn.payload = undefined;
        turn.content = "Text without a validated payload.";
      });
      return round;
    };

    expect(
      hasDiscussionConverged([
        crossRound("cross-1", false),
        crossRound("cross-2", false)
      ])
    ).toBe(false);
  });

  it("does not count content-only Turns toward the synthesis minimum", () => {
    const discussion = createFixtureDiscussion();
    const round = discussion.rounds[0];
    round.turns.forEach((turn) => {
      turn.payload = undefined;
      turn.content = "Text without a validated payload.";
    });
    expect(contentAvailability([round])).toEqual({
      validPositionParticipants: 0,
      validCrossResponseTurns: 0
    });
  });

  it("interrupts with a stable reason when the Facilitator is unavailable", async () => {
    const state = createFixtureState();
    const discussion = draftDiscussion(state, 5);
    const { store, runs, orchestrator } = governanceHarness(state);

    await orchestrator.startDiscussion(discussion.id);
    await processLatestDiscussionRun(store, runs, discussion.id);
    await setSupportedPayloads(store, discussion.id, 1, "position");
    for (const roundNumber of [2, 3, 4]) {
      await orchestrator.advanceDiscussion(discussion.id);
      await processLatestDiscussionRun(store, runs, discussion.id);
      if (roundNumber < 4) {
        await setSupportedPayloads(store, discussion.id, roundNumber, "cross");
      }
    }
    await setSupportedPayloads(store, discussion.id, 4, "cross");

    await store.update((current) => {
      const facilitatorEmployeeId = current.discussions
        .find((item) => item.id === discussion.id)!
        .participants.find(
          (participant) =>
            participant.id ===
            current.discussions.find((item) => item.id === discussion.id)!
              .facilitatorParticipantId
        )!.employeeId;
      current.employees.find(
        (employee) => employee.id === facilitatorEmployeeId
      )!.active = false;
    });

    const interrupted = await orchestrator.advanceDiscussion(discussion.id);

    expect(interrupted.status).toBe("interrupted");
    expect(
      interrupted.rounds.map((round) => round.phase)
    ).not.toContain("synthesis");
    expect(interrupted.events?.at(-1)).toMatchObject({
      type: "discussion_interrupted",
      payload: { code: "discussion_facilitator_unavailable" }
    });
    // Completed Rounds stay reviewable instead of failing silently.
    expect(
      interrupted.rounds.filter((round) => round.status === "completed")
    ).toHaveLength(4);
  });

  it("interrupts when a restored Round carries a fact claim without evidence", async () => {
    const state = createFixtureState();
    const discussion = draftDiscussion(state, 5);
    const { store, runs, orchestrator } = governanceHarness(state);

    await orchestrator.startDiscussion(discussion.id);
    await processLatestDiscussionRun(store, runs, discussion.id);
    await setSupportedPayloads(store, discussion.id, 1, "position");
    for (const roundNumber of [2, 3, 4]) {
      await orchestrator.advanceDiscussion(discussion.id);
      await processLatestDiscussionRun(store, runs, discussion.id);
      if (roundNumber < 4) {
        await setSupportedPayloads(store, discussion.id, roundNumber, "cross");
      }
    }
    await setSupportedPayloads(store, discussion.id, 4, "cross");
    await store.update((current) => {
      const round = current.discussions
        .find((item) => item.id === discussion.id)!
        .rounds.at(-1)!;
      round.turns[0].payload = {
        ...round.turns[0].payload!,
        claims: [
          {
            statement: "Restored fact without evidence.",
            kind: "fact",
            evidenceIds: [],
            confidence: "high"
          }
        ]
      };
    });

    const interrupted = await orchestrator.advanceDiscussion(discussion.id);

    expect(interrupted.status).toBe("interrupted");
    expect(
      interrupted.rounds.map((round) => round.phase)
    ).not.toContain("synthesis");
    expect(interrupted.events?.at(-1)).toMatchObject({
      type: "discussion_interrupted",
      payload: { code: "discussion_evidence_unvalidated" }
    });
    expect(
      interrupted.rounds.filter((round) => round.status === "completed")
    ).toHaveLength(4);
  });
});

describe("DiscussionOrchestrator budget enforcement", () => {
  function harness(state: AppState) {
    const store = new MemoryStore(state);
    const runs = new ConversationRunService(
      store,
      new AesCredentialCipher(TEST_KEY),
      discussionModelGateway()
    );
    return { store, runs, orchestrator: new DiscussionOrchestrator(store, runs) };
  }

  function draftDiscussion(state: AppState): Discussion {
    const discussion = createFixtureDiscussion({
      workspaceId: state.workspace.id,
      conversationId: state.conversations[0].id
    });
    discussion.status = "draft";
    discussion.currentRound = 0;
    discussion.rounds = [];
    state.discussions.push(discussion);
    return discussion;
  }

  async function stampUsage(
    store: MemoryStore,
    discussionId: string,
    id: string,
    totalTokens: number
  ): Promise<void> {
    await store.update((state) => {
      state.providerAttempts.push(
        createFixtureProviderAttempt({
          id,
          workspaceId: state.workspace.id,
          discussionId,
          purpose: "discussion_turn",
          usage: {
            inputTokens: totalTokens,
            outputTokens: 0,
            totalTokens,
            source: "provider"
          }
        })
      );
    });
  }

  it("inherits Workspace budget defaults at creation and overrides field-wise", async () => {
    const state = createFixtureState();
    state.workspace.discussionBudgetDefaults = {
      maxTotalTokens: 1_000,
      maxTotalCostMicros: 5_000,
      currency: "USD"
    };
    state.conversations.push({
      id: "30000000-0000-4000-8000-000000000002",
      workspaceId: state.workspace.id,
      title: "Second conversation",
      memberIds: state.conversations[0].memberIds,
      createdAt: state.workspace.createdAt,
      updatedAt: state.workspace.updatedAt
    });
    const { orchestrator } = harness(state);
    const participants = [
      { employeeId: "20000000-0000-4000-8000-000000000001", role: "analyst" as const },
      { employeeId: "20000000-0000-4000-8000-000000000002", role: "facilitator" as const }
    ];

    const inherited = await orchestrator.createDiscussion(
      "30000000-0000-4000-8000-000000000002",
      {
        title: "Inherited budget",
        mode: "problem",
        language: "en",
        participants,
        facilitatorId: "20000000-0000-4000-8000-000000000002",
        maxRounds: 3
      }
    );
    expect(inherited.discussion.budget).toEqual({
      maxTotalTokens: 1_000,
      maxTotalCostMicros: 5_000,
      currency: "USD"
    });

    const overridden = await orchestrator.createDiscussion(
      state.conversations[0].id,
      {
        title: "Overridden budget",
        mode: "problem",
        language: "en",
        participants,
        facilitatorId: "20000000-0000-4000-8000-000000000002",
        maxRounds: 3,
        budget: { maxTotalTokens: 400 }
      }
    );
    expect(overridden.discussion.budget).toEqual({
      maxTotalTokens: 400,
      maxTotalCostMicros: 5_000,
      currency: "USD"
    });
  });

  it("patches the budget on a non-terminal Discussion", async () => {
    const state = createFixtureState();
    const discussion = createFixtureDiscussion({
      workspaceId: state.workspace.id,
      conversationId: state.conversations[0].id
    });
    state.discussions.push(discussion);
    const { store, orchestrator } = harness(state);

    await orchestrator.updateDiscussion(discussion.id, {
      budget: { maxTotalTokens: 999, softTotalTokens: 900 }
    });

    const persisted = await store.read((current) =>
      current.discussions.find((item) => item.id === discussion.id)!
    );
    expect(persisted.budget).toMatchObject({
      maxTotalTokens: 999,
      softTotalTokens: 900
    });
    expect(
      state.discussionInterventions.some(
        (intervention) =>
          intervention.discussionId === discussion.id &&
          intervention.kind === "budget_change"
      ) ||
      (await store.read((current) =>
        current.discussionInterventions.some(
          (intervention) =>
            intervention.discussionId === discussion.id &&
            intervention.kind === "budget_change"
        )
      ))
    ).toBe(true);
  });

  it("stops scheduling content Rounds once the soft token budget is reached", async () => {
    const state = createFixtureState();
    const discussion = draftDiscussion(state);
    discussion.maxRounds = 5;
    discussion.budget = { maxTotalTokens: 100_000, softTotalTokens: 40 };
    const { store, runs, orchestrator } = harness(state);

    await orchestrator.startDiscussion(discussion.id);
    await processLatestDiscussionRun(store, runs, discussion.id);
    await setTurnPayloads(store, discussion.id, 1, ["Position A", "Position B"]);
    await stampUsage(store, discussion.id, "budget-a1", 20);
    await orchestrator.advanceDiscussion(discussion.id);

    // Soft threshold not reached yet: a Cross-response Round starts.
    let persisted = await store.read((current) =>
      current.discussions.find((item) => item.id === discussion.id)!
    );
    expect(persisted.rounds.at(-1)).toMatchObject({
      phase: "cross_response",
      roundNumber: 2
    });

    await processLatestDiscussionRun(store, runs, discussion.id);
    await setTurnPayloads(store, discussion.id, 2, ["Cross A", "Cross B"]);
    await stampUsage(store, discussion.id, "budget-a2", 30);
    await orchestrator.advanceDiscussion(discussion.id);

    persisted = await store.read((current) =>
      current.discussions.find((item) => item.id === discussion.id)!
    );
    // used = 50 >= soft 40: no third content Round; Synthesis is queued instead.
    expect(persisted.rounds.at(-1)).toMatchObject({ phase: "synthesis" });
    expect(
      persisted.rounds.filter((round) => round.phase === "cross_response")
    ).toHaveLength(1);
    const exhausted = (persisted.events ?? []).filter(
      (event) => event.type === "discussion_budget_exhausted"
    );
    expect(exhausted).toHaveLength(1);
    expect(exhausted[0].payload).toMatchObject({
      dimension: "tokens",
      decision: "soft"
    });
  });

  it("transitions to Synthesis on hard cost exhaustion with minimum content", async () => {
    const state = createFixtureState();
    const discussion = draftDiscussion(state);
    discussion.maxRounds = 5;
    discussion.budget = {
      maxTotalCostMicros: 100_000,
      currency: "USD"
    };
    state.modelPricing.push(
      createFixtureModelPricing({ workspaceId: state.workspace.id })
    );
    const { store, runs, orchestrator } = harness(state);

    await orchestrator.startDiscussion(discussion.id);
    await processLatestDiscussionRun(store, runs, discussion.id);
    await setTurnPayloads(store, discussion.id, 1, ["Position A", "Position B"]);
    await orchestrator.advanceDiscussion(discussion.id);
    await processLatestDiscussionRun(store, runs, discussion.id);
    await setTurnPayloads(store, discussion.id, 2, ["Cross A", "Cross B"]);
    await store.update((current) => {
      current.providerAttempts.push(
        createFixtureProviderAttempt({
          id: "cost-a1",
          workspaceId: current.workspace.id,
          discussionId: discussion.id,
          purpose: "discussion_turn",
          usage: {
            inputTokens: 100_000,
            outputTokens: 0,
            totalTokens: 100_000,
            source: "provider"
          },
          pricingId: "pricing-openai-test",
          estimatedCostMicros: 150_000
        })
      );
    });

    await orchestrator.advanceDiscussion(discussion.id);

    const persisted = await store.read((current) =>
      current.discussions.find((item) => item.id === discussion.id)!
    );
    expect(persisted.rounds.at(-1)).toMatchObject({ phase: "synthesis" });
    const exhausted = (persisted.events ?? []).filter(
      (event) => event.type === "discussion_budget_exhausted"
    );
    expect(exhausted[0].payload).toMatchObject({
      dimension: "cost",
      decision: "hard"
    });
  });

  it("transitions to Synthesis after a Run is interrupted by the hard budget mid-round", async () => {
    const state = createFixtureState();
    const discussion = draftDiscussion(state);
    discussion.maxRounds = 5;
    const { store, runs, orchestrator } = harness(state);

    await orchestrator.startDiscussion(discussion.id);
    await processLatestDiscussionRun(store, runs, discussion.id);
    await setTurnPayloads(store, discussion.id, 1, ["Position A", "Position B"]);
    await orchestrator.advanceDiscussion(discussion.id);
    await processLatestDiscussionRun(store, runs, discussion.id);
    await setTurnPayloads(store, discussion.id, 2, ["Cross A", "Cross B"]);
    await orchestrator.advanceDiscussion(discussion.id);

    // Round 3 is queued; now the budget becomes hard-exhausted.
    await store.update((current) => {
      const currentDiscussion = current.discussions.find(
        (item) => item.id === discussion.id
      )!;
      currentDiscussion.budget = { maxTotalTokens: 10 };
      current.providerAttempts.push(
        createFixtureProviderAttempt({
          id: "budget-hard-1",
          workspaceId: current.workspace.id,
          discussionId: discussion.id,
          purpose: "discussion_turn",
          usage: {
            inputTokens: 5,
            outputTokens: 0,
            totalTokens: 5,
            source: "provider"
          }
        })
      );
    });
    await processLatestDiscussionRun(store, runs, discussion.id);

    const interruptedRun = await store.read((current) =>
      current.runs
        .filter((run) => run.discussionId === discussion.id)
        .at(-1)
    );
    expect(interruptedRun).toMatchObject({
      status: "interrupted",
      errorCode: "discussion_budget_exhausted"
    });

    await orchestrator.advanceDiscussion(discussion.id);

    const persisted = await store.read((current) =>
      current.discussions.find((item) => item.id === discussion.id)!
    );
    expect(persisted.status).toBe("running");
    expect(persisted.rounds.at(-1)).toMatchObject({ phase: "synthesis" });
    expect(
      (persisted.events ?? []).some(
        (event) =>
          event.type === "discussion_budget_exhausted" &&
          event.payload.decision === "hard"
      )
    ).toBe(true);
  });

  it("interrupts with a stable reason when the budget dies before minimum content", async () => {
    const state = createFixtureState();
    const discussion = draftDiscussion(state);
    discussion.maxRounds = 5;
    discussion.budget = { maxTotalTokens: 10, softTotalTokens: 5 };
    const { store, runs, orchestrator } = harness(state);

    await orchestrator.startDiscussion(discussion.id);
    await processLatestDiscussionRun(store, runs, discussion.id);
    await setTurnPayloads(store, discussion.id, 1, ["Position A", "Position B"]);
    await stampUsage(store, discussion.id, "budget-a1", 50);

    await orchestrator.advanceDiscussion(discussion.id);

    const persisted = await store.read((current) =>
      current.discussions.find((item) => item.id === discussion.id)!
    );
    expect(persisted.status).toBe("interrupted");
    expect(
      (persisted.events ?? []).some(
        (event) => event.type === "discussion_budget_exhausted"
      )
    ).toBe(true);
    expect(
      (persisted.events ?? []).some(
        (event) =>
          event.type === "discussion_interrupted" &&
          event.payload.code === "discussion_insufficient_turns"
      )
    ).toBe(true);
  });

  it("cancels a budgeted Discussion without recording budget exhaustion", async () => {
    const { store, runs, orchestrator, discussion } =
      await createRunningDiscussion();
    await store.update((current) => {
      const persisted = current.discussions.find(
        (item) => item.id === discussion.id
      )!;
      persisted.budget = { maxTotalTokens: 100_000, softTotalTokens: 5 };
    });

    const cancelled = await orchestrator.cancelDiscussion(discussion.id, {
      reason: "No longer needed"
    });

    expect(cancelled.status).toBe("cancelled");
    const persisted = await store.read((current) => ({
      discussion: current.discussions.find(
        (item) => item.id === discussion.id
      )!,
      runs: current.runs.filter((run) => run.discussionId === discussion.id)
    }));
    expect(persisted.runs.every((run) => run.status === "cancelled")).toBe(
      true
    );
    expect(
      (persisted.discussion.events ?? []).some(
        (event) => event.type === "discussion_budget_exhausted"
      )
    ).toBe(false);
    expect(runs).toBeDefined();
  });

  it("extends a reviewed Discussion and raises its budget", async () => {
    const state = createFixtureState();
    const discussion = createFixtureDiscussion({
      workspaceId: state.workspace.id,
      conversationId: state.conversations[0].id
    });
    discussion.budget = { maxTotalTokens: 100 };
    state.discussions.push(discussion);
    const { store, orchestrator } = harness(state);

    await orchestrator.extendDiscussion(discussion.id, {
      budget: { maxTotalTokens: 100_000 }
    });

    const persisted = await store.read((current) => ({
      discussion: current.discussions.find(
        (item) => item.id === discussion.id
      )!,
      interventions: current.discussionInterventions.filter(
        (item) => item.discussionId === discussion.id
      )
    }));
    expect(persisted.discussion.status).toBe("running");
    expect(persisted.discussion.budget).toMatchObject({
      maxTotalTokens: 100_000
    });
    expect(persisted.discussion.rounds.at(-1)).toMatchObject({
      phase: "cross_response",
      status: "running"
    });
    expect(
      persisted.interventions.some(
        (item) => item.kind === "budget_change" && item.status === "applied"
      )
    ).toBe(true);
  });
});

async function processLatestDiscussionRun(
  store: MemoryStore,
  runs: ConversationRunService,
  discussionId: string
): Promise<void> {
  const runId = await store.read(
    (state) =>
      state.runs.find(
        (run) =>
          run.discussionId === discussionId &&
          run.status === "queued"
      )!.id
  );
  await runs.processRun(runId);
}

async function setTurnPayloads(
  store: MemoryStore,
  discussionId: string,
  roundNumber: number,
  summaries: string[]
): Promise<void> {
  await store.update((state) => {
    const discussion = state.discussions.find(
      (item) => item.id === discussionId
    )!;
    const round = discussion.rounds.find(
      (item) => item.roundNumber === roundNumber
    )!;
    round.turns.forEach((turn, index) => {
      const payload: DiscussionTurnPayload = {
        summary: summaries[index] ?? summaries[0],
        claims: [
          {
            statement: summaries[index] ?? summaries[0],
            confidence: "medium"
          }
        ],
        assumptions: [],
        risks: [],
        openQuestions: []
      };
      turn.payload = payload;
    });
  });
}
