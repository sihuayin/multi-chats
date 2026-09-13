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
A bounded stage of a Discussion executed as one Run.
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

**Approval**:
A user decision required before an employee invokes a side-effecting tool.
_Avoid_: Permission, confirmation

**Artifact**:
A structured result owned by a Task or Discussion, limited to text, Markdown, or JSON in v1.
_Avoid_: Attachment, file, output
