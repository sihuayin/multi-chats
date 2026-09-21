# A Conversation retrieves across the whole Workspace, while a Discussion stays attachment-scoped

A Discussion's evidence is declared: a user attaches Sources, and only those may be cited. A Conversation retrieves instead — the built-in `search_sources` Tool searches every ready, non-tombstoned Source in the Workspace, and the Chunks it returns become citable for the Run that retrieved them. The two scopes differ deliberately, and the reason is what each one produces.

## Considered Options

[Map: Make Discussion evidence traceable end-to-end](https://github.com/sihuayin/multi-chats/issues/100) ruled whole-workspace retrieval out of scope for itself. That exclusion was about Discussions, and it is not reopened here: a Discussion Brief is a deliverable whose every claim must trace to material the user put there, so its evidence scope stays user-declared and the model cannot widen it.

Giving a Conversation its own attached Sources — the Discussion model, with an attachment surface — was rejected because a Conversation is a chat room rather than a bounded analysis, so pre-declaring its evidence has no natural moment. Searching the Workspace but treating every retrieved Chunk as permanently citable was rejected because the set would widen with conversation length until it converged on the scope ruled out above; anchoring the second half to *already cited* holds the line that what can be cited is either being read now or has already been said out loud in this Conversation.

## Consequences

A citation resolves only while its Chunk is in the Conversation's citable set, which is derived rather than attached. Chunk immutability becomes load-bearing in two places at once: it keeps a historical excerpt from changing under a Source refresh, and it is what makes a `contentHash`-keyed token cache correct rather than merely fast.
