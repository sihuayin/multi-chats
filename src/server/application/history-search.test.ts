import { describe, expect, it } from "vitest";
import {
  SEARCH_HISTORY_MAX_RESULT_CODEPOINTS,
  searchHistory
} from "@/server/application/history-search";
import { rankHistory } from "@/server/application/history-retrieval";
import {
  createFixtureDiscussion,
  createFixtureState
} from "@/server/test-support/fixtures";
import type { AppState } from "@/server/domain/types";

const NOW = "2026-01-01T00:00:00.000Z";
const HERE = "30000000-0000-4000-8000-000000000001";
const ELSEWHERE = "30000000-0000-4000-8000-000000000002";

function conversation(
  state: AppState,
  id: string,
  title: string,
  retrievalExcluded = false
): void {
  state.conversations.push({
    id,
    workspaceId: state.workspace.id,
    title,
    memberIds: [],
    retrievalExcluded,
    createdAt: NOW,
    updatedAt: NOW
  });
}

function historyMessage(
  state: AppState,
  id: string,
  conversationId: string,
  content: string,
  overrides: Record<string, unknown> = {}
): void {
  state.messages.push({
    id,
    workspaceId: state.workspace.id,
    conversationId,
    authorType: "employee",
    authorId: state.employees[0].id,
    content,
    status: "complete",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides
  } as AppState["messages"][number]);
}

function historyTask(
  state: AppState,
  id: string,
  conversationId: string,
  title: string,
  goal: string,
  status: string
): void {
  state.tasks.push({
    id,
    workspaceId: state.workspace.id,
    conversationId,
    title,
    goal,
    assigneeIds: [],
    status,
    history: [],
    createdAt: NOW,
    updatedAt: NOW
  } as AppState["tasks"][number]);
}

function historyArtifact(
  state: AppState,
  id: string,
  ownerType: "task" | "discussion",
  ownerId: string,
  name: string,
  content: string,
  type: "text" | "markdown" | "json" = "text",
  createdAt: string = NOW
): void {
  state.artifacts.push({
    id,
    workspaceId: state.workspace.id,
    ownerType,
    ownerId,
    type,
    name,
    content,
    createdAt,
    updatedAt: createdAt
  });
}

function seededState(): AppState {
  const state = createFixtureState();
  conversation(state, ELSEWHERE, "Payments redesign");
  historyMessage(
    state,
    "message-there",
    ELSEWHERE,
    "The persistence model is append-only; nothing is rewritten in place."
  );
  historyMessage(state, "message-here", HERE, "Noted the persistence plan.");
  historyMessage(
    state,
    "message-user",
    ELSEWHERE,
    "Why does the persistence model matter?",
    { authorType: "user", authorId: "user" }
  );
  historyTask(
    state,
    "task-1",
    HERE,
    "Decide persistence",
    "Settle the persistence model.",
    "in_progress"
  );
  historyArtifact(
    state,
    "artifact-notes",
    "task",
    "task-1",
    "Persistence notes",
    "Persistence model notes attached to the task."
  );
  return state;
}

