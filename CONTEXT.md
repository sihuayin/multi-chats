# Multi-Chats

A single-workspace application for configuring AI employees, organizing them into groups, and collaborating with them in conversations to complete tasks.

## Language

**Workspace**:
The configuration boundary that owns employees, groups, tools, provider credentials, and conversations.
_Avoid_: Organization, tenant

**Employee**:
A configurable AI worker with an identity, a model configuration, and a set of skills.
_Avoid_: Agent, assistant, bot

**Skill**:
A structured capability that defines what an employee can do and which tools it may use.
_Avoid_: Plugin, action

**Tool**:
An external action or data source that a skill may invoke.
_Avoid_: Capability, integration

**Built-in Tool**:
A Tool the application ships rather than the operator creating it. It cannot be edited or deleted.
_Avoid_: System tool, default tool

**Registered Tool**:
A Tool the operator creates in the Workspace, which the Workspace owns and stores.
_Avoid_: Custom tool, user tool, plugin

**Tool credential**:
A secret stored for a Tool that the Tool injects into its request when it is called. It is write-only: nothing reads it back after storage.
_Avoid_: API key, token, secret

**Request template**:
The declared shape of a Tool's HTTP request — method, URL, headers, and body — whose placeholders are filled from Tool arguments and the Tool credential when the Tool is called. What a call actually sends is the _rendered request_, which does not outlive the call.
_Avoid_: Request definition, payload

**Withheld Tool**:
A Tool the Workspace owns and an Employee's Skill allows, but which is not offered in a Discussion Turn. Whether a Tool is withheld is per-context, not a property of the Tool: the same Tool is offered in a Conversation and withheld in a Discussion.
_Avoid_: Disabled tool, blocked tool

**Group**:
A reusable team template that defines a default set of employees for new conversations.
_Avoid_: Team

**Conversation**:
A chat room with a specific member set, message history, and related tasks.
_Avoid_: Channel, room, thread

**Discussion**:
A bounded multi-round analysis of a topic by a group of Employees that produces a Discussion Brief.
_Avoid_: Meeting, debate

**Discussion Participant**:
An Employee's role and objective within a Discussion, distinct from the Employee itself.
_Avoid_: Discussion member

**Facilitator**:
The Discussion Participant responsible for synthesis and the final Discussion Brief.
_Avoid_: Moderator

**Mode**:
The analytical emphasis of a Discussion: requirements, problem, solution, or review.
_Avoid_: Template

**Round**:
A bounded phase-specific stage whose current attempt is executed as one Run; retry creates a new Run without rewriting history.
_Avoid_: Iteration

**Round Phase**:
The protocol stage of a Round: positions, cross-response, or synthesis.
_Avoid_: Step

**Turn**:
One Discussion Participant's contribution within a Round.
_Avoid_: Response

**Discussion Brief**:
The canonical versioned JSON Artifact produced by a Discussion, revised immutably and confirmed by the user.
_Avoid_: Report, summary

**Discussion Event**:
An ordered Discussion-owned fact about phase, interruption, review, convergence, or completion.
_Avoid_: Run event

**Message**:
An ordered public communication in a conversation, authored by the user, an employee, or the system.
_Avoid_: Post, event

**Task**:
A trackable unit of requested work with a goal, assignees, status, and artifacts.
_Avoid_: Job, issue, ticket

**Run**:
A bounded attempt to process a conversation turn, including employee responses and tool activity.
_Avoid_: Job, execution

**Run outcome**:
The terminal disposition of a Run: completed, failed, cancelled, or interrupted.
_Avoid_: Result, status

**Provider attempt**:
One auditable call to a Provider model made for a Run, synthesis, compression, or Provider smoke matrix.
_Avoid_: Provider call, invocation

**Model usage**:
The exact, estimated, or unknown input, output, cached, reasoning, and total token counts for a Provider attempt.
_Avoid_: Token count, metrics

**Tool result**:
The content one Tool call returned, recorded on the Run that made the call.
_Avoid_: Tool output, tool response

**Evidence reference**:
A stable reference from a claim, a compression record, or a Message to the Message, Turn, Task, Artifact, Tool result, or external source that supports it.
_Avoid_: Citation, source text

**Discussion intervention**:
A user-authored constraint, question, correction, material addition, or lifecycle change applied to a Discussion between Rounds.
_Avoid_: Steering message, prompt

**Discussion Budget**:
The bounded total token and optional total cost limits of a Discussion, inherited from Workspace defaults at creation, with soft and hard thresholds enforced before each Provider call.
_Avoid_: Quota, allowance, spending limit

**Convergence Recommendation**:
An advisory signal a cross-response Turn may return suggesting that content Rounds are complete; it never changes Discussion status or stops execution by itself.
_Avoid_: Convergence decision, verdict

