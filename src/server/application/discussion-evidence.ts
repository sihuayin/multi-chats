import { createHash } from "node:crypto";
import type {
  AppState,
  Discussion,
  DiscussionTurnPayload,
  EvidenceReference,
  EvidenceReferenceKind
} from "@/server/domain/types";
import type { DiscussionBriefV2 } from "@/server/application/discussion-brief";
import { attachedReadyChunks } from "@/server/application/source-retrieval";

export const DISCUSSION_EVIDENCE_INVALID_CODE =
  "discussion_evidence_invalid";

export type AvailableEvidence = {
  id: string;
  kind: EvidenceReferenceKind;
  label: string;
  locator?: string;
};

export class DiscussionEvidenceError extends Error {
  readonly code = DISCUSSION_EVIDENCE_INVALID_CODE;

  constructor(
    message: string,
    readonly details: {
      evidenceId?: string;
      claim?: string;
      reason: "missing" | "unknown" | "out_of_scope";
    }
  ) {
    super(message);
    this.name = "DiscussionEvidenceError";
  }
}

export function evidenceAlias(
  kind: EvidenceReferenceKind,
  sourceId: string
): string {
  return `${kind}:${sourceId}`;
}

export function evidenceReferenceId(alias: string): string {
  return `evidence-${createHash("sha256")
    .update(alias)
    .digest("hex")
    .slice(0, 32)}`;
}

export type EvidenceScopeTurn = {
  id: string;
  content?: string;
  payload?: DiscussionTurnPayload;
};

/**
 * What may be cited, independent of which surface is citing. Callers build
 * the scope; the resolver judges aliases against it and against nothing
 * else — which chunks count as citable is data here, not a branch inside
 * the resolver.
 */
export type EvidenceScope = {
  conversationId: string;
  /**
   * Set by a Discussion scope, absent in a Conversation scope, and the one
   * place the resolver distinguishes the two surfaces: a Discussion cites
   * only its own Messages and only its own Discussion's Artifacts, while a
   * Conversation's native tier is everything its conversationId owns.
   */
  discussionId?: string;
  /**
   * History items from elsewhere that are citable anyway: what the Run
   * being resolved retrieved, ∪ what one of this Conversation's Messages
   * has already cited. One set across kinds — ids are unique across kinds
   * and the alias prefix already names the kind. No existence filter: the
   * citable set is a rule, not a snapshot.
   */
  citableIds?: ReadonlySet<string>;
  /** Every turn citable as `turn:<id>`. */
  turns: readonly EvidenceScopeTurn[];
  /** Run ids whose `tool_completed` events are citable as `tool_result:<eventId>`. */
  runIds: readonly string[];
  /**
   * Source ids whose chunks (and the Sources themselves) are citable as
   * `external:<id>`. Raw attachment data, deliberately NOT filtered by
   * ready/superseded/tombstone state: a confirmed citation must stay
   * resolvable after its Source is refreshed or deleted (see the
   * evidence-invariance test in source-service.test.ts). The evidence
   * catalog (`availableEvidence`) legitimately filters by readiness —
   * offering and citability are different questions; do not unify them.
   */
  citableSourceIds: ReadonlySet<string>;
  /**
   * Chunk-level citability, supplied by callers whose citable set is a set
   * of chunks rather than of Sources (a Conversation: chunks cited by its
   * Messages ∪ chunks retrieved by the Run being resolved). When present,
   * `external:<chunkId>` aliases are judged by chunk-id membership here
   * instead of by Source membership in `citableSourceIds`. Still data,
   * still one implementation of the alias kind.
   */
  citableChunkIds?: ReadonlySet<string>;
};

function discussionEvidenceScope(
  state: AppState,
  discussion: Discussion
): EvidenceScope {
  return {
    conversationId: discussion.conversationId,
    discussionId: discussion.id,
    turns: discussion.rounds.flatMap((round) => round.turns),
    runIds: state.runs
      .filter((run) => run.discussionId === discussion.id)
      .map((run) => run.id),
    citableSourceIds: new Set(discussion.sourceIds)
  };
}

