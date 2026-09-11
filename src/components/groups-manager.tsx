"use client";

import { Check, LoaderCircle, UsersRound } from "lucide-react";
import { useState } from "react";
import { apiRequest } from "@/lib/api";
import { useWorkspace } from "@/components/workspace-provider";
import { PageHeader } from "@/components/page-header";

export function GroupsManager() {
  const { data, refresh } = useWorkspace();
  const [name, setName] = useState("");
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function createGroup() {
    setBusy(true);
    setError(null);
    try {
      await apiRequest("/api/groups", {
        method: "POST",
        body: JSON.stringify({ name, memberIds })
      });
      setName("");
      setMemberIds([]);
      await refresh();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page-content">
      <PageHeader
        eyebrow="Workspace organization"
        title="Groups"
        description="Groups are reusable member templates. Existing Conversations keep their copied membership."
      />
      {error ? <div className="error-banner">{error}</div> : null}
      <div className="two-column wide-form">
        <section className="panel">
          <div className="panel-title">
            <UsersRound size={17} />
            <h2>Create Group</h2>
          </div>
          <label>
            Group name
            <input value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          <fieldset className="choice-fieldset">
            <legend>Default members</legend>
            {(data?.employees ?? []).map((employee) => (
              <label key={employee.id} className="check-row">
                <input
                  type="checkbox"
                  checked={memberIds.includes(employee.id)}
                  onChange={(event) =>
                    setMemberIds((current) =>
                      event.target.checked
                        ? [...current, employee.id]
                        : current.filter((id) => id !== employee.id)
                    )
                  }
                />
                <span>{employee.name}</span>
                <small>{employee.active ? "active" : "disabled"}</small>
              </label>
            ))}
          </fieldset>
          <button
            className="button primary"
            onClick={createGroup}
            disabled={busy || !name.trim()}
          >
            {busy ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}
            Create Group
          </button>
        </section>
        <section className="panel">
          <div className="panel-title">
            <UsersRound size={17} />
            <h2>Group library</h2>
          </div>
          <div className="stack-list">
            {(data?.groups ?? []).map((group) => (
              <article key={group.id} className="list-card">
                <div>
                  <strong>{group.name}</strong>
                  <span>
                    {group.memberIds
                      .map(
                        (id) =>
                          data?.employees.find((employee) => employee.id === id)
                            ?.name ?? "Unknown"
                      )
                      .join(", ") || "No default members"}
                  </span>
                </div>
              </article>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
