"use client";

/**
 * PROTOTYPE — throwaway. Answers one question for #195 on map #188:
 * "how does a Conversation show a citation whose target is a Message in ANOTHER Conversation?"
 *
 * Three variants of the same mock conversation, switchable with ?variant=.
 * They disagree about *where the remote-ness is expressed*, not about styling:
 *   A — origin travels on the citation chip itself; the strip stays one flat list; no jump.
 *   B — chips uniform, the per-message strip is sectioned by origin, and a remote citation
 *       opens a panel offering "Open in <Conversation>", which actually swaps the stream.
 *   C — remote evidence is pulled out of the sentence into a "From elsewhere" block under
 *       the message, quoted in full, with a jump.
 *
 * The scenario exercises every branch of the citation contract settled in #190: a Source,
 * a Message from this Conversation, a Message from another Conversation, a confirmed Brief
 * from another Conversation, and a remote citation whose Conversation no longer exists.
 *
 * Fake data, no persistence, no backend, no i18n. Delete after the verdict.
 */

import { useState } from "react";
import { PrototypeSwitcher } from "@/components/prototype/prototype-switcher";

// ---------------------------------------------------------------------------
// The evidence. `origin` is the axis the whole ticket is about.
// ---------------------------------------------------------------------------

type Evidence = {
  alias: string;
  label: string;
  origin: "source" | "local" | "remote";
  /** Present only when origin === "remote". */
  conversation?: string;
  orphaned?: boolean;
  excerptTitle: string;
  excerpt: string;
};

const EVIDENCE: Record<string, Evidence> = {
  // A Source — the corpus #171 already settled the rendering for.
  "external:2b81f0aa-7d41-4c88-b0e2-1d5c93fa7710": {
    alias: "external:2b81f0aa-7d41-4c88-b0e2-1d5c93fa7710",
    label: "Retrieval ranking notes",
    origin: "source",
    excerptTitle: "Retrieval ranking notes",
    excerpt:
      "rankChunks costs ~7 ms at 5,000 chunks while re-tokenizing the corpus costs ~722 ms. The fix is a contentHash-keyed token cache behind the ranking, not an index."
  },

  // A Message from *this* Conversation — the native tier of the citable set.
  "message:3c9d10b4-77a2-4e51-8b0f-5a2c11e9d402": {
    alias: "message:3c9d10b4-77a2-4e51-8b0f-5a2c11e9d402",
    label: "your question at 10:14",
    origin: "local",
    excerptTitle: "You · 10:14",
    excerpt:
      "Before we lock Q4, remind me why Discussions and Conversations ended up with different evidence scopes."
  },

  // A Message from another Conversation — the case this ticket exists for.
  "message:7a1f44c0-2e83-4d17-b6a5-90fe2c8b1d31": {
    alias: "message:7a1f44c0-2e83-4d17-b6a5-90fe2c8b1d31",
    label: "the Q3 review's conclusion",
    origin: "remote",
    conversation: "Q3 Architecture Review",
    excerptTitle: "Q3 Architecture Review",
    excerpt:
      "A Brief is a checkable deliverable whose every claim must trace to material the user put there. A Conversation Message is talk — its citations are a clue for a human reader, not a machine-checkable claim."
  },

  // A confirmed Discussion Brief from another Conversation — an Artifact, remote.
  "artifact:b5e2a781-6c04-4f9e-a3d2-8b17f0e5c904": {
    alias: "artifact:b5e2a781-6c04-4f9e-a3d2-8b17f0e5c904",
    label: "Q3 retrieval brief",
    origin: "remote",
    conversation: "Q3 Architecture Review",
    excerptTitle: "Q3 Architecture Review · confirmed Brief",
    excerpt:
      "Decision 4. Retrieval scope differs by surface. A Discussion's evidence stays attachment-scoped; a Conversation retrieves across the whole Workspace. The two are not reconciled, and the divergence is recorded in ADR-0002."
  },

  // A remote citation whose Conversation has been deleted — the dangling case.
  "message:00000000-0000-4000-8000-000000000000": {
    alias: "message:00000000-0000-4000-8000-000000000000",
    label: "the September rate-limit thread",
    origin: "remote",
    conversation: "September ops",
    orphaned: true,
    excerptTitle: "",
    excerpt: ""
  }
};