/**
 * Judge one evidence alias against a caller-supplied scope. Every alias
 * kind is judged here exactly once; surfaces never re-implement a branch.
 */
export function resolveEvidence(
  state: AppState,
  scope: EvidenceScope,
  alias: string,
  now: string
): { reference: EvidenceReference; label: string } {
  const separator = alias.indexOf(":");
  const prefix = separator > 0 ? alias.slice(0, separator) : "";
  const sourceId = separator > 0 ? alias.slice(separator + 1) : "";
  const isExternalUrl =
    prefix === "external" && /^https?:\/\//.test(sourceId);
  if (
    ![
      "message",
      "turn",
      "task",
      "artifact",
      "tool_result",
      "external"
    ].includes(prefix)
  ) {
    throw new DiscussionEvidenceError(
      `Evidence reference ${alias} is invalid`,
      { evidenceId: alias, reason: "unknown" }
    );
  }

  let kind = prefix as EvidenceReferenceKind;
  let label = sourceId;
  let locator: string | undefined;
  let excerptHash: string | undefined;
  // History-item references carry the originating Conversation as locator
  // and no excerptHash: Messages were already content-immutable, so the
  // failure mode excerptHash exists for (a Source refresh rewriting Chunk
  // text) does not exist here, and the locator is what makes a dangling
  // cross-Conversation reference sayable.
  let omitExcerptHash = false;
  if (prefix === "message") {
    const message = state.messages.find((item) => item.id === sourceId);
    // One uniform native predicate — the target belongs to the scope's
    // Conversation — with the Discussion's narrower rule layered on only
    // when the scope is a Discussion's. A Conversation has no outside, so
    // its own Messages are all citable; a Discussion still cites only its
    // own.
    const belongs =
      message !== undefined &&
      (scope.citableIds?.has(message.id) === true ||
        (message.conversationId === scope.conversationId &&
          (scope.discussionId === undefined ||
            message.discussionId === scope.discussionId)));
    if (!belongs) {
      throw new DiscussionEvidenceError(
        `Evidence reference ${alias} is outside the Discussion`,
        { evidenceId: alias, reason: "out_of_scope" }
      );
    }
    label = message!.content.slice(0, 160);
    locator = message!.conversationId;
    omitExcerptHash = true;
  } else if (prefix === "turn") {
    const turn = scope.turns.find((item) => item.id === sourceId);
    if (!turn) {
      throw new DiscussionEvidenceError(
        `Evidence reference ${alias} is outside the Discussion`,
        { evidenceId: alias, reason: "out_of_scope" }
      );
    }
    label = turn.payload?.summary ?? turn.content?.slice(0, 160) ?? sourceId;
  } else if (prefix === "task") {
    const task = state.tasks.find((item) => item.id === sourceId);
    if (
      !task ||
      (task.conversationId !== scope.conversationId &&
        scope.citableIds?.has(task.id) !== true)
    ) {
      throw new DiscussionEvidenceError(
        `Evidence reference ${alias} is outside the Discussion`,
        { evidenceId: alias, reason: "out_of_scope" }
      );
    }
    label = task.title;
    locator = task.conversationId;
    omitExcerptHash = true;
  } else if (prefix === "artifact") {
    const artifact = state.artifacts.find((item) => item.id === sourceId);
    const relatedTaskIds = new Set(
      state.tasks
        .filter((task) => task.conversationId === scope.conversationId)
        .map((task) => task.id)
    );
    const ownedByTaskHere =
      artifact !== undefined &&
      artifact.ownerType === "task" &&
      relatedTaskIds.has(artifact.ownerId);
    const ownedByDiscussionHere =
      artifact !== undefined &&
      artifact.ownerType === "discussion" &&
      (scope.discussionId !== undefined
        ? // A Discussion cites only its own Brief — unchanged.
          artifact.ownerId === scope.discussionId
        : // A Conversation natively owns the Artifacts of its Discussions.
          state.discussions.some(
            (discussion) =>
              discussion.id === artifact.ownerId &&
              discussion.conversationId === scope.conversationId
          ));
    if (
      !artifact ||
      (!(ownedByTaskHere || ownedByDiscussionHere) &&
        scope.citableIds?.has(artifact.id) !== true)
    ) {
      throw new DiscussionEvidenceError(
        `Evidence reference ${alias} is outside the Discussion`,
        { evidenceId: alias, reason: "out_of_scope" }
      );
    }
    label = artifact.name;
    locator =
      artifact.ownerType === "task"
        ? state.tasks.find((task) => task.id === artifact.ownerId)
            ?.conversationId
        : state.discussions.find(
            (discussion) => discussion.id === artifact.ownerId
          )?.conversationId;
    omitExcerptHash = true;
  } else if (prefix === "tool_result") {
    const event = state.runEvents.find(
      (item) => item.id === sourceId && item.type === "tool_completed"
    );
    if (!event || !scope.runIds.includes(event.runId)) {
      throw new DiscussionEvidenceError(
        `Evidence reference ${alias} is outside the Discussion`,
        { evidenceId: alias, reason: "out_of_scope" }
      );
    }
    label = String(event.payload.toolName ?? sourceId);
  } else if (prefix === "external") {
    kind = "external_source";
    if (isExternalUrl) {
      label = sourceId;
      locator = sourceId;
    } else {
      // Ignoring `chunk.superseded` and `source.deletedAt` here is
      // deliberate: resolvability outlives citability so confirmed Briefs
      // keep resolving after a Source refresh or tombstone, and the delete
      // path depends on it. Citability of NEW claims is the scope's job
      // (citableSourceIds), supplied by the caller.
      const chunk = state.chunks.find((item) => item.id === sourceId);
      if (chunk) {
        const source = state.sources.find(
          (item) => item.id === chunk.sourceId
        );
        const citable =
          scope.citableChunkIds !== undefined
            ? scope.citableChunkIds.has(chunk.id)
            : scope.citableSourceIds.has(source?.id ?? "");
        if (!source || !citable) {
          throw new DiscussionEvidenceError(
            `Evidence reference ${alias} is outside the Discussion`,
            { evidenceId: alias, reason: "out_of_scope" }
          );
        }
        label = chunk.content.slice(0, 160);
        locator = source.location;
        excerptHash = chunk.contentHash;
      } else {
        const source = state.sources.find((item) => item.id === sourceId);
        if (!source || !scope.citableSourceIds.has(source.id)) {
          throw new DiscussionEvidenceError(
            `Evidence reference ${alias} is outside the Discussion`,
            { evidenceId: alias, reason: "out_of_scope" }
          );
        }
        label = source.title;
        locator = source.location;
      }
    }
  }

  return {
    reference: {
      id: evidenceReferenceId(alias),
      workspaceId: state.workspace.id,
      kind,
      sourceId,
      ...(locator !== undefined ? { locator } : {}),
      ...(omitExcerptHash
        ? {}
        : {
            excerptHash:
              excerptHash ?? createHash("sha256").update(label).digest("hex")
          }),
      retrievedAt: now,
      createdAt: now
    },
    label
  };
}

