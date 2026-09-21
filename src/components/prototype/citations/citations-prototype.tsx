"use client";

/**
 * PROTOTYPE — throwaway. Answers one question for #171 on map #162:
 * "how does a Conversation show the Sources behind a citation?"
 *
 * Three variants of the *same mock conversation*, switchable with ?variant=.
 * They disagree about structure, not styling:
 *   A — inline chips only, no index anywhere
 *   B — inline chips + a source strip under each message
 *   C — a conversation-level evidence rail, citations as markers into it
 *
 * Fake data, no persistence, no backend, no i18n. Delete after the verdict.
 */

import { useState } from "react";
import { PrototypeSwitcher } from "@/components/prototype/prototype-switcher";

// ---------------------------------------------------------------------------
// The scenario. One conversation, two answers, four citations — three resolved,
// one that no longer resolves (the case the whole ticket is about).
// ---------------------------------------------------------------------------

type Citation = {
  alias: string;
  sourceTitle: string;
  excerpt: string;
};

type Part = { text: string } | { alias: string };

type MockMessage = {
  id: string;
  author: "user" | "employee";
  name: string;
  time: string;
  parts: Part[];
};

const CITATIONS: Record<string, Citation> = {
  "external:9f2c1a4e-6b0d-4a1f-9c33-77ab12e4d001": {
    alias: "external:9f2c1a4e-6b0d-4a1f-9c33-77ab12e4d001",
    sourceTitle: "Q3 Architecture Notes",
    excerpt:
      "The persistence model is append-only. A refresh writes a new revision and marks the prior Chunks superseded; nothing is rewritten in place, which is what lets a confirmed Brief keep resolving after its Source changes."
  },
  "external:2b81f0aa-7d41-4c88-b0e2-1d5c93fa7710": {
    alias: "external:2b81f0aa-7d41-4c88-b0e2-1d5c93fa7710",
    sourceTitle: "ADR 0001 — Tool egress transport",
    excerpt:
      "Server-side Tool calls must connect only to an address the Workspace allowlist permits. In this runtime address pinning and fetch are mutually exclusive, so the egress path gets its own node:http transport."
  },
  "external:c41d8b70-5e29-4a63-8f17-0b62da9e4412": {
    alias: "external:c41d8b70-5e29-4a63-8f17-0b62da9e4412",
    sourceTitle: "DeepSeek rate-limit notes",
    excerpt:
      "Retry-After is honoured when present; otherwise the backoff is 1s, 2s, 4s. A 429 during a Discussion Turn is retried before failover is considered, so the fallback target is not consumed by a transient limit."
  },
  // The one that resolves to nothing.
  "external:00000000-dead-beef-4a1f-9c33-000000000000": {
    alias: "external:00000000-dead-beef-4a1f-9c33-000000000000",
    sourceTitle: "",
    excerpt: ""
  }
};

const RESOLVED = new Set([
  "external:9f2c1a4e-6b0d-4a1f-9c33-77ab12e4d001",
  "external:2b81f0aa-7d41-4c88-b0e2-1d5c93fa7710",
  "external:c41d8b70-5e29-4a63-8f17-0b62da9e4412"
]);

const C1 = "external:9f2c1a4e-6b0d-4a1f-9c33-77ab12e4d001";
const C2 = "external:2b81f0aa-7d41-4c88-b0e2-1d5c93fa7710";
const C3 = "external:c41d8b70-5e29-4a63-8f17-0b62da9e4412";
const C4 = "external:00000000-dead-beef-4a1f-9c33-000000000000";

