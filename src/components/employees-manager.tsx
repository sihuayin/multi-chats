"use client";

import {
  ArrowDown,
  ArrowUp,
  Bot,
  Check,
  LoaderCircle,
  Pencil,
  Plus,
  Power,
  Trash2
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { apiRequest } from "@/lib/api";
import { useI18n } from "@/components/i18n-provider";
import { skillLabel } from "@/lib/skill-labels";
import { useWorkspace } from "@/components/workspace-provider";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { ModelTargetConfig } from "@/server/domain/types";

type ModelSummary = {
  id: string;
  name: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning: boolean;
  supportsStructuredOutput?: boolean;
};

function FallbackTargetEditor(input: {
  target: ModelTargetConfig;
  providers: Array<{ id: string; label: string }>;
  index: number;
  count: number;
  disabled: boolean;
  labels: {
    provider: string;
    model: string;
    remove: string;
    moveUp: string;
    moveDown: string;
  };
  onChange: (target: ModelTargetConfig) => void;
  onMove: (offset: -1 | 1) => void;
  onRemove: () => void;
}) {
  const [models, setModels] = useState<ModelSummary[]>([]);

  useEffect(() => {
    if (!input.target.providerCredentialId) return;
    let cancelled = false;
    apiRequest<ModelSummary[]>(
      `/api/providers/${input.target.providerCredentialId}/models`
    )
      .then((items) => {
        if (!cancelled) {
          setModels(
            items.filter(
              (item) => item.supportsStructuredOutput !== false
            )
          );
        }
      })
      .catch(() => {
        if (!cancelled) setModels([]);
      });
    return () => {
      cancelled = true;
    };
  }, [input.target.providerCredentialId]);

  return (
    <div className="fallback-target-row">
      <label>
        {input.labels.provider}
        <select
          value={input.target.providerCredentialId}
          disabled={input.disabled}
          onChange={(event) =>
            input.onChange({
              providerCredentialId: event.target.value,
              modelId: ""
            })
          }
        >
          {input.providers.map((provider) => (
            <option key={provider.id} value={provider.id}>
              {provider.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        {input.labels.model}
        <select
          value={input.target.modelId}
          disabled={input.disabled}
          onChange={(event) =>
            input.onChange({
              ...input.target,
              modelId: event.target.value
            })
          }
        >
          <option value="">-</option>
          {models.map((model) => (
            <option key={model.id} value={model.id}>
              {model.name}
            </option>
          ))}
        </select>
      </label>
      <div className="button-row">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          title={input.labels.moveUp}
          disabled={input.disabled || input.index === 0}
          onClick={() => input.onMove(-1)}
        >
          <ArrowUp size={15} />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          title={input.labels.moveDown}
          disabled={input.disabled || input.index === input.count - 1}
          onClick={() => input.onMove(1)}
        >
          <ArrowDown size={15} />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          title={input.labels.remove}
          disabled={input.disabled}
          onClick={input.onRemove}
        >
          <Trash2 size={15} />
        </Button>
      </div>
    </div>
  );
}

export function EmployeesManager() {
  const { data, refresh } = useWorkspace();
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [identity, setIdentity] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [providerId, setProviderId] = useState("");
  const [modelId, setModelId] = useState("");
  const [fallbackTargets, setFallbackTargets] = useState<
    ModelTargetConfig[]
  >([]);
  const [skillIds, setSkillIds] = useState<string[]>([]);
  const [models, setModels] = useState<ModelSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const formRef = useRef<HTMLElement | null>(null);

  const effectiveProviderId = providerId || data?.providers[0]?.id || "";
  const fallbackTargetsValid = fallbackTargets.every(
    (target) =>
      Boolean(target.providerCredentialId) && Boolean(target.modelId)
  );

  useEffect(() => {
    if (!effectiveProviderId) return;
    let cancelled = false;
    apiRequest<ModelSummary[]>(`/api/providers/${effectiveProviderId}/models`)
      .then((items) => {
        if (cancelled) return;
        const availableModels = items.filter(
          (item) => item.supportsStructuredOutput !== false
        );
        setModels(availableModels);
        setModelId((current) =>
          availableModels.some((item) => item.id === current)
            ? current
            : availableModels[0]?.id ?? ""
        );
      })
      .catch((nextError) => {
        if (!cancelled) setError(nextError instanceof Error ? nextError.message : String(nextError));
      });
    return () => {
      cancelled = true;
    };
  }, [effectiveProviderId]);

  function resetForm() {
    setEditingId(null);
    setName("");
    setIdentity("");
    setFallbackTargets([]);
    setSkillIds([]);
  }

  async function saveEmployee() {
    setBusy(true);
    setError(null);
    try {
      const wasEditing = Boolean(editingId);
      await apiRequest(editingId ? `/api/employees/${editingId}` : "/api/employees", {
        method: editingId ? "PUT" : "POST",
        body: JSON.stringify({
          name,
          identity: identity || t("employees.defaultIdentity"),
          providerCredentialId: effectiveProviderId,
          modelId,
          fallbackTargets,
          skillIds,
          active:
            data?.employees.find((employee) => employee.id === editingId)
              ?.active ?? true
        })
      });
      resetForm();
      toast.success(
        wasEditing ? t("employees.updated") : t("employees.created")
      );
      await refresh();
    } catch (nextError) {
      const message =
        nextError instanceof Error ? nextError.message : String(nextError);
      setError(message);
      toast.error(message);
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
      const message =
        nextError instanceof Error ? nextError.message : String(nextError);
      setError(message);
      toast.error(message);
    } finally {
      setBusy(false);
    }
  }

  function editEmployee(id: string) {
    const employee = data?.employees.find((item) => item.id === id);
    if (!employee) return;
    setEditingId(employee.id);
    setName(employee.name);
    setIdentity(employee.identity);
    setProviderId(employee.providerCredentialId);
    setModelId(employee.modelId);
    setFallbackTargets(employee.fallbackTargets ?? []);
    setSkillIds(employee.skillIds);
    setError(null);
    requestAnimationFrame(() =>
      formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })
    );
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
        <section
          id="employee-form"
          ref={formRef}
          className="panel"
          data-editing={editingId ? "true" : "false"}
        >
          <div className="panel-title">
            <Bot size={17} />
            <h2>
              {editingId ? t("employees.editTitle") : t("employees.create")}
            </h2>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="employee-name">{t("employees.name")}</Label>
            <Input
              id="employee-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="employee-identity">{t("employees.identity")}</Label>
            <Textarea
              id="employee-identity"
              rows={4}
              value={identity}
              placeholder={t("employees.defaultIdentity")}
              onChange={(event) => setIdentity(event.target.value)}
            />
          </div>
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
          <div className="fallback-targets">
            <div className="panel-title">
              <span>{t("employees.fallbackTargets")}</span>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={busy || fallbackTargets.length >= 4}
                onClick={() =>
                  setFallbackTargets((current) => [
                    ...current,
                    {
                      providerCredentialId: effectiveProviderId,
                      modelId: ""
                    }
                  ])
                }
              >
                <Plus size={15} />
                {t("employees.addFallback")}
              </Button>
            </div>
            <p className="field-hint">
              {t("employees.fallbackHint")}
            </p>
            {fallbackTargets.map((target, index) => (
              <FallbackTargetEditor
                key={`${index}-${target.providerCredentialId}`}
                target={target}
                providers={data?.providers ?? []}
                index={index}
                count={fallbackTargets.length}
                disabled={busy}
                labels={{
                  provider: t("employees.provider"),
                  model: t("employees.model"),
                  remove: t("employees.removeFallback"),
                  moveUp: t("employees.moveFallbackUp"),
                  moveDown: t("employees.moveFallbackDown")
                }}
                onChange={(nextTarget) =>
                  setFallbackTargets((current) =>
                    current.map((item, itemIndex) =>
                      itemIndex === index ? nextTarget : item
                    )
                  )
                }
                onMove={(offset) =>
                  setFallbackTargets((current) => {
                    const next = [...current];
                    const destination = index + offset;
                    if (destination < 0 || destination >= next.length) {
                      return current;
                    }
                    [next[index], next[destination]] = [
                      next[destination],
                      next[index]
                    ];
                    return next;
                  })
                }
                onRemove={() =>
                  setFallbackTargets((current) =>
                    current.filter(
                      (_, itemIndex) => itemIndex !== index
                    )
                  )
                }
              />
            ))}
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
          <div className="button-row">
            <Button
              onClick={saveEmployee}
              disabled={
                busy ||
                !name.trim() ||
                !effectiveProviderId ||
                !modelId ||
                !fallbackTargetsValid
              }
            >
              {busy ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}
              {editingId
                ? t("employees.saveChanges")
                : t("employees.create")}
            </Button>
            {editingId ? (
              <Button variant="ghost" onClick={resetForm}>
                {t("employees.cancelEdit")}
              </Button>
            ) : null}
          </div>
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
                  {employee.fallbackTargets?.length ? (
                    <small>
                      {t("employees.fallbackCount", {
                        count: employee.fallbackTargets.length
                      })}
                    </small>
                  ) : null}
                </div>
                <div className="button-row">
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-pressed={editingId === employee.id}
                    title={t("employees.edit")}
                    onClick={() => editEmployee(employee.id)}
                    disabled={busy}
                  >
                    <Pencil size={15} />
                  </Button>
                  <Button
                    variant={employee.active ? "ghost" : "secondary"}
                    onClick={() => toggleEmployee(employee.id, employee.active)}
                    disabled={busy}
                  >
                    <Power size={15} />
                    {employee.active
                      ? t("employees.disable")
                      : t("employees.enable")}
                  </Button>
                </div>
              </article>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
