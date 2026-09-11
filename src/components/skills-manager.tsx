"use client";

import { Braces, Check, LoaderCircle } from "lucide-react";
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
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");
  const [inputs, setInputs] = useState("brief, context");
  const [outputs, setOutputs] = useState("draft");
  const [toolNames, setToolNames] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function createSkill() {
    setBusy(true);
    setError(null);
    try {
      await apiRequest("/api/skills", {
        method: "POST",
        body: JSON.stringify({
          name,
          description,
          instructions,
          inputs: csv(inputs),
          outputs: csv(outputs),
          toolNames
        })
      });
      setName("");
      setDescription("");
      setInstructions("");
      setToolNames([]);
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
        eyebrow={t("skills.eyebrow")}
        title={t("skills.title")}
        description={t("skills.description")}
      />
      {error ? <div className="error-banner">{error}</div> : null}
      <div className="two-column wide-form">
        <section className="panel">
          <div className="panel-title">
            <Braces size={17} />
            <h2>{t("skills.create")}</h2>
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
          <button
            className="button primary"
            onClick={createSkill}
            disabled={busy || !name.trim() || !instructions.trim()}
          >
            {busy ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}
            {t("skills.create")}
          </button>
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
              </article>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
