# ProviderAttempt → entity attribution matrix

Source of truth for how a `ProviderAttempt` resolves to the entities the Usage & Cost panel groups by. All citations are `file:line` against the current `main`.

## The attempt record

`ProviderAttempt` (`src/server/domain/types.ts:97-123`) carries:

- `workspaceId` — always present.
- `runId?` — present for all attempts created via `startProviderAttempt`; **absent** on `discussion_rerank`.
- `discussionId?` — present for all discussion-related purposes; **absent** on `conversation`.
- `roundId?`, `turnId?` — present only for `discussion_turn` (the only per-participant purpose).
- `purpose`, `provider`, `modelId`, `targetOrder`, `attempt`, `status`, `usage`, `pricingId?`, `estimatedCostMicros?`, `startedAt`, `completedAt?`.

**There is no `employeeId` and no `conversationId` on the attempt.** Both must be derived. This is the central constraint of the whole panel.

## Purposes and how each is created

`ProviderAttemptPurpose` (`types.ts:68-74`): `conversation`, `discussion_turn`, `discussion_synthesis`, `discussion_compression`, `discussion_rerank`, `smoke_test`.

| purpose | creation path | `runId` | `discussionId` | `roundId`/`turnId` |
| --- | --- | --- | --- | --- |
| `conversation` | `ConversationRunService.startProviderAttempt` (`conversation-run-service.ts:1599-1664`) | ✅ required (errors if run missing) | ❌ | ❌ |
| `discussion_turn` | same, with `roundId`/`turnId` passed from the phase context (`conversation-run-service.ts:2589-2590`, `2696-2697`, `2890-2891`, `2934-2935`, `2983-2984`) | ✅ | ✅ (from `run.discussionId`) | ✅ |
| `discussion_synthesis` | `startProviderAttempt` (no turn) | ✅ | ✅ | ❌ |
| `discussion_compression` | `startProviderAttempt` (`conversation-run-service.ts:1964`, `1998`) | ✅ | ✅ | ❌ |
| `discussion_rerank` | inline push (`conversation-run-service.ts:2269-2279`) | ❌ **absent** | ✅ | ❌ |
| `smoke_test` | **never written** — declared in `types.ts:74` and `runtime-contracts.ts:47` only | — | — | — |

## The three hops that fill in the missing links

- **`runId → Run`** (`types.ts:304-320`): `Run` has `conversationId` (always), `taskId?` (only task-triggered conversation runs — `conversation-run-service.ts:455`, `468`, `818`, `837`), `discussionId?`, and `memberSnapshot: string[]` (a *list* of employee ids).
- **`discussionId → Discussion`** (`types.ts:605-635`): `Discussion` has `conversationId`, `sourceTaskId?`, `confirmedTaskId?`, and `participants` (each participant carries `employeeId`).
- **`turnId → round.turn → participant.employeeId`**: a `Discussion` round's turn references a participant (`types.ts` round/turn structures), which names the employee.

## Resolution table (attempt → entity)

| entity | how | reliable? |
| --- | --- | --- |
| Workspace | `attempt.workspaceId` | ✅ direct |
| Provider / Model | `attempt.provider` / `attempt.modelId` | ✅ direct |
| Discussion | `attempt.discussionId` | ✅ direct for all discussion purposes; absent for `conversation` |
| Conversation | `attempt.runId → run.conversationId`; for rerank, `attempt.discussionId → discussion.conversationId` | ✅ with a two-hop for rerank |
| Task | `attempt.runId → run.taskId` (conversation runs only) | ⚠️ discussion spend has no `run.taskId` |
| Employee | `attempt.turnId → participant.employeeId` (discussion turns only) | ❌ conversation / synthesis / compression / rerank are unattributable |

## Ambiguities and failure cases

1. **Task × Discussion spend.** A Discussion's attempts carry `discussionId` but no `taskId`. The only Task links are `discussion.sourceTaskId` (the task the Discussion was created from) and `discussion.confirmedTaskId` (the task the Discussion produced). Which — if either — should count as "this Task's spend" is an open decision (ticket #116), not a data question.

2. **Employee attribution is not in the schema.** Despite the cost-observability contract (#55) listing Employee as an aggregation dimension, the attempt record never recorded `employeeId`. Only `discussion_turn` attempts can reach an employee, via `turnId → participant.employeeId`. `conversation` attempts can only reach a *set* of employees via `run.memberSnapshot`, and a single run contains multiple employees' turns, so the attempt cannot be pinned to one. Synthesis/compression/rerank are whole-Discussion (facilitator) actions with no single employee.

3. **`smoke_test` never lands in the ledger.** The provider smoke matrix (`provider-smoke-runner.ts`) drives real Discussions through the real orchestrator against a **throwaway `MemoryStore`**, so its attempts (real `discussion_*`/`conversation` purposes) never reach the workspace's persisted `state.providerAttempts`. The `smoke_test` purpose is vestigial. No special exclusion is needed in the view.

4. **No attempt has neither `runId` nor `discussionId`** in current code — every written attempt resolves to at least a Conversation.
