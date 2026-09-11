"use client";

import { Bot, Check, LoaderCircle, Pencil, Power } from "lucide-react";
import { useEffect, useState } from "react";
import { apiRequest } from "@/lib/api";
import { useWorkspace } from "@/components/workspace-provider";
import { PageHeader } from "@/components/page-header";

type ModelSummary = {
  id: string;
  name: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning: boolean;
};

export function EmployeesManager() {
  const { data, refresh } = useWorkspace();
  const [name, setName] = useState("");
  const [identity, setIdentity] = useState(
    "You are a focused analyst. Be precise and surface uncertainty."
  );
  const [providerId, setProviderId] = useState("");
  const [modelId, setModelId] = useState("");
  const [skillIds, setSkillIds] = useState<string[]>([]);
  const [models, setModels] = useState<ModelSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const effectiveProviderId = providerId || data?.providers[0]?.id || "";

  useEffect(() => {
    if (!effectiveProviderId) return;
    let cancelled = false;
    apiRequest<ModelSummary[]>(`/api/providers/${effectiveProviderId}/models`)
      .then((items) => {
        if (cancelled) return;
        setModels(items);
        setModelId((current) =>
          items.some((item) => item.id === current) ? current : items[0]?.id ?? ""
        );
      })
      .catch((nextError) => {
        if (!cancelled) setError(nextError instanceof Error ? nextError.message : String(nextError));
      });
    return () => {
      cancelled = true;
    };
  }, [effectiveProviderId]);

  async function createEmployee() {
    setBusy(true);
    setError(null);
    try {
      await apiRequest("/api/employees", {
        method: "POST",
        body: JSON.stringify({
          name,
          identity,
          providerCredentialId: effectiveProviderId,
          modelId,
          skillIds,
          active: true
        })
      });
      setName("");
      setSkillIds([]);
      await refresh();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusy(false);
    }
  }

  async function toggleEmployee(id: string, active: boolean) {
    const employee = data?.employees.find((item) => item.id === id);
    if (!employee) return;
    setBusy(true);
    try {
      await apiRequest(`/api/employees/${id}`, {
        method: "PUT",
        body: JSON.stringify({ ...employee, active: !active })
      });
      await refresh();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusy(false);
    }
  }

  async function editEmployee(id: string) {
    const employee = data?.employees.find((item) => item.id === id);
    if (!employee) return;
    const nextName = window.prompt("Employee name", employee.name);
    if (!nextName) return;
    const nextIdentity = window.prompt("Employee identity", employee.identity);
    if (!nextIdentity) return;
    setBusy(true);
    try {
      await apiRequest(`/api/employees/${id}`, {
        method: "PUT",
        body: JSON.stringify({
          ...employee,
          name: nextName,
          identity: nextIdentity
        })
      });
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
        eyebrow="Workspace configuration"
        title="Employees"
        description="Each Employee has one model configuration and a reviewable set of Skills."
      />
      {error ? <div className="error-banner">{error}</div> : null}
      <div className="two-column wide-form">
        <section className="panel">
          <div className="panel-title">
            <Bot size={17} />
            <h2>Create Employee</h2>
          </div>
          <label>
            Name
            <input value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          <label>
            Identity
            <textarea
              rows={4}
              value={identity}
              onChange={(event) => setIdentity(event.target.value)}
            />
          </label>
          <div className="field-grid">
            <label>
              Provider
              <select
                value={effectiveProviderId}
                onChange={(event) => setProviderId(event.target.value)}
              >
                {(data?.providers ?? []).map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Model
              <select value={modelId} onChange={(event) => setModelId(event.target.value)}>
                {models.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.name}
                    {model.reasoning ? " - reasoning" : ""}
                    {model.contextWindow
                      ? ` - ${Math.round(model.contextWindow / 1000)}k context`
                      : ""}
                    {model.maxTokens
                      ? ` - ${Math.round(model.maxTokens / 1000)}k output`
                      : ""}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <fieldset className="choice-fieldset">
            <legend>Skills</legend>
            {(data?.skills ?? []).map((skill) => (
              <label key={skill.id} className="check-row">
                <input
                  type="checkbox"
                  checked={skillIds.includes(skill.id)}
                  onChange={(event) =>
                    setSkillIds((current) =>
                      event.target.checked
                        ? [...current, skill.id]
                        : current.filter((id) => id !== skill.id)
                    )
                  }
                />
                <span>{skill.name}</span>
              </label>
            ))}
          </fieldset>
          <button
            className="button primary"
            onClick={createEmployee}
            disabled={busy || !name.trim() || !effectiveProviderId || !modelId}
          >
            {busy ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}
            Create Employee
          </button>
        </section>

        <section className="panel">
          <div className="panel-title">
            <Bot size={17} />
            <h2>Employee roster</h2>
          </div>
          <div className="stack-list">
            {(data?.employees ?? []).map((employee) => (
              <article key={employee.id} className="list-card">
                <div>
                  <strong>{employee.name}</strong>
                  <span>
                    {data?.providers.find(
                      (provider) => provider.id === employee.providerCredentialId
                    )?.label ?? "Unknown provider"}{" "}
                    / {employee.modelId}
                  </span>
                  <small>{employee.skillIds.length} Skills</small>
                </div>
                <div className="button-row">
                  <button
                    className="icon-button"
                    title="Edit Employee"
                    onClick={() => editEmployee(employee.id)}
                    disabled={busy}
                  >
                    <Pencil size={15} />
                  </button>
                  <button
                    className={employee.active ? "button quiet" : "button secondary"}
                    onClick={() => toggleEmployee(employee.id, employee.active)}
                    disabled={busy}
                  >
                    <Power size={15} />
                    {employee.active ? "Disable" : "Enable"}
                  </button>
                </div>
              </article>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
