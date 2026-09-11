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

**Message**:
An ordered public communication in a conversation, authored by the user or an employee.
_Avoid_: Post, event

**Task**:
A trackable unit of requested work with a goal, assignees, status, and artifacts.
_Avoid_: Job, issue, ticket

**Run**:
A bounded attempt to process a conversation turn, including employee responses and tool activity.
_Avoid_: Job, execution

**Approval**:
A user decision required before an employee invokes a side-effecting tool.
_Avoid_: Permission, confirmation

**Artifact**:
A structured result attached to a task, limited to text, Markdown, or JSON in v1.
_Avoid_: Attachment, file, output