const MESSAGES: MockMessage[] = [
  {
    id: "m1",
    author: "user",
    name: "You",
    time: "10:14",
    parts: [
      {
        text: "How do we keep a confirmed Brief's citations resolving when a Source is refreshed?"
      }
    ]
  },
  {
    id: "m2",
    author: "employee",
    name: "Researcher",
    time: "10:14",
    parts: [
      { text: "Refresh never rewrites a Chunk — it writes a new revision and marks the old ones superseded, so a citation keeps pointing at the text it always pointed at " },
      { alias: C1 },
      { text: ". Deletion is a tombstone that keeps the Chunks for the same reason " },
      { alias: C2 },
      { text: "." }
    ]
  },
  {
    id: "m3",
    author: "user",
    name: "You",
    time: "10:16",
    parts: [
      { text: "And what happens if the model cites something it only saw in a previous turn?" }
    ]
  },
  {
    id: "m4",
    author: "employee",
    name: "Researcher",
    time: "10:16",
    parts: [
      { text: "Then the alias has to still be in the Conversation's citable set. A Chunk retrieved in an earlier turn stays citable once it has been cited " },
      { alias: C1 },
      { text: ", which matches how retries are budgeted " },
      { alias: C3 },
      { text: ". I also tried to re-cite the rate-limit table from the September run " },
      { alias: C4 },
      { text: ", but that one no longer resolves." }
    ]
  }
];

function citationsIn(message: MockMessage): string[] {
  const seen: string[] = [];
  for (const part of message.parts) {
    if ("alias" in part && !seen.includes(part.alias)) seen.push(part.alias);
  }
  return seen;
}