const SOURCE = "external:2b81f0aa-7d41-4c88-b0e2-1d5c93fa7710";
const LOCAL_MSG = "message:3c9d10b4-77a2-4e51-8b0f-5a2c11e9d402";
const REMOTE_MSG = "message:7a1f44c0-2e83-4d17-b6a5-90fe2c8b1d31";
const REMOTE_BRIEF = "artifact:b5e2a781-6c04-4f9e-a3d2-8b17f0e5c904";
const DANGLING = "message:00000000-0000-4000-8000-000000000000";

type Part = { text: string } | { alias: string };
type MockMessage = { id: string; author: "user" | "employee"; name: string; time: string; parts: Part[] };

const MESSAGES: MockMessage[] = [
  {
    id: "m1",
    author: "user",
    name: "You",
    time: "10:14",
    parts: [
      {
        text: "Before we lock Q4, remind me why Discussions and Conversations ended up with different evidence scopes."
      }
    ]
  },
  {
    id: "m2",
    author: "employee",
    name: "Researcher",
    time: "10:14",
    parts: [
      { text: "That got settled in the Q3 review — a Brief has to trace to material the user attached, while a chat retrieves instead " },
      { alias: REMOTE_MSG },
      { text: ". You and I went through the same distinction here " },
      { alias: LOCAL_MSG },
      { text: ", and the cost of ranking is written up in the retrieval note " },
      { alias: SOURCE },
      { text: "." }
    ]
  },
  {
    id: "m3",
    author: "user",
    name: "You",
    time: "10:16",
    parts: [{ text: "And what happens to a citation when the Conversation it came from is gone?" }]
  },
  {
    id: "m4",
    author: "employee",
    name: "Researcher",
    time: "10:16",
    parts: [
      { text: "It degrades and gets counted, like any other unresolvable citation " },
      { alias: DANGLING },
      { text: ". That this holds for Briefs too is in the brief we confirmed " },
      { alias: REMOTE_BRIEF },
      { text: ", which I pulled in rather than re-deriving." }
    ]
  }
];

/** A Conversation the reader can actually jump into, for variant B. */
const REMOTE_CONVERSATION = {
  title: "Q3 Architecture Review",
  messages: [
    { id: "q1", name: "You", time: "Sep 14", text: "Do we let a Conversation retrieve across the whole Workspace, or keep it attachment-scoped like a Discussion?" },
    { id: "q2", name: "Analyst", time: "Sep 14", text: "A Brief is a checkable deliverable whose every claim must trace to material the user put there. A Conversation Message is talk — its citations are a clue for a human reader, not a machine-checkable claim.", highlighted: true },
    { id: "q3", name: "Designer", time: "Sep 14", text: "Then the divergence is deliberate and should be written down rather than left to be rediscovered." }
  ]
};

// ---------------------------------------------------------------------------

function citationsIn(message: MockMessage): string[] {
  const seen: string[] = [];
  for (const part of message.parts) {
    if ("alias" in part && !seen.includes(part.alias)) seen.push(part.alias);
  }
  return seen;
}

const isRemote = (alias: string) => EVIDENCE[alias].origin === "remote";
const isResolved = (alias: string) => !EVIDENCE[alias].orphaned;

/** Muted, never an error state. `border-b` drew a box in Tailwind v4 - use a text underline. */
function Degraded({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <span className="text-neutral-400 underline decoration-dotted underline-offset-2">
      {count} citation{count > 1 ? "s" : ""} no longer resolve{count > 1 ? "" : "s"}
    </span>
  );
}

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