function positionFactEvidenceIds(discussion: Discussion): Set<string> {
  return new Set(
    discussion.rounds
      .filter((round) => round.phase === "positions")
      .flatMap((round) => round.turns)
      .filter((turn) => turn.status === "completed" && turn.payload)
      .flatMap((turn) => turn.payload?.claims ?? [])
      .filter(
        (claim) =>
          claim.kind === "fact" &&
          (claim.evidenceIds?.length ?? 0) > 0
      )
      .flatMap((claim) => claim.evidenceIds ?? [])
  );
}

function hasPositionGrounding(
  discussion: Discussion,
  alias: string,
  positionEvidenceIds = positionFactEvidenceIds(discussion),
  visited = new Set<string>()
): boolean {
  if (positionEvidenceIds.has(alias)) return true;
  if (!alias.startsWith("turn:") || visited.has(alias)) return false;
  visited.add(alias);
  const turn = discussion.rounds
    .flatMap((round) => round.turns)
    .find((item) => item.id === alias.slice("turn:".length));
  if (!turn?.payload) return false;
  return turn.payload.claims
    .filter((claim) => claim.kind === "fact")
    .flatMap((claim) => claim.evidenceIds ?? [])
    .some((evidenceId) =>
      hasPositionGrounding(
        discussion,
        evidenceId,
        positionEvidenceIds,
        visited
      )
    );
}

