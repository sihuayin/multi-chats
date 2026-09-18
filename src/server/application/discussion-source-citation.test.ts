import { describe, expect, it } from "vitest";
import { FakeModelGateway } from "@/server/adapters/model/model-gateway";
import { ConversationRunService } from "@/server/application/conversation-run-service";
import { DiscussionOrchestrator } from "@/server/application/discussion-orchestrator";
import { chunkSource } from "@/server/application/source-chunking";
import { AesCredentialCipher } from "@/server/security/credential-cipher";
import { MemoryStore } from "@/server/store/memory-store";
import {
  createFixtureDiscussion,
  createFixtureState,
  TEST_KEY
} from "@/server/test-support/fixtures";
import type { Source } from "@/server/domain/types";

async function driveToReview(
  store: MemoryStore,
  runs: ConversationRunService,
  orchestrator: DiscussionOrchestrator,
  discussionId: string
): Promise<void> {
  await orchestrator.startDiscussion(discussionId);
  for (let step = 0; step < 30; step += 1) {
    await orchestrator.advanceDiscussion(discussionId);
    const status = await store.read(
      (state) =>
        state.discussions.find((item) => item.id === discussionId)?.status
    );
    if (
      status === "review" ||
      status === "completed" ||
      status === "interrupted" ||
      status === "cancelled"
    ) {
      return;
    }
    const queued = await store.read((state) =>
      state.runs.find(
        (run) =>
          run.discussionId === discussionId && run.status === "queued"
      )
    );
    if (!queued) return;
    await runs.processRun(queued.id);
  }
}

describe("Source citation end to end", () => {
  it("produces a grounded Brief from an ingested Source chunk", async () => {
    const state = createFixtureState();
    const discussion = createFixtureDiscussion({
      workspaceId: state.workspace.id,
      conversationId: state.conversations[0].id
    });
    discussion.status = "draft";
    discussion.currentRound = 0;
    discussion.maxRounds = 3;
    discussion.rounds = [];
    const source: Source = {
      id: "source-ingested",
      workspaceId: state.workspace.id,
      title: "notes.md",
      kind: "file",
      location: "notes.md",
      status: "ready",
      chunkCount: 1,
      contentHash: "ingested-hash",
      createdAt: state.workspace.createdAt,
      updatedAt: state.workspace.updatedAt
    };
    const chunks = chunkSource({
      sourceId: source.id,
      workspaceId: state.workspace.id,
      text: "The stored passage participants must cite.",
      now: state.workspace.createdAt
    });
    state.sources.push(source);
    state.chunks.push(...chunks);
    discussion.sourceIds = [source.id];
    state.discussions.push(discussion);

    const store = new MemoryStore(state);
    const runs = new ConversationRunService(
      store,
      new AesCredentialCipher(TEST_KEY),
      new FakeModelGateway(0)
    );
    const orchestrator = new DiscussionOrchestrator(store, runs);

    await driveToReview(store, runs, orchestrator, discussion.id);

    const result = await store.read((current) => {
      const finished = current.discussions.find(
        (item) => item.id === discussion.id
      )!;
      const brief = current.artifacts.find(
        (artifact) => artifact.id === finished.latestBriefArtifactId
      );
      return {
        status: finished.status,
        brief: brief ? JSON.parse(brief.content) : undefined,
        evidenceReferences: current.evidenceReferences.filter(
          (reference) => reference.sourceId === chunks[0].id
        )
      };
    });

    expect(result.status).toBe("review");
    expect(result.brief).toBeDefined();
    expect(result.brief.facts[0].evidenceIds).toEqual([
      `external:${chunks[0].id}`
    ]);
    expect(result.evidenceReferences).toHaveLength(1);
    expect(result.evidenceReferences[0]).toMatchObject({
      kind: "external_source",
      sourceId: chunks[0].id,
      locator: "notes.md"
    });
  });
});
