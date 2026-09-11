"use client";

import { Braces, Check, LoaderCircle } from "lucide-react";
import { useState } from "react";
import { apiRequest } from "@/lib/api";
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
        eyebrow="Workspace configuration"
        title="Skills"
        description="Skills are declarative instructions and Tool allowlists. They never contain executable code."
      />
      {error ? <div className="error-banner">{error}</div> : null}
      <div className="two-column wide-form">
        <section className="panel">
          <div className="panel-title">
            <Braces size={17} />
            <h2>Create custom Skill</h2>
          </div>
          <label>
            Name
            <input value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          <label>
            Description
            <input
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </label>
          <label>
            Instructions
            <textarea
              rows={5}
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
            />
          </label>
          <div className="field-grid">
            <label>
              Inputs
              <input value={inputs} onChange={(event) => setInputs(event.target.value)} />
            </label>
            <label>
              Outputs
              <input value={outputs} onChange={(event) => setOutputs(event.target.value)} />
            </label>
          </div>
          <fieldset className="choice-fieldset">
            <legend>Allowed Tools</legend>
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
                <span>{tool.label}</span>
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
            Create Skill
          </button>
        </section>

        <section className="panel">
          <div className="panel-title">
            <Braces size={17} />
            <h2>Skill library</h2>
          </div>
          <div className="stack-list">
            {(data?.skills ?? []).map((skill) => (
              <article key={skill.id} className="list-card">
                <div>
                  <strong>{skill.name}</strong>
                  <span>{skill.description}</span>
                  <small>
                    {skill.builtIn ? "Built-in" : "Custom"} /{" "}
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
