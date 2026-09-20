"use client";

/**
 * THROWAWAY PROTOTYPE — the egress allowlist surface.
 *
 * Question: where does the allowlist live, how is an entry expressed, how does a
 * refusal read, and is "allowed by the allowlist" distinguishable from "reachable
 * because public"?
 *
 * Three structurally different answers, switchable with ?variant=A|B|C.
 * No persistence, no backend, no i18n — fake data lives in memory only.
 * Not part of the product.
 */

import { useMemo, useState } from "react";
import { Globe, Lock, Plus, ShieldAlert, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PrototypeSwitcher } from "@/components/prototype/prototype-switcher";

/* ---------------------------------------------------------------- fake data */

type ProtoTool = {
  name: string;
  label: string;
  kind: "builtin" | "registered";
  method: "—" | "GET" | "POST";
  approval: boolean;
  /** "public" = any public host; otherwise the exact host(+port) it calls. */
  target: string;
};

const TOOLS: ProtoTool[] = [
  { name: "current_time", label: "Current time", kind: "builtin", method: "—", approval: false, target: "none" },
  { name: "fetch_url", label: "Fetch URL", kind: "builtin", method: "GET", approval: false, target: "public" },
  { name: "post_webhook", label: "Post webhook", kind: "builtin", method: "POST", approval: true, target: "public" },
  { name: "update_task", label: "Update Task", kind: "builtin", method: "—", approval: false, target: "none" },
  { name: "attach_artifact", label: "Attach artifact", kind: "builtin", method: "—", approval: false, target: "none" },
  { name: "home_status", label: "Home Assistant status", kind: "registered", method: "GET", approval: false, target: "nas.local:8123" },
  { name: "crm_lookup", label: "Internal CRM lookup", kind: "registered", method: "POST", approval: true, target: "10.0.0.42:8080" },
];

const INITIAL_ALLOWED = ["nas.local:8123", "10.0.0.42:8080"];

/** Mirrors the checks in src/server/security/ssrf.ts so the prototype refuses
 *  the same things the shipped guard does. */
function isPrivateHost(entry: string): boolean {
  const bare = entry.split(":")[0].toLowerCase();
  if (bare === "localhost" || bare === "::1" || bare.endsWith(".local")) return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(bare)) {
    const [a, b] = bare.split(".").map(Number);
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    );
  }
  return false;
}

type Parsed = { ok: true; entry: string; note?: string } | { ok: false; reason: string };

