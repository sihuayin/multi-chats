"use client";

import {
  Braces,
  Check,
  LoaderCircle,
  Pencil,
  Plus
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { apiRequest } from "@/lib/api";
import { paginationEntries } from "@/lib/pagination";
import { skillLabel } from "@/lib/skill-labels";
import { toolLabel } from "@/lib/tool-labels";
import { useI18n } from "@/components/i18n-provider";
import { useWorkspace } from "@/components/workspace-provider";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
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
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious
} from "@/components/ui/pagination";
import { Textarea } from "@/components/ui/textarea";

const PAGE_SIZE = 6;

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
  const [inputs, setInputs] = useState("");
  const [outputs, setOutputs] = useState("");
  const [toolNames, setToolNames] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogMode, setDialogMode] = useState<"create" | "edit">("create");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [page, setPage] = useState(1);

  const skills = data?.skills ?? [];
  const pageCount = Math.max(1, Math.ceil(skills.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const pageStart = (safePage - 1) * PAGE_SIZE;
  const visibleSkills = skills.slice(pageStart, pageStart + PAGE_SIZE);

  function resetForm() {
    setEditingId(null);
    setName("");
    setDescription("");
    setInstructions("");
    setInputs("");
    setOutputs("");
    setToolNames([]);
  }

  function openCreateDialog() {
    setError(null);
    setDialogMode("create");
    resetForm();
    setDialogOpen(true);
  }

  function openEditDialog(id: string) {
    const skill = skills.find((item) => item.id === id);
    if (!skill || skill.builtIn) return;
    setError(null);
    setDialogMode("edit");
    setEditingId(skill.id);
    setName(skill.name);
    setDescription(skill.description);
    setInstructions(skill.instructions);
    setInputs(skill.inputs.join(", "));
    setOutputs(skill.outputs.join(", "));
    setToolNames(skill.toolNames);
    setDialogOpen(true);
  }

  async function saveSkill() {
    setBusy(true);
    setError(null);
    try {
      const isEditing = dialogMode === "edit" && editingId;
      await apiRequest(isEditing ? `/api/skills/${editingId}` : "/api/skills", {
        method: isEditing ? "PUT" : "POST",
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
      setDialogOpen(false);
      toast.success(
        isEditing ? t("skills.updated") : t("skills.created")
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

  return (
    <div className="page-content skills-page">
      <PageHeader
        eyebrow={t("skills.eyebrow")}
        title={t("skills.title")}
        description={t("skills.description")}
        action={
          <Button type="button" onClick={openCreateDialog}>
            <Plus size={16} />
            {t("skills.add")}
          </Button>
        }
      />
      {error ? <div className="error-banner">{error}</div> : null}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="skill-dialog">
          <form
            className="skill-dialog-form"
            onSubmit={(event) => {
              event.preventDefault();
              void saveSkill();
            }}
          >
            <DialogHeader>
              <DialogTitle>
                {dialogMode === "edit"
                  ? t("skills.editTitle")
                  : t("skills.create")}
              </DialogTitle>
              <DialogDescription>
                {dialogMode === "edit"
                  ? t("skills.editDescription")
                  : t("skills.createDescription")}
              </DialogDescription>
            </DialogHeader>

            <div className="skill-dialog-body">
              <div className="field-grid">
                <div className="grid gap-2">
                  <Label htmlFor="skill-name">{t("skills.name")}</Label>
                  <Input
                    id="skill-name"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="skill-description">
                    {t("skills.descriptionField")}
                  </Label>
                  <Input
                    id="skill-description"
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                  />
                </div>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="skill-instructions">
                  {t("skills.instructions")}
                </Label>
                <Textarea
                  id="skill-instructions"
                  rows={6}
                  value={instructions}
                  onChange={(event) => setInstructions(event.target.value)}
                />
              </div>
              <div className="field-grid">
                <div className="grid gap-2">
                  <Label htmlFor="skill-inputs">{t("skills.inputs")}</Label>
                  <Input
                    id="skill-inputs"
                    value={inputs}
                    onChange={(event) => setInputs(event.target.value)}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="skill-outputs">{t("skills.outputs")}</Label>
                  <Input
                    id="skill-outputs"
                    value={outputs}
                    onChange={(event) => setOutputs(event.target.value)}
                  />
                </div>
              </div>
              <fieldset className="choice-fieldset skill-tool-fieldset">
                <legend>{t("skills.allowedTools")}</legend>
                {(data?.tools ?? []).map((tool) => {
                  const label = toolLabel(t, tool);
                  return (
                    <div key={tool.name} className="skill-tool-option">
                      <Checkbox
                        checked={toolNames.includes(tool.name)}
                        aria-label={label}
                        onCheckedChange={(checked) =>
                          setToolNames((current) =>
                            checked === true
                              ? [...current, tool.name]
                              : current.filter((entry) => entry !== tool.name)
                          )
                        }
                      />
                      <span>{label}</span>
                      <small>
                        {tool.requiresApproval ? "approval" : tool.risk}
                      </small>
                    </div>
                  );
                })}
              </fieldset>
            </div>

            {error ? <div className="error-banner">{error}</div> : null}

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => setDialogOpen(false)}
              >
                {t("common.cancel")}
              </Button>
              <Button
                type="submit"
                disabled={
                  busy ||
                  !name.trim() ||
                  !description.trim() ||
                  !instructions.trim()
                }
              >
                {busy ? (
                  <LoaderCircle className="spin" size={16} />
                ) : (
                  <Check size={16} />
                )}
                {dialogMode === "edit"
                  ? t("skills.saveChanges")
                  : t("skills.create")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <section
        className="panel skill-library-panel"
        aria-labelledby="skill-library-title"
      >
        <div className="skill-library-toolbar">
          <div className="skill-library-title">
            <Braces size={17} />
            <h2 id="skill-library-title">{t("skills.library")}</h2>
            <Badge variant="secondary">{skills.length}</Badge>
          </div>
        </div>

        <div className="skill-card-scroll">
          {skills.length === 0 ? (
            <div className="skill-library-empty">
              <Braces size={22} />
              <p>{t("skills.none")}</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={openCreateDialog}
              >
                <Plus size={15} />
                {t("skills.add")}
              </Button>
            </div>
          ) : (
            <div className="skill-card-grid">
              {visibleSkills.map((skill) => (
                <Card key={skill.id} className="skill-card">
                  <CardHeader className="skill-card-header">
                    <div className="skill-card-heading">
                      <span className="skill-card-mark" aria-hidden="true">
                        <Braces size={16} />
                      </span>
                      <div>
                        <CardTitle className="skill-card-title">
                          {skillLabel(t, skill)}
                        </CardTitle>
                        <p>{skill.description}</p>
                      </div>
                    </div>
                    <Badge variant={skill.builtIn ? "secondary" : "default"}>
                      {skill.builtIn
                        ? t("common.builtIn")
                        : t("common.custom")}
                    </Badge>
                  </CardHeader>
                  <CardContent className="skill-card-content">
                    <div className="skill-card-meta">
                      <span>
                        {t("skills.toolCount", {
                          count: skill.toolNames.length
                        })}
                      </span>
                      <span>
                        {t("skills.inputCount", {
                          count: skill.inputs.length
                        })}
                      </span>
                      <span>
                        {t("skills.outputCount", {
                          count: skill.outputs.length
                        })}
                      </span>
                    </div>
                  </CardContent>
                  <CardFooter className="skill-card-footer">
                    <span>
                      {skill.builtIn
                        ? t("skills.builtInReadOnly")
                        : t("skills.customHint")}
                    </span>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      title={
                        skill.builtIn
                          ? t("skills.builtInReadOnly")
                          : t("skills.editTitle")
                      }
                      disabled={skill.builtIn || busy}
                      onClick={() => openEditDialog(skill.id)}
                    >
                      <Pencil size={14} />
                      {t("common.edit")}
                    </Button>
                  </CardFooter>
                </Card>
              ))}
            </div>
          )}
        </div>

        <footer className="collection-pagination">
          <p className="collection-pagination-summary">
            {t("skills.pageStatus", {
              page: safePage,
              pages: pageCount,
              count: skills.length
            })}
          </p>
          <Pagination
            aria-label={t("skills.pagination")}
            className="collection-pagination-controls"
          >
            <PaginationContent>
              <PaginationItem>
                <PaginationPrevious
                  label={t("skills.previousPage")}
                  disabled={safePage === 1 || busy}
                  onClick={() => setPage((current) => Math.max(1, current - 1))}
                />
              </PaginationItem>
              {paginationEntries(safePage, pageCount).map((entry, index) =>
                entry === "ellipsis" ? (
                  <PaginationItem key={`ellipsis-${index}`}>
                    <PaginationEllipsis />
                  </PaginationItem>
                ) : (
                  <PaginationItem key={entry}>
                    <PaginationLink
                      isActive={entry === safePage}
                      aria-label={t("skills.goToPage", { page: entry })}
                      disabled={busy}
                      onClick={() => setPage(entry)}
                    >
                      {entry}
                    </PaginationLink>
                  </PaginationItem>
                )
              )}
              <PaginationItem>
                <PaginationNext
                  label={t("skills.nextPage")}
                  disabled={safePage === pageCount || busy}
                  onClick={() =>
                    setPage((current) => Math.min(pageCount, current + 1))
                  }
                />
              </PaginationItem>
            </PaginationContent>
          </Pagination>
        </footer>
      </section>
    </div>
  );
}
