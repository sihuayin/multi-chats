"use client";

import { useState } from "react";
import {
  Check,
  Pencil,
  Plus,
  ShieldCheck,
  ShieldEllipsis,
  Trash2,
  Wrench
} from "lucide-react";
import { toast } from "sonner";
import { apiRequest } from "@/lib/api";
import { PageHeader } from "@/components/page-header";
import { useI18n } from "@/components/i18n-provider";
import { toolDescription, toolLabel } from "@/lib/tool-labels";
import { useWorkspace } from "@/components/workspace-provider";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { PublicTool } from "@/lib/workspace-view";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
const DEFAULT_SCHEMA = '{\n  "type": "object",\n  "properties": {}\n}';

/**
 * The two coherent presets. There is no default: the choice between them is the
 * one thing that decides whether an Employee can act without the operator.
 */
type Preset = "read" | "side";

function presetValues(preset: Preset) {
  return preset === "read"
    ? { risk: "read" as const, requiresApproval: false, replay: "safe" as const }
    : { risk: "write" as const, requiresApproval: true, replay: "never" as const };
}

function presetOf(tool: PublicTool): Preset {
  return tool.requiresApproval ? "side" : "read";
}

function formatHeaders(headers?: Record<string, string>): string {
  return Object.entries(headers ?? {})
    .map(([name, value]) => `${name}: ${value}`)
    .join("\n");
}

function parseHeaders(text: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const at = trimmed.indexOf(":");
    if (at === -1) throw new Error(`Header "${trimmed}" needs a colon`);
    headers[trimmed.slice(0, at).trim()] = trimmed.slice(at + 1).trim();
  }
  return headers;
}

