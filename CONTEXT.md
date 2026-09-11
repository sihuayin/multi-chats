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

**Task**:
A trackable unit of requested work with a goal, assignees, status, and artifacts.
_Avoid_: Job, issue, ticket
