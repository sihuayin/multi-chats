"use client";

import { Bot, Check, LoaderCircle, Pencil, Power } from "lucide-react";
import { useEffect, useState } from "react";
import { apiRequest } from "@/lib/api";
import { useI18n } from "@/components/i18n-provider";
import { skillLabel } from "@/lib/skill-labels";
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
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [identity, setIdentity] = useState("");
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
          identity: identity || t("employees.defaultIdentity"),
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
    const nextName = window.prompt(t("employees.editNamePrompt"), employee.name);
    if (!nextName) return;
    const nextIdentity = window.prompt(
      t("employees.editIdentityPrompt"),
      employee.identity
    );
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
        eyebrow={t("employees.eyebrow")}
        title={t("employees.title")}
        description={t("employees.description")}
      />
      {error ? <div className="error-banner">{error}</div> : null}
      <div className="two-column wide-form">
        <section className="panel">
          <div className="panel-title">
            <Bot size={17} />
            <h2>{t("employees.create")}</h2>
          </div>
          <label>
            {t("employees.name")}
            <input value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          <label>
            {t("employees.identity")}
            <textarea
              rows={4}
              value={identity}
              placeholder={t("employees.defaultIdentity")}
              onChange={(event) => setIdentity(event.target.value)}
            />
          </label>
          <div className="field-grid">
            <label>
              {t("employees.provider")}
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
              {t("employees.model")}
              <select value={modelId} onChange={(event) => setModelId(event.target.value)}>
                {models.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.name}
                    {model.reasoning
                      ? ` - ${t("employees.reasoning")}`
                      : ""}
                    {model.contextWindow
                      ? ` - ${t("employees.context", {
                          count: Math.round(model.contextWindow / 1000)
                        })}`
                      : ""}
                    {model.maxTokens
                      ? ` - ${t("employees.output", {
                          count: Math.round(model.maxTokens / 1000)
                        })}`
                      : ""}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <fieldset className="choice-fieldset">
            <legend>{t("employees.skills")}</legend>
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
                <span>{skillLabel(t, skill)}</span>
              </label>
            ))}
          </fieldset>
          <button
            className="button primary"
            onClick={createEmployee}
            disabled={busy || !name.trim() || !effectiveProviderId || !modelId}
          >
            {busy ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}
            {t("employees.create")}
          </button>
        </section>

        <section className="panel">
          <div className="panel-title">
            <Bot size={17} />
            <h2>{t("employees.roster")}</h2>
          </div>
          <div className="stack-list">
            {(data?.employees ?? []).map((employee) => (
              <article key={employee.id} className="list-card">
                <div>
                  <strong>{employee.name}</strong>
                  <span>
                    {data?.providers.find(
                      (provider) => provider.id === employee.providerCredentialId
                    )?.label ?? t("common.unknownProvider")}{" "}
                    / {employee.modelId}
                  </span>
                  <small>
                    {employee.skillIds.length} {t("employees.skills")}
                  </small>
                </div>
                <div className="button-row">
                  <button
                    className="icon-button"
                    title={t("employees.edit")}
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
                    {employee.active
                      ? t("employees.disable")
                      : t("employees.enable")}
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