export function availableEvidence(
  state: AppState,
  discussion: Discussion
): AvailableEvidence[] {
  const entries: AvailableEvidence[] = [];
  for (const message of state.messages.filter(
    (item) =>
      item.conversationId === discussion.conversationId &&
      item.discussionId === discussion.id
  )) {
    entries.push({
      id: evidenceAlias("message", message.id),
      kind: "message",
      label: message.content.slice(0, 160)
    });
  }
  for (const round of discussion.rounds) {
    for (const turn of round.turns) {
      if (turn.status !== "completed") continue;
      entries.push({
        id: evidenceAlias("turn", turn.id),
        kind: "turn",
        label:
          turn.payload?.summary ??
          turn.content?.slice(0, 160) ??
          turn.id
      });
    }
  }
  for (const task of state.tasks.filter(
    (item) => item.conversationId === discussion.conversationId
  )) {
    entries.push({
      id: evidenceAlias("task", task.id),
      kind: "task",
      label: task.title
    });
  }
  const taskIds = new Set(
    state.tasks
      .filter((item) => item.conversationId === discussion.conversationId)
      .map((item) => item.id)
  );
  for (const artifact of state.artifacts.filter(
    (item) =>
      (item.ownerType === "discussion" &&
        item.ownerId === discussion.id) ||
      (item.ownerType === "task" && taskIds.has(item.ownerId))
  )) {
    entries.push({
      id: evidenceAlias("artifact", artifact.id),
      kind: "artifact",
      label: artifact.name
    });
  }
  const discussionRuns = new Set(
    state.runs
      .filter((run) => run.discussionId === discussion.id)
      .map((run) => run.id)
  );
  for (const event of state.runEvents.filter(
    (item) =>
      item.type === "tool_completed" && discussionRuns.has(item.runId)
  )) {
    entries.push({
      id: evidenceAlias("tool_result", event.id),
      kind: "tool_result",
      label: String(event.payload.toolName ?? event.id)
    });
  }
  for (const chunk of attachedReadyChunks(state, discussion)) {
    entries.push({
      id: `external:${chunk.id}`,
      kind: "external_source",
      label: chunk.content.slice(0, 160)
    });
  }
  return entries;
}

export function validateDiscussionTurnEvidence(
  state: AppState,
  discussion: Discussion,
  payload: DiscussionTurnPayload,
  now = new Date().toISOString()
): {
  payload: DiscussionTurnPayload;
  references: EvidenceReference[];
  coverage: {
    claimCount: number;
    claimsWithEvidence: number;
  };
} {
  const scope = discussionEvidenceScope(state, discussion);
  const references = new Map<string, EvidenceReference>();
  const claims = payload.claims.map((claim) => {
    const kind = claim.kind ?? "inference";
    const evidenceIds = [...new Set(claim.evidenceIds ?? [])];
    if (kind === "fact" && evidenceIds.length === 0) {
      throw new DiscussionEvidenceError(
        "Fact claims require at least one evidence reference",
        {
          claim: claim.statement,
          reason: "missing"
        }
      );
    }
    for (const alias of evidenceIds) {
      const resolved = resolveEvidence(
        state,
        scope,
        alias,
        now
      );
      references.set(resolved.reference.id, resolved.reference);
    }
    return {
      ...claim,
      kind,
      ...(evidenceIds.length > 0 ? { evidenceIds } : {})
    };
  });
  return {
    payload: { ...payload, claims },
    references: [...references.values()],
    coverage: {
      claimCount: claims.length,
      claimsWithEvidence: claims.filter(
        (claim) => (claim.evidenceIds?.length ?? 0) > 0
      ).length
    }
  };
}

