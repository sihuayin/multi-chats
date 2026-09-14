import { describe, expect, it } from "vitest";
import { ConversationRunService } from "@/server/application/conversation-run-service";
import { createDiscussionBriefRevision } from "@/server/application/discussion-brief";
import {
  DiscussionOrchestrator,
  hasDiscussionConverged
} from "@/server/application/discussion-orchestrator";
import { AesCredentialCipher } from "@/server/security/credential-cipher";
import { MemoryStore } from "@/server/store/memory-store";
import {
  createFixtureDiscussion,
  createFixtureBrief,
  createFixtureState,
  discussionModelGateway,
  RecordingModelGateway,
  TEST_KEY
} from "@/server/test-support/fixtures";
import type { DiscussionTurnPayload } from "@/server/domain/types";
import type { ModelGateway } from "@/server/application/model-gateway";

describe("DiscussionOrchestrator", () => {
  it("detects convergence with deterministic Unicode and case normalization", () => {
    const base = createFixtureDiscussion();
    const first = structuredClone(base.rounds[0]);
    first.id = "cross-1";
    first.phase = "cross_response";
    first.turns[0].payload = {
      summary: "first",
      claims: [{ statement: "  Release Risk  ", confidence: "medium" }],
      assumptions: ["Same Assumption"],
      risks: ["Straße"],
      openQuestions: [],
      disagreements: []
    };
    const second = structuredClone(base.rounds[0]);
    second.id = "cross-2";
    second.phase = "cross_response";
    second.turns[0].payload = {
      summary: "second",
      claims: [
        { statement: "ｒｅｌｅａｓｅ risk", confidence: "medium" }
      ],
      assumptions: ["same assumption"],
      risks: ["STRASSE"],
      openQuestions: [],
      disagreements: []
    };

    expect(hasDiscussionConverged([first, second])).toBe(true);
    second.turns[0].payload.risks = ["New dependency risk"];
    expect(hasDiscussionConverged([first, second])).toBe(false);
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
      promptProfileVersion: "discussion-prompts.v1",
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
      schemaVersion: 1,
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
      promptProfileVersion: "discussion-prompts.v1"
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
      schemaVersion: 1,
      revision: 2,
      previousArtifactId: "brief-context"
    });
    expect(JSON.parse(briefArtifact!.content)).toMatchObject({
      promptProfileVersion: "discussion-prompts.v1"
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