function parseHostEntry(raw: string, existing: string[]): Parsed {
  const value = raw.trim();
  if (!value) return { ok: false, reason: "Enter a host." };
  if (value.startsWith("http://") || value.startsWith("https://")) {
    return { ok: false, reason: "Enter a host, not a URL — drop the scheme and any path." };
  }
  if (/[/*]/.test(value)) {
    return { ok: false, reason: "Exact hosts only. Ranges and wildcards are not supported." };
  }
  const [host, port] = value.split(":");
  if (!host) return { ok: false, reason: "Enter a host." };
  if (port !== undefined && !/^\d+$/.test(port)) {
    return { ok: false, reason: "A port must be a number, or leave it off for the default." };
  }
  const entry = port ? `${host.toLowerCase()}:${port}` : host.toLowerCase();
  if (existing.includes(entry)) return { ok: false, reason: "Already allowed." };
  if (!isPrivateHost(entry)) {
    return {
      ok: true,
      entry,
      note: "This is a public host. It is already reachable without being listed.",
    };
  }
  return { ok: true, entry };
}

const toolsFor = (target: string) => TOOLS.filter((tool) => tool.target === target);

/** The refusal a Run would show today, rewritten to be actionable. */
function RefusalSample({ host }: { host: string }) {
  return (
    <div className="error-banner" style={{ display: "grid", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <ShieldAlert size={15} />
        <strong>home_status was refused</strong>
      </div>
      <div>
        <code>{host}</code> is a private address and is not on this workspace&apos;s
        allowlist, so the call never left the server.
      </div>
      <div className="button-row">
        <Button size="sm" variant="secondary" type="button">
          Allow {host}
        </Button>
        <Button size="sm" variant="ghost" type="button">
          Keep it refused
        </Button>
      </div>
    </div>
  );
}

function ReachBadge({ target }: { target: string }) {
  if (target === "none") return <span className="status-pill">No network</span>;
  if (target === "public") {
    return (
      <span className="status-pill completed">
        <Globe size={12} /> Any public host
      </span>
    );
  }
  return (
    <span className="status-pill review">
      <Lock size={12} /> {target}
    </span>
  );
}

/* ------------------------------------------------------------ variant A */
/* The allowlist is a section of the Tools page. Reach is a property of a Tool,
   so it is read and edited next to the Tool cards. */

export function VariantA() {
  const [allowed, setAllowed] = useState(INITIAL_ALLOWED);
  const [draft, setDraft] = useState("");
  const parsed = useMemo(() => parseHostEntry(draft, allowed), [draft, allowed]);

  return (
    <div className="page-content">
      <div className="page-header">
        <span className="eyebrow">Controlled execution</span>
        <h1>Tools</h1>
        <p className="muted">
          Every external action is registered here before a Skill can call it.
        </p>
      </div>

      <div className="card-grid">
        {TOOLS.map((tool) => (
          <article key={tool.name} className="panel tool-card">
            <div className="panel-title">
              <h2>{tool.label}</h2>
            </div>
            <div className="button-row">
              <Badge variant="secondary">
                {tool.kind === "builtin" ? "Built-in" : "Registered"}
              </Badge>
              <Badge variant="secondary">{tool.method}</Badge>
              {tool.approval ? <Badge variant="secondary">Needs approval</Badge> : null}
            </div>
            <div className="tool-schema">
              <ReachBadge target={tool.target} />
              <code>{tool.name}</code>
            </div>
          </article>
        ))}
      </div>

      <section className="panel" style={{ marginTop: 24 }}>
        <div className="panel-title">
          <Lock size={16} />
          <h2>Network reach</h2>
        </div>
        <p className="muted">
          Public hosts are reachable without being listed. Private hosts — anything
          loopback, link-local, RFC1918, or <code>.local</code> — are refused unless
          they appear below.
        </p>
        <ul className="stack-list">
          {allowed.map((entry) => (
            <li key={entry} className="list-card" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span>
                <code>{entry}</code>{" "}
                <span className="muted">
                  used by {toolsFor(entry).map((tool) => tool.name).join(", ") || "nothing yet"}
                </span>
              </span>
              <Button
                size="sm"
                variant="ghost"
                type="button"
                onClick={() => setAllowed(allowed.filter((item) => item !== entry))}
              >
                <Trash2 size={14} />
              </Button>
            </li>
          ))}
        </ul>
        <div className="button-row" style={{ marginTop: 12 }}>
          <Input
            value={draft}
            placeholder="nas.local:8123"
            onChange={(event) => setDraft(event.target.value)}
          />
          <Button
            type="button"
            disabled={!parsed.ok}
            onClick={() => {
              if (parsed.ok) {
                setAllowed([...allowed, parsed.entry]);
                setDraft("");
              }
            }}
          >
            <Plus size={15} /> Allow host
          </Button>
        </div>
        <p className="muted" style={{ marginTop: 8 }}>
          {draft
            ? parsed.ok
              ? (parsed.note ?? "Private host. Add it to let your Employees reach it.")
              : parsed.reason
            : "Exact host, optional port. No ranges, no wildcards."}
        </p>
        <div style={{ marginTop: 16 }}>
          <RefusalSample host="192.168.1.10" />
        </div>
      </section>
    </div>
  );
}

/* ------------------------------------------------------------ variant B */
/* Reach is workspace policy, not Tool configuration. It lives on the Workspace
   settings surface — which does not exist yet, and which this feature would force
   into being (the discussion budget defaults and the re-rank toggle are already
   API-only today). */

const SETTINGS_SECTIONS = [
  ["egress", "Network egress"],
  ["budget", "Discussion budgets"],
  ["retrieval", "Source retrieval"],
] as const;

export function VariantB() {
  const [allowed, setAllowed] = useState(INITIAL_ALLOWED);
  const [draft, setDraft] = useState("");
  const [section, setSection] = useState<string>("egress");
  const parsed = useMemo(() => parseHostEntry(draft, allowed), [draft, allowed]);

  return (
    <div className="page-content">
      <div className="page-header">
        <span className="eyebrow">Workspace</span>
        <h1>Settings</h1>
        <p className="muted">
          Policy for the whole Workspace. The Tools page reads this; it does not own it.
        </p>
      </div>

      <div className="two-column">
        <nav className="panel" style={{ alignSelf: "start", display: "grid", gap: 4 }}>
          {SETTINGS_SECTIONS.map(([key, label]) => (
            <button
              key={key}
              type="button"
              className={`nav-item ${section === key ? "active" : ""}`}
              onClick={() => setSection(key)}
              style={{ textAlign: "left" }}
            >
              {label}
            </button>
          ))}
        </nav>

        <div style={{ display: "grid", gap: 20 }}>
          {section !== "egress" ? (
            <section className="panel">
              <div className="panel-title">
                <h2>
                  {SETTINGS_SECTIONS.find(([key]) => key === section)?.[1]}
                </h2>
              </div>
              <p className="muted">
                Not part of this prototype. Shown so you can see what else would
                share this surface — these two are already settable over the API and
                have no UI at all.
              </p>
            </section>
          ) : (
            <>
              <section className="panel">
                <div className="panel-title">
                  <Lock size={16} />
                  <h2>Private hosts this Workspace may reach</h2>
                </div>
                <p className="muted">
                  Public hosts are always reachable. A Tool that calls a private host
                  is refused until that host is listed here.
                </p>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr className="muted">
                      <th style={{ textAlign: "left" }}>Host</th>
                      <th style={{ textAlign: "left" }}>Port</th>
                      <th style={{ textAlign: "left" }}>Used by</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {allowed.map((entry) => {
                      const [host, port] = entry.split(":");
                      return (
                        <tr key={entry}>
                          <td><code>{host}</code></td>
                          <td>{port ?? "default"}</td>
                          <td className="muted">
                            {toolsFor(entry).map((tool) => tool.name).join(", ") || "—"}
                          </td>
                          <td style={{ textAlign: "right" }}>
                            <Button
                              size="sm"
                              variant="ghost"
                              type="button"
                              onClick={() => setAllowed(allowed.filter((item) => item !== entry))}
                            >
                              Remove
                            </Button>
                          </td>
                        </tr>
                      );
                    })}
                    {allowed.length === 0 ? (
                      <tr>
                        <td colSpan={4} className="muted">
                          No private hosts allowed. Employees can reach the public internet only.
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </section>

              <section className="panel">
                <div className="panel-title">
                  <Plus size={16} />
                  <h2>Allow a host</h2>
                </div>
                <div style={{ display: "grid", gap: 6, maxWidth: 420 }}>
                  <label htmlFor="host-entry" className="muted">
                    Host, with an optional port
                  </label>
                  <Input
                    id="host-entry"
                    value={draft}
                    placeholder="nas.local:8123"
                    onChange={(event) => setDraft(event.target.value)}
                  />
                  <span className="muted">
                    {draft
                      ? parsed.ok
                        ? (parsed.note ?? "Private host. Saving lets any Tool reach it.")
                        : parsed.reason
                      : "An exact host. Ranges and wildcards are not accepted."}
                  </span>
                  <div className="button-row">
                    <Button
                      type="button"
                      disabled={!parsed.ok}
                      onClick={() => {
                        if (parsed.ok) {
                          setAllowed([...allowed, parsed.entry]);
                          setDraft("");
                        }
                      }}
                    >
                      Allow host
                    </Button>
                  </div>
                </div>
                <div style={{ marginTop: 20 }}>
                  <RefusalSample host="192.168.1.10" />
                </div>
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ variant C */
/* Start from the question an operator actually has — "what can my Employees
   touch?" — and answer it as a reach matrix. The allowlist is a consequence of
   the answer, not a form you fill in. */

export function VariantC() {
  const [allowed, setAllowed] = useState(INITIAL_ALLOWED);
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);
  const parsed = useMemo(() => parseHostEntry(draft, allowed), [draft, allowed]);

  const refused = ["192.168.1.10:8080"];
  const rows = [
    ...allowed.map((entry) => ({ entry, reach: "allowlisted" as const })),
    ...refused.map((entry) => ({ entry, reach: "refused" as const })),
  ];

  return (
    <div className="page-content">
      <div className="page-header">
        <span className="eyebrow">Reachability</span>
        <h1>What your Employees can touch</h1>
        <p className="muted">
          Your Employees can reach the public internet, {" "}
          {allowed.length === 1 ? "one private host" : `${allowed.length} private hosts`}, and
          nothing else.
        </p>
      </div>

      <section className="panel">
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr className="muted">
              <th style={{ textAlign: "left" }}>Target</th>
              <th style={{ textAlign: "left" }}>Reach</th>
              <th style={{ textAlign: "left" }}>Tools that can reach it</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><Globe size={14} /> Any public host</td>
              <td><span className="status-pill completed">Open</span></td>
              <td className="muted">
                {TOOLS.filter((tool) => tool.target === "public")
                  .map((tool) => tool.name)
                  .join(", ")}
              </td>
            </tr>
            {rows.map(({ entry, reach }) => (
              <tr key={entry} style={reach === "refused" ? { opacity: 0.55 } : undefined}>
                <td><Lock size={14} /> <code>{entry}</code></td>
                <td>
                  {reach === "allowlisted" ? (
                    <span className="status-pill review">Allowed</span>
                  ) : (
                    <span className="status-pill blocked">Refused</span>
                  )}
                </td>
                <td className="muted">
                  {reach === "allowlisted" ? (
                    toolsFor(entry).map((tool) => tool.name).join(", ") || "— nothing yet"
                  ) : (
                    <em>home_status attempted this</em>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <div style={{ marginTop: 16 }}>
          {adding ? (
            <div style={{ display: "grid", gap: 8, maxWidth: 460 }}>
              <Input
                autoFocus
                value={draft}
                placeholder="nas.local:8123"
                onChange={(event) => setDraft(event.target.value)}
              />
              <span className="muted">
                {draft
                  ? parsed.ok
                    ? (parsed.note ?? "Adding this makes it reachable by any Tool.")
                    : parsed.reason
                  : "Exact host, optional port."}
              </span>
              <div className="button-row">
                <Button
                  type="button"
                  disabled={!parsed.ok}
                  onClick={() => {
                    if (parsed.ok) {
                      setAllowed([...allowed, parsed.entry]);
                      setDraft("");
                      setAdding(false);
                    }
                  }}
                >
                  Allow
                </Button>
                <Button type="button" variant="ghost" onClick={() => setAdding(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <Button type="button" variant="secondary" onClick={() => setAdding(true)}>
              <Plus size={15} /> Allow a private host
            </Button>
          )}
        </div>
      </section>

      <section className="panel" style={{ marginTop: 20 }}>
        <div className="panel-title">
          <ShieldAlert size={16} />
          <h2>Refused calls</h2>
        </div>
        <p className="muted">
          One call is being refused right now. A refusal is visible here and in the Run
          timeline; nothing else changes.
        </p>
        <RefusalSample host="192.168.1.10:8080" />
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ shell */

const VARIANTS = ["A", "B", "C"];
const LABELS: Record<string, string> = {
  A: "Tools page section",
  B: "Workspace settings",
  C: "Reach matrix",
};

export function EgressPrototype({ initialVariant }: { initialVariant: string }) {
  const variant = VARIANTS.includes(initialVariant) ? initialVariant : "A";
  return (
    <>
      {variant === "A" ? <VariantA /> : null}
      {variant === "B" ? <VariantB /> : null}
      {variant === "C" ? <VariantC /> : null}
      <PrototypeSwitcher variants={VARIANTS} labels={LABELS} current={variant} />
    </>
  );
}