export function repairDiscussionTurnEvidence(
  state: AppState,
  discussion: Discussion,
  payload: DiscussionTurnPayload,
  now = new Date().toISOString()
): {
  payload: DiscussionTurnPayload;
  references: EvidenceReference[];
  coverage: {
    claimCount: number;
    claimsWithEvidence: number;
  };
  downgradedClaims: number;
  removedEvidenceIds: number;
} {
  const scope = discussionEvidenceScope(state, discussion);
  const references = new Map<string, EvidenceReference>();
  let downgradedClaims = 0;
  let removedEvidenceIds = 0;
  const claims = payload.claims.map((claim) => {
    const originalIds = [...new Set(claim.evidenceIds ?? [])];
    const validIds: string[] = [];
    for (const alias of originalIds) {
      try {
        const resolved = resolveEvidence(state, scope, alias, now);
        references.set(resolved.reference.id, resolved.reference);
        validIds.push(alias);
      } catch {
        removedEvidenceIds += 1;
      }
    }
    const kind = claim.kind ?? "inference";
    const repairedKind =
      kind === "fact" && validIds.length === 0 ? "inference" : kind;
    if (repairedKind !== kind) downgradedClaims += 1;
    return {
      ...claim,
      kind: repairedKind,
      ...(validIds.length > 0 ? { evidenceIds: validIds } : { evidenceIds: [] })
    };
  });
  return {
    payload: { ...payload, claims },
    references: [...references.values()],
    coverage: {
      claimCount: claims.length,
      claimsWithEvidence: claims.filter(
        (claim) => (claim.evidenceIds?.length ?? 0) > 0
      ).length
    },
    downgradedClaims,
    removedEvidenceIds
  };
}

export function repairDiscussionBriefEvidence(
  state: AppState,
  discussion: Discussion,
  brief: DiscussionBriefV2,
  now = new Date().toISOString()
): {
  brief: DiscussionBriefV2;
  references: EvidenceReference[];
  removedFacts: number;
  restoredFacts: number;
} {
  const scope = discussionEvidenceScope(state, discussion);
  const references = new Map<string, EvidenceReference>();
  const originalFactCount = brief.facts.length;
  const facts = brief.facts.flatMap((fact) => {
    const evidenceIds: string[] = [];
    for (const alias of fact.evidenceIds) {
      try {
        if (alias.startsWith("turn:")) {
          const turn = discussion.rounds
            .flatMap((round) => round.turns)
            .find((item) => item.id === alias.slice("turn:".length));
          const supported = turn?.payload?.claims.some(
            (claim) =>
              claim.kind === "fact" &&
              (claim.evidenceIds?.length ?? 0) > 0
          );
          if (!supported) throw new Error("Unsupported Brief fact");
        }
        const resolved = resolveEvidence(state, scope, alias, now);
        references.set(resolved.reference.id, resolved.reference);
        evidenceIds.push(alias);
      } catch {
        continue;
      }
    }
    return evidenceIds.length > 0 &&
      evidenceIds.some((id) => hasPositionGrounding(discussion, id))
      ? [{ ...fact, evidenceIds }]
      : [];
  });

  let restoredFacts = 0;
  if (facts.length === 0) {
    const supported = discussion.rounds
      .filter((round) => round.phase === "positions")
      .flatMap((round) => round.turns)
      .filter((turn) => turn.status === "completed" && turn.payload)
      .flatMap((turn) => turn.payload?.claims ?? [])
      .filter(
        (claim) =>
          claim.kind === "fact" &&
          (claim.evidenceIds?.length ?? 0) > 0
      );
    const seen = new Set<string>();
    for (const claim of supported) {
      const key = claim.statement.trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      facts.push({
        statement: claim.statement,
        kind: "fact",
        evidenceIds: [...new Set(claim.evidenceIds ?? [])]
      });
      restoredFacts += 1;
      if (facts.length >= 5) break;
    }
  }

  return {
    brief: { ...brief, facts },
    references: [...references.values()],
    removedFacts: originalFactCount - (facts.length - restoredFacts),
    restoredFacts
  };
}

