"use client";

import { ShieldCheck, ShieldEllipsis, Wrench } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { useWorkspace } from "@/components/workspace-provider";

export function ToolsView() {
  const { data } = useWorkspace();
  return (
    <div className="page-content">
      <PageHeader
        eyebrow="Controlled execution"
        title="Tools"
        description="Every external action must exist in this registry before a Skill can use it."
      />
      <div className="card-grid">
        {(data?.tools ?? []).map((tool) => (
          <article key={tool.name} className="panel tool-card">
            <div className="panel-title">
              <Wrench size={17} />
              <h2>{tool.label}</h2>
            </div>
            <p>{tool.description}</p>
            <div className="button-row">
              <span className={`status-pill ${tool.requiresApproval ? "review" : "completed"}`}>
                {tool.requiresApproval ? "Requires approval" : "Read-only"}
              </span>
              <span className="status-pill">
                {tool.replay === "safe" ? "Safe replay" : "No replay"}
              </span>
            </div>
            <div className="tool-schema">
              {tool.requiresApproval ? (
                <ShieldEllipsis size={15} />
              ) : (
                <ShieldCheck size={15} />
              )}
              <code>{tool.name}</code>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