function isResolved(alias: string): boolean {
  return RESOLVED.has(alias);
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

function Message({ message, children }: { message: MockMessage; children?: React.ReactNode }) {
  return (
    <article className={`message-bubble ${message.author}`} data-status="complete">
      <div className="message-meta">
        <strong>{message.name}</strong>
        <time>{message.time}</time>
      </div>
      <p>{children}</p>
    </article>
  );
}

function Excerpt({ citation }: { citation: Citation }) {
  return (
    <div className="mt-2 rounded-md border border-neutral-200 bg-neutral-50 p-3 text-[13px] leading-relaxed dark:border-neutral-800 dark:bg-neutral-900">
      <div className="mb-1 font-medium text-neutral-500">{citation.sourceTitle}</div>
      <div className="text-neutral-600 dark:text-neutral-400">{citation.excerpt}</div>
    </div>
  );
}

const headerClass = "mb-6 border-b border-neutral-200 pb-4 dark:border-neutral-800";
const eyebrowClass = "text-[11px] font-semibold uppercase tracking-widest text-neutral-400";

function VariantHeader({ letter, name, answers }: { letter: string; name: string; answers: string }) {
  return (
    <header className={headerClass}>
      <div className={eyebrowClass}>Variant {letter}</div>
      <h2 className="mt-1 text-lg font-semibold">{name}</h2>
      <p className="mt-1 max-w-2xl text-[13px] text-neutral-500">{answers}</p>
    </header>
  );
}

// ---------------------------------------------------------------------------
// Variant A — inline chips only. No index, no strip, nothing below the message.
// A citation that no longer resolves is left as the literal text it was written
// as: the strictest reading of "soft citations".
// ---------------------------------------------------------------------------

function InlineChip({ alias, onToggle, open }: { alias: string; onToggle: () => void; open: boolean }) {
  const citation = CITATIONS[alias];
  return (
    <button
      type="button"
      onClick={onToggle}
      className={`mx-0.5 inline-flex items-baseline gap-1 rounded px-1.5 py-0.5 align-baseline text-[12px] ${
        open
          ? "bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-200"
          : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700"
      }`}
    >
      <span aria-hidden>◆</span>
      <span className="max-w-[16rem] truncate">{citation.sourceTitle}</span>
    </button>
  );
}

function VariantA() {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div>
      <VariantHeader
        letter="A"
        name="Inline chips only"
        answers="The citation is a link and nothing more. No index at any level; the Source is reachable only where it was cited. A citation that no longer resolves is indistinguishable from prose."
      />
      <div className="message-stream">
        {MESSAGES.map((message) => (
          <div key={message.id}>
            <Message message={message}>
              {message.parts.map((part, index) =>
                "text" in part ? (
                  <span key={index}>{part.text}</span>
                ) : isResolved(part.alias) ? (
                  <InlineChip
                    key={index}
                    alias={part.alias}
                    open={open === part.alias}
                    onToggle={() => setOpen(open === part.alias ? null : part.alias)}
                  />
                ) : (
                  <span key={index}>{part.alias}</span>
                )
              )}
            </Message>
            {open && citationsIn(message).includes(open) ? (
              <Excerpt citation={CITATIONS[open]} />
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Variant B — inline chips + a strip under each message. The message is the
// unit: what did this one answer rest on? A degraded citation is visible in the
// strip as a count, never as a red state.
// ---------------------------------------------------------------------------

function VariantB() {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div>
      <VariantHeader
        letter="B"
        name="Inline chips + per-message source strip"
        answers="Each message carries the Sources it rested on, so a reply is auditable without scrolling. Unresolvable citations are counted in the strip in muted text — visible, but not a failure."
      />
      <div className="message-stream">
        {MESSAGES.map((message) => {
          const aliases = citationsIn(message);
          const resolved = aliases.filter(isResolved);
          const degraded = aliases.length - resolved.length;
          return (
            <div key={message.id}>
              <Message message={message}>
                {message.parts.map((part, index) =>
                  "text" in part ? (
                    <span key={index}>{part.text}</span>
                  ) : isResolved(part.alias) ? (
                    <InlineChip
                      key={index}
                      alias={part.alias}
                      open={open === part.alias}
                      onToggle={() => setOpen(open === part.alias ? null : part.alias)}
                    />
                  ) : (
                    <span key={index}>{part.alias}</span>
                  )
                )}
              </Message>
              {aliases.length > 0 ? (
                <div className="-mt-1 mb-4 flex flex-wrap items-center gap-1.5 rounded-b-md border border-t-0 border-neutral-200 bg-neutral-50 px-3 py-2 text-[12px] dark:border-neutral-800 dark:bg-neutral-900">
                  <span className="mr-1 text-[10px] font-semibold uppercase tracking-widest text-neutral-400">
                    Sources
                  </span>
                  {resolved.map((alias) => (
                    <button
                      key={alias}
                      type="button"
                      onClick={() => setOpen(open === alias ? null : alias)}
                      className={`rounded-full border px-2 py-0.5 ${
                        open === alias
                          ? "border-sky-300 bg-sky-100 text-sky-900 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-200"
                          : "border-neutral-300 bg-white text-neutral-600 hover:border-neutral-400 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300"
                      }`}
                    >
                      {CITATIONS[alias].sourceTitle}
                    </button>
                  ))}
                  {degraded > 0 ? (
                    <span className="ml-1 border-b border-dashed border-neutral-400 text-neutral-400">
                      {degraded} citation{degraded > 1 ? "s" : ""} no longer resolve{degraded > 1 ? "" : "s"}
                    </span>
                  ) : null}
                </div>
              ) : null}
              {open && aliases.includes(open) ? <Excerpt citation={CITATIONS[open]} /> : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Variant C — a conversation-level evidence rail. Sources are a property of the
// whole Conversation; the message just points at them. This is the reading that
// makes Sources "first-class" rather than per-reply footnotes.
// ---------------------------------------------------------------------------

type RailEntry = {
  sourceTitle: string;
  alias: string;
  messageIds: string[];
  resolved: boolean;
};

function railEntries(): RailEntry[] {
  const byTitle = new Map<string, RailEntry>();
  for (const message of MESSAGES) {
    for (const alias of citationsIn(message)) {
      const citation = CITATIONS[alias];
      const key = citation.sourceTitle || alias;
      const entry =
        byTitle.get(key) ??
        {
          sourceTitle: citation.sourceTitle || "(unresolved)",
          alias,
          messageIds: [],
          resolved: isResolved(alias)
        };
      entry.messageIds.push(message.id);
      byTitle.set(key, entry);
    }
  }
  return [...byTitle.values()];
}

function VariantC() {
  const [open, setOpen] = useState<string | null>(null);
  const entries = railEntries();
  return (
    <div>
      <VariantHeader
        letter="C"
        name="Conversation-level evidence rail"
        answers="Sources belong to the Conversation, not to a reply. Inline citations become small markers into a persistent rail that answers “what does this conversation rest on?” at any scroll position."
      />
      <div className="flex gap-6">
        <div className="message-stream min-w-0 flex-1">
          {MESSAGES.map((message) => (
            <div key={message.id}>
              <Message message={message}>
                {message.parts.map((part, index) =>
                  "text" in part ? (
                    <span key={index}>{part.text}</span>
                  ) : isResolved(part.alias) ? (
                    <button
                      key={index}
                      type="button"
                      onClick={() => setOpen(open === part.alias ? null : part.alias)}
                      className={`mx-0.5 align-super text-[10px] font-semibold ${
                        open === part.alias
                          ? "text-sky-600 underline dark:text-sky-400"
                          : "text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300"
                      }`}
                      title={CITATIONS[part.alias].sourceTitle}
                    >
                      [{entries.findIndex((entry) => entry.alias === part.alias) + 1}]
                    </button>
                  ) : (
                    <span key={index}>{part.alias}</span>
                  )
                )}
              </Message>
              {open && citationsIn(message).includes(open) ? (
                <Excerpt citation={CITATIONS[open]} />
              ) : null}
            </div>
          ))}
        </div>

        <aside className="w-72 shrink-0">
          <div className="sticky top-4 rounded-lg border border-neutral-200 dark:border-neutral-800">
            <div className="border-b border-neutral-200 px-3 py-2 dark:border-neutral-800">
              <div className="text-[10px] font-semibold uppercase tracking-widest text-neutral-400">
                Evidence
              </div>
              <div className="text-[13px] text-neutral-500">
                {entries.filter((entry) => entry.resolved).length} Sources cited in this conversation
              </div>
            </div>
            <ul className="divide-y divide-neutral-200 dark:divide-neutral-800">
              {entries.map((entry, index) => (
                <li key={entry.alias}>
                  <button
                    type="button"
                    disabled={!entry.resolved}
                    onClick={() => setOpen(open === entry.alias ? null : entry.alias)}
                    className={`flex w-full items-start gap-2 px-3 py-2 text-left text-[13px] ${
                      entry.resolved
                        ? "hover:bg-neutral-50 dark:hover:bg-neutral-900"
                        : "cursor-default opacity-45"
                    }`}
                  >
                    <span className="mt-0.5 text-[10px] font-semibold text-neutral-400">
                      {entry.resolved ? `[${index + 1}]` : "—"}
                    </span>
                    <span className="min-w-0">
                      <span
                        className={
                          entry.resolved
                            ? "block truncate font-medium"
                            : "block truncate font-medium line-through decoration-dotted"
                        }
                      >
                        {entry.sourceTitle}
                      </span>
                      <span className="text-[11px] text-neutral-400">
                        {entry.resolved
                          ? `${entry.messageIds.length} message${entry.messageIds.length > 1 ? "s" : ""}`
                          : "no longer resolves"}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            {open ? <div className="border-t border-neutral-200 p-3 dark:border-neutral-800"><Excerpt citation={CITATIONS[open]} /></div> : null}
          </div>
        </aside>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

const VARIANTS = ["A", "B", "C"] as const;

const LABELS: Record<string, string> = {
  A: "Inline chips only",
  B: "Chips + per-message strip",
  C: "Conversation evidence rail"
};

export function CitationsPrototype({ initialVariant }: { initialVariant: string }) {
  const variant = (VARIANTS as readonly string[]).includes(initialVariant)
    ? initialVariant
    : "A";

  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      <p className="mb-1 text-[11px] font-semibold uppercase tracking-widest text-amber-600">
        Prototype — throwaway
      </p>
      <h1 className="mb-1 text-xl font-semibold">
        How a Conversation shows the Sources behind a citation
      </h1>
      <p className="mb-6 max-w-2xl text-[13px] text-neutral-500">
        The same mock conversation in three structurally different readings. Three citations resolve;
        one does not — that last one is the case this ticket exists for. Flip with{" "}
        <code className="rounded bg-neutral-100 px-1 dark:bg-neutral-800">?variant=A|B|C</code> or the
        arrows below.
      </p>

      {variant === "A" ? <VariantA /> : null}
      {variant === "B" ? <VariantB /> : null}
      {variant === "C" ? <VariantC /> : null}

      <PrototypeSwitcher variants={[...VARIANTS]} labels={LABELS} current={variant} />
    </div>
  );
}
