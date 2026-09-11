"use client";

import { Braces, Check, LoaderCircle, Pencil } from "lucide-react";
import { useState } from "react";
import { apiRequest } from "@/lib/api";
import { useI18n } from "@/components/i18n-provider";
import { skillLabel } from "@/lib/skill-labels";
import { toolLabel } from "@/lib/tool-labels";
import { useWorkspace } from "@/components/workspace-provider";
import { PageHeader } from "@/components/page-header";

function csv(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function SkillsManager() {
  const { data, refresh } = useWorkspace();
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");
  const [inputs, setInputs] = useState("brief, context");
  const [outputs, setOutputs] = useState("draft");
  const [toolNames, setToolNames] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function resetForm() {
    setEditingId(null);
    setName("");
    setDescription("");
    setInstructions("");
    setInputs("brief, context");
    setOutputs("draft");
    setToolNames([]);
  }

  async function saveSkill() {
    setBusy(true);
    setError(null);
    try {
      await apiRequest(editingId ? `/api/skills/${editingId}` : "/api/skills", {
        method: editingId ? "PUT" : "POST",
        body: JSON.stringify({
          name,
          description,
          instructions,
          inputs: csv(inputs),
          outputs: csv(outputs),
          toolNames
        })
      });
      resetForm();
      await refresh();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusy(false);
    }
  }

  function editSkill(id: string) {
    const skill = data?.skills.find((item) => item.id === id);
    if (!skill || skill.builtIn) return;
    setEditingId(skill.id);
    setName(skill.name);
    setDescription(skill.description);
    setInstructions(skill.instructions);
    setInputs(skill.inputs.join(", "));
    setOutputs(skill.outputs.join(", "));
    setToolNames(skill.toolNames);
  }

  return (
    <div className="page-content">
      <PageHeader
        eyebrow={t("skills.eyebrow")}
        title={t("skills.title")}
        description={t("skills.description")}
      />
      {error ? <div className="error-banner">{error}</div> : null}
      <div className="two-column wide-form">
        <section className="panel">
          <div className="panel-title">
            <Braces size={17} />
            <h2>
              {editingId ? t("skills.editTitle") : t("skills.create")}
            </h2>
          </div>
          <label>
            {t("skills.name")}
            <input value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          <label>
            {t("skills.descriptionField")}
            <input
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </label>
          <label>
            {t("skills.instructions")}
            <textarea
              rows={5}
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
            />
          </label>
          <div className="field-grid">
            <label>
              {t("skills.inputs")}
              <input value={inputs} onChange={(event) => setInputs(event.target.value)} />
            </label>
            <label>
              {t("skills.outputs")}
              <input value={outputs} onChange={(event) => setOutputs(event.target.value)} />
            </label>
          </div>
          <fieldset className="choice-fieldset">
            <legend>{t("skills.allowedTools")}</legend>
            {(data?.tools ?? []).map((tool) => (
              <label key={tool.name} className="check-row">
                <input
                  type="checkbox"
                  checked={toolNames.includes(tool.name)}
                  onChange={(event) =>
                    setToolNames((current) =>
                      event.target.checked
                        ? [...current, tool.name]
                        : current.filter((name) => name !== tool.name)
                    )
                  }
                />
                <span>{toolLabel(t, tool)}</span>
                <small>{tool.requiresApproval ? "approval" : tool.risk}</small>
              </label>
            ))}
          </fieldset>
          <div className="button-row">
            <button
              className="button primary"
              onClick={saveSkill}
              disabled={busy || !name.trim() || !instructions.trim()}
            >
              {busy ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}
              {editingId ? t("skills.saveChanges") : t("skills.create")}
            </button>
            {editingId ? (
              <button className="button quiet" onClick={resetForm}>
                {t("skills.cancelEdit")}
              </button>
            ) : null}
          </div>
        </section>

        <section className="panel">
          <div className="panel-title">
            <Braces size={17} />
            <h2>{t("skills.library")}</h2>
          </div>
          <div className="stack-list">
            {(data?.skills ?? []).map((skill) => (
              <article key={skill.id} className="list-card">
                <div>
                  <strong>{skillLabel(t, skill)}</strong>
                  <span>{skill.description}</span>
                  <small>
                    {skill.builtIn
                      ? t("common.builtIn")
                      : t("common.custom")}{" "}
                    /{" "}
                    {skill.toolNames.length} Tools
                  </small>
                </div>
                {!skill.builtIn ? (
                  <button
                    className="icon-button"
                    title={t("skills.editTitle")}
                    onClick={() => editSkill(skill.id)}
                    disabled={busy}
                  >
                    <Pencil size={15} />
                  </button>
                ) : null}
              </article>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