export function validateDiscussionBriefEvidence(
  state: AppState,
  discussion: Discussion,
  brief: {
    facts: Array<{
      statement: string;
      evidenceIds?: string[];
      kind?: "fact";
    }>;
  },
  now = new Date().toISOString(),
  options: { requirePositionGrounding?: boolean } = {}
): EvidenceReference[] {
  const scope = discussionEvidenceScope(state, discussion);
  const references = new Map<string, EvidenceReference>();
  for (const fact of brief.facts) {
    if (
      fact.kind !== "fact" ||
      !fact.evidenceIds ||
      fact.evidenceIds.length === 0
    ) {
      throw new DiscussionEvidenceError(
        "Discussion Brief facts require evidence references",
        {
          claim: fact.statement,
          reason: "missing"
        }
      );
    }
    if (
      options.requirePositionGrounding &&
      !fact.evidenceIds.some((alias) =>
        hasPositionGrounding(discussion, alias)
      )
    ) {
      throw new DiscussionEvidenceError(
        "Discussion Brief fact is not grounded in Position claims",
        {
          claim: fact.statement,
          reason: "out_of_scope"
        }
      );
    }
    for (const alias of fact.evidenceIds) {
      if (alias.startsWith("turn:")) {
        const turn = discussion.rounds
          .flatMap((round) => round.turns)
          .find((item) => item.id === alias.slice("turn:".length));
        const supportedFact = turn?.payload?.claims.some(
          (claim) =>
            claim.kind === "fact" &&
            (claim.evidenceIds?.length ?? 0) > 0
        );
        if (!supportedFact) {
          throw new DiscussionEvidenceError(
            "Inference cannot be promoted to a Discussion Brief fact",
            {
              evidenceId: alias,
              claim: fact.statement,
              reason: "out_of_scope"
            }
          );
        }
      }
      const resolved = resolveEvidence(
        state,
        scope,
        alias,
        now
      );
      references.set(resolved.reference.id, resolved.reference);
    }
  }
  return [...references.values()];
}

export type ResolvedBriefFactEvidence = {
  statement: string;
  evidenceIds: string[];
  resolved: Array<{
    alias: string;
    kind: EvidenceReferenceKind;
    chunkId?: string;
    sourceTitle?: string;
    excerpt: string;
    excerptHash: string;
  }>;
  unresolvedIds: string[];
};

/**
 * Resolve a Brief's facts to the evidence the traceable UI can render: per
 * fact, each evidence alias resolves to its excerpt, hash, and — for
 * `external:<chunkId>` citations — the chunk id and Source title. Aliases
 * that no longer resolve are returned in `unresolvedIds`, never dropped.
 */
export function resolveBriefFactEvidence(
  state: AppState,
  discussion: Discussion,
  brief: { facts: Array<{ statement: string; evidenceIds: string[] }> },
  now = new Date().toISOString()
): ResolvedBriefFactEvidence[] {
  const scope = discussionEvidenceScope(state, discussion);
  return brief.facts.map((fact) => {
    const resolved: ResolvedBriefFactEvidence["resolved"] = [];
    const unresolvedIds: string[] = [];
    for (const alias of fact.evidenceIds) {
      try {
        const { reference, label } = resolveEvidence(
          state,
          scope,
          alias,
          now
        );
        let chunkId: string | undefined;
        let sourceTitle: string | undefined;
        if (
          reference.kind === "external_source" &&
          !/^https?:\/\//.test(reference.sourceId)
        ) {
          const chunk = state.chunks.find(
            (item) => item.id === reference.sourceId
          );
          if (chunk) {
            chunkId = chunk.id;
            sourceTitle = state.sources.find(
              (item) => item.id === chunk.sourceId
            )?.title;
          }
        }
        resolved.push({
          alias,
          kind: reference.kind,
          ...(chunkId !== undefined ? { chunkId } : {}),
          ...(sourceTitle !== undefined ? { sourceTitle } : {}),
          excerpt: label,
          excerptHash: reference.excerptHash ?? ""
        });
      } catch {
        unresolvedIds.push(alias);
      }
    }
    return {
      statement: fact.statement,
      evidenceIds: fact.evidenceIds,
      resolved,
      unresolvedIds
    };
  });
}

export function evidenceCoverage(payload: DiscussionTurnPayload) {
  const claims = payload.claims.filter(
    (claim) => claim.kind === "fact"
  );
  return {
    factCount: claims.length,
    factsWithEvidence: claims.filter(
      (claim) => (claim.evidenceIds?.length ?? 0) > 0
    ).length
  };
}