/** The excerpt panel. `onOpen` is only ever passed by the variants that offer a jump. */
function Excerpt({ alias, onOpen }: { alias: string; onOpen?: () => void }) {
  const item = EVIDENCE[alias];
  if (item.orphaned) {
    return (
      <div className="mt-2 rounded-md border border-dashed border-neutral-300 bg-neutral-50 p-3 text-[13px] dark:border-neutral-700 dark:bg-neutral-900">
        <div className="mb-1 font-medium text-neutral-500">
          {item.conversation} — this Conversation no longer exists
        </div>
        <div className="text-neutral-400">
          The cited Message was deleted with it, so there is nothing left to show. The reference is
          kept as written and counted, never repaired.
        </div>
      </div>
    );
  }
  return (
    <div className="mt-2 rounded-md border border-neutral-200 bg-neutral-50 p-3 text-[13px] leading-relaxed dark:border-neutral-800 dark:bg-neutral-900">
      <div className="mb-1 flex items-center justify-between gap-3">
        <span className="font-medium text-neutral-500">{item.excerptTitle}</span>
        {onOpen ? (
          <button
            type="button"
            onClick={onOpen}
            className="shrink-0 rounded border border-sky-300 bg-white px-2 py-0.5 text-[12px] font-medium text-sky-800 hover:bg-sky-50 dark:border-sky-800 dark:bg-neutral-900 dark:text-sky-300"
          >
            Open in {item.conversation} ↗
          </button>
        ) : null}
      </div>
      <div className="text-neutral-600 dark:text-neutral-400">{item.excerpt}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Variant A — the origin travels on the chip. One chip vocabulary, one flat
// strip; a remote entry is the same object with its Conversation named on it.
// There is no jump: provenance is a label, not a door.
// ---------------------------------------------------------------------------

function ChipA({ alias, open, onToggle }: { alias: string; open: boolean; onToggle: () => void }) {
  const item = EVIDENCE[alias];
  const remote = item.origin === "remote";
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
      <span aria-hidden className={remote ? "text-amber-600" : ""}>
        {remote ? "↗" : "◆"}
      </span>
      {remote ? <span className="font-medium">{item.conversation}</span> : null}
      {remote ? <span className="text-neutral-400">·</span> : null}
      <span className="max-w-[16rem] truncate">{item.label}</span>
    </button>
  );
}

function VariantA() {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div>
      <VariantHeader
        letter="A"
        name="Origin travels on the chip"
        answers="One chip vocabulary. A remote citation is the same object with its Conversation named inside it. The strip stays a single flat list. Nothing is a door — the excerpt is the whole affordance."
      />
      <div className="message-stream">
        {MESSAGES.map((message) => {
          const aliases = citationsIn(message);
          const degraded = aliases.filter((a) => !isResolved(a)).length;
          return (
            <div key={message.id}>
              <Message message={message}>
                {message.parts.map((part, index) =>
                  "text" in part ? (
                    <span key={index}>{part.text}</span>
                  ) : (
                    <ChipA
                      key={index}
                      alias={part.alias}
                      open={open === part.alias}
                      onToggle={() => setOpen(open === part.alias ? null : part.alias)}
                    />
                  )
                )}
              </Message>
              {aliases.length > 0 ? (
                <div className="-mt-1 mb-4 flex flex-wrap items-center gap-1.5 rounded-b-md border border-t-0 border-neutral-200 bg-neutral-50 px-3 py-2 text-[12px] dark:border-neutral-800 dark:bg-neutral-900">
                  <span className="mr-1 text-[10px] font-semibold uppercase tracking-widest text-neutral-400">
                    Evidence
                  </span>
                  {aliases.map((alias) => (
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
                      {isRemote(alias) ? (
                        <span className="mr-1 text-amber-600" aria-hidden>
                          ↗
                        </span>
                      ) : null}
                      {EVIDENCE[alias].label}
                    </button>
                  ))}
                  {degraded > 0 ? (
                    <span className="mt-0.5 w-full">
                      <Degraded count={degraded} />
                    </span>
                  ) : null}
                </div>
              ) : null}
              {open && aliases.includes(open) ? <Excerpt alias={open} /> : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Variant B — remote is a door. Chips stay uniform; the strip is sectioned by
// origin, and a remote entry opens a panel that offers the jump. Taking it
// swaps the stream for the other Conversation with the cited message marked.
// ---------------------------------------------------------------------------

function ChipB({ alias, open, onToggle }: { alias: string; open: boolean; onToggle: () => void }) {
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
      <span className="max-w-[16rem] truncate">{EVIDENCE[alias].label}</span>
    </button>
  );
}

function StripSection({
  title,
  aliases,
  open,
  onToggle
}: {
  title: string;
  aliases: string[];
  open: string | null;
  onToggle: (alias: string) => void;
}) {
  if (aliases.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="mr-1 text-[10px] font-semibold uppercase tracking-widest text-neutral-400">
        {title}
      </span>
      {aliases.map((alias) => (
        <button
          key={alias}
          type="button"
          onClick={() => onToggle(alias)}
          className={`rounded-full border px-2 py-0.5 ${
            open === alias
              ? "border-sky-300 bg-sky-100 text-sky-900 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-200"
              : "border-neutral-300 bg-white text-neutral-600 hover:border-neutral-400 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300"
          }`}
        >
          {EVIDENCE[alias].label}
        </button>
      ))}
    </div>
  );
}

function RemoteConversationView({ onBack }: { onBack: () => void }) {
  return (
    <div>
      <div className="mb-4 flex items-center gap-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-[13px] dark:border-amber-900 dark:bg-amber-950/40">
        <button
          type="button"
          onClick={onBack}
          className="shrink-0 rounded border border-amber-400 bg-white px-2 py-0.5 text-[12px] font-medium text-amber-900 dark:border-amber-800 dark:bg-neutral-900 dark:text-amber-200"
        >
          ← Back to Q4 planning
        </button>
        <span className="text-amber-900 dark:text-amber-200">
          You jumped to another Conversation. Nothing was cited from here.
        </span>
      </div>
      <div className={eyebrowClass}>{REMOTE_CONVERSATION.title}</div>
      <div className="message-stream mt-3">
        {REMOTE_CONVERSATION.messages.map((message) => (
          <article
            key={message.id}
            className={`message-bubble ${message.name === "You" ? "user" : "employee"} ${
              message.highlighted ? "rounded-md ring-2 ring-amber-400" : ""
            }`}
            data-status="complete"
          >
            <div className="message-meta">
              <strong>{message.name}</strong>
              <time>{message.time}</time>
            </div>
            <p>{message.text}</p>
          </article>
        ))}
      </div>
    </div>
  );
}

function VariantB() {
  const [open, setOpen] = useState<string | null>(null);
  const [jumped, setJumped] = useState(false);

  if (jumped) {
    return (
      <div>
        <VariantHeader
          letter="B"
          name="Remote is a door"
          answers="Chips are uniform; the strip is sectioned by origin. A remote entry opens a panel that offers the jump — and taking it actually swaps the stream."
        />
        <RemoteConversationView onBack={() => setJumped(false)} />
      </div>
    );
  }

  return (
    <div>
      <VariantHeader
        letter="B"
        name="Remote is a door"
        answers="Chips are uniform; the strip is sectioned by origin. A remote entry opens a panel that offers the jump — and taking it actually swaps the stream."
      />
      <div className="message-stream">
        {MESSAGES.map((message) => {
          const aliases = citationsIn(message);
          const local = aliases.filter((a) => !isRemote(a));
          const remote = aliases.filter(isRemote);
          const degraded = aliases.filter((a) => !isResolved(a)).length;
          return (
            <div key={message.id}>
              <Message message={message}>
                {message.parts.map((part, index) =>
                  "text" in part ? (
                    <span key={index}>{part.text}</span>
                  ) : (
                    <ChipB
                      key={index}
                      alias={part.alias}
                      open={open === part.alias}
                      onToggle={() => setOpen(open === part.alias ? null : part.alias)}
                    />
                  )
                )}
              </Message>
              {aliases.length > 0 ? (
                <div className="-mt-1 mb-4 flex flex-col gap-1.5 rounded-b-md border border-t-0 border-neutral-200 bg-neutral-50 px-3 py-2 text-[12px] dark:border-neutral-800 dark:bg-neutral-900">
                  <StripSection
                    title="This Conversation"
                    aliases={local}
                    open={open}
                    onToggle={(a) => setOpen(open === a ? null : a)}
                  />
                  <StripSection
                    title="From elsewhere"
                    aliases={remote}
                    open={open}
                    onToggle={(a) => setOpen(open === a ? null : a)}
                  />
                  {degraded > 0 ? (
                    <span className="mt-0.5 self-start">
                      <Degraded count={degraded} />
                    </span>
                  ) : null}
                </div>
              ) : null}
              {open && aliases.includes(open) ? (
                <Excerpt
                  alias={open}
                  onOpen={isRemote(open) && isResolved(open) ? () => setJumped(true) : undefined}
                />
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Variant C — remote evidence is heavy, so it is shown rather than hidden.
// Local citations stay chips; anything from elsewhere is lifted out of the
// sentence into a block under the message, quoted in full, with its origin.
// ---------------------------------------------------------------------------

function VariantC() {
  return (
    <div>
      <VariantHeader
        letter="C"
        name="From elsewhere, quoted in full"
        answers="Local citations stay inline chips. A remote one is lifted out of the sentence into a block under the message — quoted in full, never behind a click, with its origin stated."
      />
      <div className="message-stream">
        {MESSAGES.map((message) => {
          const aliases = citationsIn(message);
          const remote = aliases.filter(isRemote);
          const degraded = aliases.filter((a) => !isResolved(a)).length;
          return (
            <div key={message.id}>
              <Message message={message}>
                {message.parts.map((part, index) =>
                  "text" in part ? (
                    <span key={index}>{part.text}</span>
                  ) : isRemote(part.alias) ? (
                    <span
                      key={index}
                      className="mx-0.5 rounded bg-amber-50 px-1 text-[12px] text-amber-800 dark:bg-amber-950/40 dark:text-amber-300"
                    >
                      ↗ {EVIDENCE[part.alias].label}
                    </span>
                  ) : (
                    <span
                      key={index}
                      className="mx-0.5 rounded bg-neutral-100 px-1 text-[12px] text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
                    >
                      ◆ {EVIDENCE[part.alias].label}
                    </span>
                  )
                )}
              </Message>

              {remote.length > 0 ? (
                <div className="mb-3 rounded-md border border-amber-300 bg-amber-50/60 p-3 dark:border-amber-900 dark:bg-amber-950/20">
                  <div className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-amber-700 dark:text-amber-400">
                    From elsewhere
                  </div>
                  <ul className="flex flex-col gap-3">
                    {remote.map((alias) => (
                      <li key={alias}>
                        <div className="mb-1 flex items-center justify-between gap-3">
                          <span className="text-[12px] font-medium text-amber-900 dark:text-amber-200">
                            {EVIDENCE[alias].conversation}
                          </span>
                          <button
                            type="button"
                            className="shrink-0 rounded border border-amber-400 bg-white px-2 py-0.5 text-[12px] text-amber-900 dark:border-amber-800 dark:bg-neutral-900 dark:text-amber-200"
                          >
                            {isResolved(alias) ? "Open ↗" : "Gone"}
                          </button>
                        </div>
                        <blockquote className="border-l-2 border-amber-400 pl-3 text-[13px] leading-relaxed text-neutral-700 italic dark:text-neutral-300">
                          {isResolved(alias)
                            ? EVIDENCE[alias].excerpt
                            : "This Conversation no longer exists, so the Message it is quoting is gone. The reference is kept as written and counted."}
                        </blockquote>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {aliases.length > 0 && degraded > 0 ? (
                <div className="-mt-2 mb-4 text-[12px]">
                  <Degraded count={degraded} />
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

const VARIANTS = ["A", "B", "C"] as const;

const LABELS: Record<string, string> = {
  A: "Origin on the chip",
  B: "Remote is a door",
  C: "From elsewhere, quoted in full"
};

export function HistoryCitationsPrototype({ initialVariant }: { initialVariant: string }) {
  const variant = (VARIANTS as readonly string[]).includes(initialVariant) ? initialVariant : "A";

  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      <p className="mb-1 text-[11px] font-semibold uppercase tracking-widest text-amber-600">
        Prototype — throwaway
      </p>
      <h1 className="mb-1 text-xl font-semibold">
        How a Conversation shows a citation from another Conversation
      </h1>
      <p className="mb-6 max-w-2xl text-[13px] text-neutral-500">
        The same mock conversation in three structurally different readings. It cites a Source, a
        Message from itself, a Message from another Conversation, a confirmed Brief from another
        Conversation, and one Message whose Conversation has been deleted. Flip with{" "}
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
