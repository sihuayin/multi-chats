"use client";

import { ShieldCheck, ShieldEllipsis, Wrench } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { useI18n } from "@/components/i18n-provider";
import { toolDescription, toolLabel } from "@/lib/tool-labels";
import { useWorkspace } from "@/components/workspace-provider";

export function ToolsView() {
  const { data } = useWorkspace();
  const { t } = useI18n();
  return (
    <div className="page-content">
      <PageHeader
        eyebrow={t("tools.eyebrow")}
        title={t("tools.title")}
        description={t("tools.description")}
      />
      <div className="card-grid">
        {(data?.tools ?? []).map((tool) => (
          <article key={tool.name} className="panel tool-card">
            <div className="panel-title">
              <Wrench size={17} />
              <h2>{toolLabel(t, tool)}</h2>
            </div>
            <p>{toolDescription(t, tool)}</p>
            <div className="button-row">
              <span
                className={`status-pill ${
                  tool.risk === "write" ? "review" : "completed"
                }`}
              >
                {tool.risk === "write"
                  ? tool.requiresApproval
                    ? t("tools.sideEffecting")
                    : t("tools.internalWrite")
                  : t("tools.readOnly")}
              </span>
              {tool.requiresApproval ? (
                <span className="status-pill review">
                  {t("tools.requiresApproval")}
                </span>
              ) : null}
              <span className="status-pill">
                {tool.replay === "safe"
                  ? t("tools.safeReplay")
                  : t("tools.noReplay")}
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
            <details className="tool-schema-details">
              <summary>{t("tools.inputSchema")}</summary>
              <pre>{JSON.stringify(tool.inputSchema, null, 2)}</pre>
            </details>
          </article>
        ))}
      </div>
    </div>
  );
}