describe("searchHistory", () => {
  it("returns delimited text: header, alias on its own line, provenance, content", () => {
    const state = seededState();
    const outcome = searchHistory(state, HERE, "persistence model");

    expect(outcome.status).toBe("success");
    expect(outcome.content).toContain(
      'search_history — query: "persistence model"'
    );
    expect(outcome.content).toContain(
      `Returned ${outcome.returnedItemIds.length} of ${outcome.candidateCount} searchable history items.`
    );
    // The citation instruction names the three prefixes.
    expect(outcome.content).toContain("message:, task:, or artifact:");

    // A Message contributes content verbatim, with author, Conversation
    // title, and ISO date — never a full timestamp.
    expect(outcome.content).toContain(
      `message:message-there\nMessage — Alice, Payments redesign, 2026-01-01\nThe persistence model is append-only; nothing is rewritten in place.`
    );
    // A user-authored Message names the user.
    expect(outcome.content).toContain(
      "message:message-user\nMessage — User, Payments redesign, 2026-01-01"
    );
    // A Task contributes title, goal and status — status on its provenance
    // line.
    expect(outcome.content).toContain(
      "task:task-1\nTask — in_progress, Launch planning\nDecide persistence\nSettle the persistence model."
    );
    // An Artifact contributes content verbatim under its name.
    expect(outcome.content).toContain(
      "artifact:artifact-notes\nArtifact — Persistence notes, Launch planning\nPersistence model notes attached to the task."
    );
  });

  it("returns items in rank order and records returnedItemIds as the ranking", () => {
    const state = seededState();
    const query = "persistence model";
    const outcome = searchHistory(state, HERE, query);

    const corpus = [
      ...state.messages.map((message) => ({
        id: message.id,
        content: message.content,
        contentFormat: "text" as const,
        createdAt: message.createdAt
      })),
      ...state.tasks.map((task) => ({
        id: task.id,
        content: `${task.title}\n${task.goal}\n${task.status}`,
        contentFormat: "text" as const,
        createdAt: task.createdAt
      })),
      ...state.artifacts.map((artifact) => ({
        id: artifact.id,
        content: artifact.content,
        contentFormat: "text" as const,
        createdAt: artifact.createdAt
      }))
    ];
    const expected = rankHistory(corpus, query)
      .map((item) => item.id)
      .slice(0, outcome.returnedItemIds.length);
    expect(outcome.returnedItemIds).toEqual(expected);
    // Alias lines appear in the same order as the recorded ids.
    const aliasPositions = outcome.returnedItemIds.map((id) =>
      outcome.content.search(
        new RegExp(`^(message|task|artifact):${id}$`, "m")
      )
    );
    expect(aliasPositions).toEqual(
      [...aliasPositions].sort((left, right) => left - right)
    );
  });

  it("delivers a Brief as raw JSON, unprojected", () => {
    const state = seededState();
    const brief = JSON.stringify({
      schemaVersion: 2,
      title: "Persistence decision",
      facts: [
        { statement: "Append-only.", kind: "fact", evidenceIds: ["x"] }
      ]
    });
    state.discussions.push(
      createFixtureDiscussion({
        id: "discussion-1",
        workspaceId: state.workspace.id,
        conversationId: ELSEWHERE
      })
    );
    historyArtifact(
      state,
      "artifact-brief",
      "discussion",
      "discussion-1",
      "Discussion Brief",
      brief,
      "json"
    );

    const outcome = searchHistory(state, HERE, "persistence decision");
    expect(outcome.content).toContain(
      `artifact:artifact-brief\nArtifact — Discussion Brief, Payments redesign\n${brief}`
    );
  });

  it("returns a lone over-cap item whole, without a truncation notice", () => {
    const state = seededState();
    // Artifact content has no cap anywhere, so a Brief-sized record can
    // exceed the result cap alone. Excluding it whole could produce an
    // empty result, which the never-empty rule forbids.
    const huge = `quarantine ledger ${"zebrafish ".repeat(5_000)}`;
    historyArtifact(
      state,
      "artifact-huge",
      "task",
      "task-1",
      "Huge record",
      huge
    );

    const outcome = searchHistory(state, HERE, "quarantine ledger");
    expect(outcome.returnedItemIds).toEqual(["artifact-huge"]);
    expect(outcome.content).toContain(huge);
    expect([...outcome.content].length).toBeGreaterThan(
      SEARCH_HISTORY_MAX_RESULT_CODEPOINTS
    );
    // The overshoot is not a truncation: nothing matching was dropped.
    expect(outcome.truncated).toBe(false);
    expect(outcome.content).not.toContain("Truncated:");
  });

  it("returns the first item whole over the cap and counts the tail it dropped", () => {
    const state = seededState();
    const hugeOlder = `quarantine ledger ${"zebrafish ".repeat(5_000)} older`;
    const hugeNewer = `quarantine ledger ${"zebrafish ".repeat(5_000)} newer`;
    historyArtifact(
      state,
      "artifact-huge-newer",
      "task",
      "task-1",
      "Newer huge",
      hugeNewer,
      "text",
      "2026-01-02T00:00:00.000Z"
    );
    historyArtifact(
      state,
      "artifact-huge-older",
      "task",
      "task-1",
      "Older huge",
      hugeOlder,
      "text",
      NOW
    );

    const outcome = searchHistory(state, HERE, "quarantine ledger");
    // Equal scores tie-break on createdAt ascending: the older item leads,
    // is returned whole although it alone exceeds the cap, and the newer one
    // is counted — never named.
    expect(outcome.returnedItemIds).toEqual(["artifact-huge-older"]);
    expect(outcome.content).toContain(hugeOlder);
    expect(outcome.truncated).toBe(true);
    expect(outcome.content).toContain(
      "Truncated: 1 further matching history items were not returned; this result reached its size limit."
    );
    expect(outcome.content).not.toContain("artifact-huge-newer");
  });

  it("stops at an item boundary and counts the dropped items without naming them", () => {
    const state = seededState();
    // Many matching messages, each a few thousand code points: the tail
    // cannot fit under the cap.
    for (let index = 0; index < 25; index += 1) {
      historyMessage(
        state,
        `message-bulk-${index}`,
        ELSEWHERE,
        `Persistence note ${index}. ${"detail ".repeat(500)}`
      );
    }

    const outcome = searchHistory(state, HERE, "persistence");
    expect(outcome.truncated).toBe(true);
    expect([...outcome.content].length).toBeLessThanOrEqual(
      SEARCH_HISTORY_MAX_RESULT_CODEPOINTS +
        // the first-item-whole exception cannot trigger here: bulk messages
        // are far smaller than the cap
        0
    );
    const dropped = countDropped(outcome);
    expect(dropped).toBeGreaterThan(0);
    expect(outcome.content).toContain(
      `Truncated: ${dropped.toLocaleString("en-US")} further matching history items were not returned`
    );
    // Never names the dropped aliases, never a breakdown.
    for (const item of state.messages) {
      if (outcome.returnedItemIds.includes(item.id)) continue;
      expect(outcome.content).not.toContain(`message:${item.id}`);
    }
  });

  it("treats no match as a normal, non-empty result", () => {
    const state = seededState();
    const outcome = searchHistory(state, HERE, "blockchain synergies");
    expect(outcome.status).toBe("success");
    expect(outcome.content).toBe(
      'No history items matched "blockchain synergies".'
    );
    expect(outcome.returnedItemIds).toEqual([]);
    expect(outcome.truncated).toBe(false);
    expect(outcome.candidateCount).toBeGreaterThan(0);
  });

  it("tells the model a Workspace with no history has nothing to search", () => {
    const state = createFixtureState();
    const outcome = searchHistory(state, HERE, "anything");
    expect(outcome.content).toBe("This Workspace has no searchable history.");
    expect(outcome.candidateCount).toBe(0);
    expect(outcome.returnedItemIds).toEqual([]);
  });

  it("names the excluded count only when the result is empty", () => {
    const state = seededState();
    conversation(state, "30000000-0000-4000-8000-000000000003", "Private", true);
    conversation(state, "30000000-0000-4000-8000-000000000004", "Secret", true);

    const empty = searchHistory(state, HERE, "blockchain synergies");
    expect(empty.content).toBe(
      'No history items matched "blockchain synergies".\n2 Conversations are excluded from history search.'
    );

    const nonEmpty = searchHistory(state, HERE, "persistence");
    expect(nonEmpty.content).not.toContain("excluded from history search");
  });

  it("carries exactly the settled details keys, returnedItemIds in rank order", () => {
    const state = seededState();
    const outcome = searchHistory(state, HERE, "persistence");
    expect(Object.keys(outcome).sort()).toEqual(
      [
        "candidateCount",
        "content",
        "query",
        "returnedItemIds",
        "status",
        "truncated"
      ].sort()
    );
    expect(outcome.query).toBe("persistence");
  });

  it("bounds the tail by the live byte ceiling while the first item stays whole", () => {
    const state = createFixtureState();
    conversation(state, ELSEWHERE, "Archive");
    // CJK content: ~1,010 code points but ~3,070 UTF-8 bytes per item, so
    // the byte ceiling bites long before the code-point cap — the two
    // ceilings are compared in their own units, never converted.
    const ids: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const id = `message-cjk-${index}`;
      ids.push(id);
      historyMessage(
        state,
        id,
        ELSEWHERE,
        `persistence 档案${"内容".repeat(499)}`
      );
    }

    const unbounded = searchHistory(state, HERE, "persistence");
    expect(unbounded.returnedItemIds).toEqual(ids);
    expect(unbounded.truncated).toBe(false);

    const bounded = searchHistory(state, HERE, "persistence", {
      byteCeiling: 7_000
    });
    expect(bounded.returnedItemIds).toEqual(ids.slice(0, 2));
    expect(bounded.truncated).toBe(true);
    expect(bounded.content).toContain(
      "Truncated: 1 further matching history items were not returned; this result reached its size limit."
    );

    // A ceiling of zero still returns the first item whole — the accepted
    // #193 residue — and counts the rest.
    const zero = searchHistory(state, HERE, "persistence", {
      byteCeiling: 0
    });
    expect(zero.returnedItemIds).toEqual(ids.slice(0, 1));
    expect(zero.truncated).toBe(true);
    expect(zero.content).toContain(ids[0]);
  });

  it("returns a normal result for an empty query rather than throwing", () => {
    const state = seededState();
    expect(() => searchHistory(state, HERE, "")).not.toThrow();
    const outcome = searchHistory(state, HERE, "");
    expect(outcome.content).toBe('No history items matched "".');
  });
});

function countDropped(outcome: {
  returnedItemIds: string[];
  candidateCount: number;
  content: string;
}): number {
  const match = outcome.content.match(/Truncated: ([\d,]+) further/);
  return match ? Number(match[1].replace(/,/g, "")) : -1;
}