export function ToolsView() {
  const { data, refresh } = useWorkspace();
  const { t } = useI18n();

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<PublicTool | null>(null);
  const [deleting, setDeleting] = useState<PublicTool | null>(null);
  const [saving, setSaving] = useState(false);

  const [name, setName] = useState("");
  const [label, setLabel] = useState("");
  const [description, setDescription] = useState("");
  const [method, setMethod] = useState<string>("GET");
  const [urlTemplate, setUrlTemplate] = useState("");
  const [headers, setHeaders] = useState("");
  const [bodyTemplate, setBodyTemplate] = useState("");
  const [schemaText, setSchemaText] = useState(DEFAULT_SCHEMA);
  const [credential, setCredential] = useState("");
  const [preset, setPreset] = useState<Preset | null>(null);

  function openCreate() {
    setEditing(null);
    setName("");
    setLabel("");
    setDescription("");
    setMethod("GET");
    setUrlTemplate("");
    setHeaders("");
    setBodyTemplate("");
    setSchemaText(DEFAULT_SCHEMA);
    setCredential("");
    setPreset(null);
    setOpen(true);
  }

  function openEdit(tool: PublicTool) {
    setEditing(tool);
    setName(tool.name);
    setLabel(tool.label);
    setDescription(tool.description);
    setMethod(tool.request?.method ?? "GET");
    setUrlTemplate(tool.request?.urlTemplate ?? "");
    setHeaders(formatHeaders(tool.request?.headers));
    setBodyTemplate(tool.request?.bodyTemplate ?? "");
    setSchemaText(JSON.stringify(tool.inputSchema, null, 2));
    setCredential("");
    setPreset(presetOf(tool));
    setOpen(true);
  }

  function payload() {
    if (!preset) throw new Error(t("tools.approval"));
    const parsedSchema = JSON.parse(schemaText) as Record<string, unknown>;
    const parsedHeaders = parseHeaders(headers);
    return {
      name,
      label,
      description,
      ...presetValues(preset),
      inputSchema: parsedSchema,
      request: {
        method,
        urlTemplate,
        ...(Object.keys(parsedHeaders).length > 0
          ? { headers: parsedHeaders }
          : {}),
        ...(bodyTemplate.trim() ? { bodyTemplate } : {})
      },
      ...(credential ? { credential } : {})
    };
  }

  async function save() {
    setSaving(true);
    try {
      const body = JSON.stringify(payload());
      await apiRequest(
        editing ? `/api/tools/${editing.id}` : "/api/tools",
        { method: editing ? "PUT" : "POST", body }
      );
      await refresh();
      setOpen(false);
      toast.success(t("tools.saved"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(tool: PublicTool) {
    try {
      await apiRequest(`/api/tools/${tool.id}`, {
        method: "PUT",
        body: JSON.stringify({
          name: tool.name,
          label: tool.label,
          description: tool.description,
          risk: tool.risk,
          requiresApproval: tool.requiresApproval,
          replay: tool.replay,
          inputSchema: tool.inputSchema,
          request: tool.request,
          active: !tool.active
        })
      });
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }

  async function confirmDelete() {
    if (!deleting) return;
    try {
      await apiRequest(`/api/tools/${deleting.id}`, { method: "DELETE" });
      await refresh();
      toast.success(t("tools.deleted"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setDeleting(null);
    }
  }

  return (
    <div className="page-content">
      <PageHeader
        eyebrow={t("tools.eyebrow")}
        title={t("tools.title")}
        description={t("tools.description")}
      />
      <div className="button-row">
        <Button type="button" onClick={openCreate}>
          <Plus size={15} /> {t("tools.register")}
        </Button>
      </div>

      <div className="card-grid">
        {(data?.tools ?? []).map((tool) => (
          <article key={tool.id} className="panel tool-card">
            <div className="panel-title">
              <Wrench size={17} />
              <h2>{toolLabel(t, tool)}</h2>
            </div>
            <p>{toolDescription(t, tool)}</p>
            <div className="button-row">
              <Badge variant="secondary">
                {tool.builtIn ? t("tools.builtIn") : t("tools.registered")}
              </Badge>
              {!tool.active ? (
                <Badge variant="secondary">{t("tools.inactive")}</Badge>
              ) : null}
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
              {tool.requiresApproval ? (
                <span className="status-pill">
                  {t("tools.withheldInDiscussions")}
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
              {tool.request ? (
                <code>
                  {tool.request.method} {tool.request.urlTemplate}
                </code>
              ) : null}
              {tool.configured ? <Badge variant="secondary">•••</Badge> : null}
            </div>
            <details className="tool-schema-details">
              <summary>{t("tools.inputSchema")}</summary>
              <pre>{JSON.stringify(tool.inputSchema, null, 2)}</pre>
            </details>
            {!tool.builtIn ? (
              <div className="button-row">
                <Button
                  size="sm"
                  variant="secondary"
                  type="button"
                  onClick={() => openEdit(tool)}
                >
                  <Pencil size={14} /> {t("tools.edit")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  type="button"
                  onClick={() => void toggleActive(tool)}
                >
                  <Check size={14} />
                  {tool.active ? t("tools.disable") : t("tools.enable")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  type="button"
                  onClick={() => setDeleting(tool)}
                >
                  <Trash2 size={14} /> {t("tools.delete")}
                </Button>
              </div>
            ) : null}
          </article>
        ))}
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="tool-dialog">
          <form
            className="tool-dialog-form"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <DialogHeader>
              <DialogTitle>
                {editing ? t("tools.editTitle") : t("tools.register")}
              </DialogTitle>
              <DialogDescription>
                {editing
                  ? t("tools.editDescription")
                  : t("tools.registerDescription")}
              </DialogDescription>
            </DialogHeader>

            <div className="tool-dialog-body">
            <div className="field-grid">
              <div className="grid gap-2">
                <Label htmlFor="tool-name">{t("tools.name")}</Label>
                <Input
                  id="tool-name"
                  value={name}
                  disabled={editing !== null}
                  onChange={(event) => setName(event.target.value)}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="tool-label">{t("tools.label")}</Label>
                <Input
                  id="tool-label"
                  value={label}
                  onChange={(event) => setLabel(event.target.value)}
                />
              </div>
            </div>

            <div className="grid gap-2">
              <Label htmlFor="tool-description">
                {t("tools.descriptionField")}
              </Label>
              <Input
                id="tool-description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
            </div>

            <fieldset className="choice-fieldset">
              <legend>{t("tools.approval")}</legend>
              <p className="field-hint">{t("tools.approvalHint")}</p>
              <div className="button-row">
                <Button
                  type="button"
                  variant={preset === "read" ? "default" : "secondary"}
                  aria-pressed={preset === "read"}
                  onClick={() => setPreset("read")}
                >
                  {t("tools.presetRead")}
                </Button>
                <Button
                  type="button"
                  variant={preset === "side" ? "default" : "secondary"}
                  aria-pressed={preset === "side"}
                  onClick={() => setPreset("side")}
                >
                  {t("tools.presetSideEffecting")}
                </Button>
              </div>
              <p className="field-hint">
                {preset === "read"
                  ? t("tools.presetReadHint")
                  : preset === "side"
                    ? t("tools.presetSideEffectingHint")
                    : t("tools.riskHint")}
              </p>
            </fieldset>

            <div className="field-grid">
              <div className="grid gap-2">
                <Label htmlFor="tool-method">{t("tools.method")}</Label>
                <select
                  id="tool-method"
                  value={method}
                  onChange={(event) => setMethod(event.target.value)}
                >
                  {METHODS.map((item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
                </select>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="tool-credential">{t("tools.credential")}</Label>
                <Input
                  id="tool-credential"
                  type="password"
                  value={credential}
                  onChange={(event) => setCredential(event.target.value)}
                  placeholder={editing?.configured ? "•••" : ""}
                />
              </div>
            </div>

            <div className="grid gap-2">
              <Label htmlFor="tool-url">{t("tools.urlTemplate")}</Label>
              <Input
                id="tool-url"
                value={urlTemplate}
                onChange={(event) => setUrlTemplate(event.target.value)}
              />
              <p className="field-hint">{t("tools.urlHint")}</p>
            </div>

            <div className="grid gap-2">
              <Label htmlFor="tool-headers">{t("tools.headers")}</Label>
              <Textarea
                id="tool-headers"
                value={headers}
                onChange={(event) => setHeaders(event.target.value)}
              />
              <p className="field-hint">{t("tools.headersHint")}</p>
            </div>

            <div className="grid gap-2">
              <Label htmlFor="tool-body">{t("tools.bodyTemplate")}</Label>
              <Textarea
                id="tool-body"
                value={bodyTemplate}
                onChange={(event) => setBodyTemplate(event.target.value)}
              />
              <p className="field-hint">{t("tools.bodyHint")}</p>
            </div>

            <div className="grid gap-2">
              <Label htmlFor="tool-schema">
                {t("tools.inputSchemaField")}
              </Label>
              <Textarea
                id="tool-schema"
                value={schemaText}
                onChange={(event) => setSchemaText(event.target.value)}
              />
              <p className="field-hint">{t("tools.inputSchemaHint")}</p>
            </div>

            <p className="field-hint">{t("tools.credentialHint")}</p>

            </div>

            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setOpen(false)}
              >
                {t("tools.cancel")}
              </Button>
              <Button type="submit" disabled={saving || !preset}>
                {t("tools.save")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={deleting !== null}
        onOpenChange={(next) => {
          if (!next) setDeleting(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("tools.deleteTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("tools.deleteBody")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("tools.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void confirmDelete()}>
              {t("tools.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