**Quiet Round**:
A completed Cross-response Round whose validated Turns add no new normalized supported claim, evidence reference, correction, or unresolved question; two consecutive Quiet Rounds converge a Discussion unless a limit or pending Discussion intervention takes precedence.
_Avoid_: Idle round, empty round

**Compression record**:
An immutable, source-linked representation of completed Discussion history that replaces older Turns in a model request when the token budget requires it.
_Avoid_: Summary, truncation

**Pricing snapshot**:
The versioned model rates used to calculate the cost of a Provider attempt without changing historical cost when Provider prices change.
_Avoid_: Price table, current rate

**Provider family**:
The request/response dialect a Provider speaks — `openai_compatible`, `anthropic`, or `google` — used to require that a Provider smoke matrix proving more than one target exercises independent adapters, not one dialect twice.
_Avoid_: Provider vendor, API flavour

**Smoke target role**:
Whether a Provider smoke matrix target is the `primary` under test or the `fallback` that must take over when the primary fails.
_Avoid_: Provider slot, target order

**Provider smoke matrix**:
The opt-in, redacted, token- and cost-capped run of Smoke scenarios that proves the production Provider adapters satisfy the reliable Discussion contracts without making paid credentials mandatory for normal verification.
_Avoid_: Provider test suite, integration test

**Smoke scenario**:
One named contract a Provider smoke matrix proves against the production adapters, such as structured output, usage capture, context pressure, compression, retry, failover, cancellation, or Discussion Brief generation.
_Avoid_: Test case, fixture

**Provider smoke report**:
The redacted, versioned evidence a Provider smoke matrix emits: each Smoke scenario's status, attempts with Provider, model, outcome, usage, and cost, its artifact links, the totals, and the token and cost caps it stayed within.
_Avoid_: Test log, results file

**Real-Provider release gate**:
The opt-in workflow that runs the Provider smoke matrix against production adapters, evaluates the Discussion-quality corpus report, and publishes one redacted release-gate result.
_Avoid_: Provider test suite, CI job

**Coverage profile**:
The declared scope of a real-Provider release run. The standard profile verifies OpenAI-compatible and Anthropic cross-family failover; the network-constrained profile verifies DeepSeek target switching but not cross-family failover.
_Avoid_: Provider mode, environment preset

**Approval**:
A user decision required before an employee invokes a side-effecting tool.
_Avoid_: Permission, confirmation

**Tool definition snapshot**:
The copy of a Tool's definition captured on an Approval, so that the request an approver saw is the request that runs even if the Tool is edited while the Run waits.
_Avoid_: Tool version, approval copy

**Artifact**:
A structured result owned by a Task or Discussion, limited to text, Markdown, or JSON in v1.
_Avoid_: Attachment, file, output

**Source**:
An ingested external document or web page, stored as citable text Chunks.
_Avoid_: Document, file, knowledge base

**Source attachment**:
A user's declaration that a Source is evidence for one Discussion; a Discussion's attached Sources are the only external evidence its claims may cite.
_Avoid_: Source link, document link

**Chunk**:
A citable unit of extracted text within a Source, addressed by an `external:<chunkId>` Evidence reference.
_Avoid_: Passage, fragment, snippet

**Retrieved chunk**:
A Chunk returned to a Run by a Tool call, and thereby citable within that Run. The role is per-Run: the same Chunk may be retrieved in one Run and not in the next.
_Avoid_: Search result, hit, match

**History item**:
A Message, Task, or Artifact belonging to one of the Workspace's Conversations, and the unit that cross-Conversation retrieval returns. Every History item is Conversation-owned: a Message and a Task each carry a Conversation, and an Artifact is owned by a Task or Discussion that belongs to one.
_Avoid_: Record, memory, document

**Retrieved item**:
A History item returned to a Run by a Tool call, and thereby citable within that Run. The role is per-Run, exactly as **Retrieved chunk** is: the same History item may be retrieved in one Run and not in the next.
_Avoid_: Search result, hit, match

**Citable set**:
The items a Conversation may cite: those belonging to the Conversation itself, those retrieved by the Run being resolved, and those from another Conversation that one of its Messages has already cited.
_Avoid_: Evidence pool, allowed evidence

**Source revision**:
A versioned chunk set of a Source; a refresh produces a new revision whose chunks supersede the prior set while the prior chunks remain resolvable by confirmed Briefs.
_Avoid_: Source version, snapshot

**Source tombstone**:
The deleted-but-retained state of a Source whose chunks remain stored so already-confirmed Briefs keep resolving their Evidence references; a tombstoned Source is hidden from new attachment and context.
_Avoid_: Source deletion, purge

**Stale Source**:
A URL Source whose fetched content no longer matches its ingested content, detected by an on-demand content-hash comparison.
_Avoid_: Outdated Source, dirty Source

**Dangling evidence reference**:
An Evidence reference whose target Chunk no longer resolves; the failure mode that Source refresh and deletion must never cause.
_Avoid_: Broken citation, orphaned reference
