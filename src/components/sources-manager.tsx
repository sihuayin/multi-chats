"use client";

import {
  BookOpen,
  Check,
  LoaderCircle,
  Plus,
  RefreshCw,
  Trash2
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { apiRequest } from "@/lib/api";
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
import type { SourceStatus } from "@/server/domain/types";
import type { TranslationKey } from "@/lib/i18n";

const STATUS_VARIANTS: Record<SourceStatus, "default" | "secondary" | "destructive" | "outline"> = {
  pending: "secondary",
  ingesting: "secondary",
  ready: "default",
  failed: "destructive"
};

const STATUS_KEYS: Record<SourceStatus, TranslationKey> = {
  pending: "source.status.pending",
  ingesting: "source.status.ingesting",
  ready: "source.status.ready",
  failed: "source.status.failed"
};

export function SourcesManager() {
  const { data, refresh } = useWorkspace();
  const { t } = useI18n();
  const [kind, setKind] = useState<"url" | "file">("url");
  const [location, setLocation] = useState("");
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  const sources = data?.sources ?? [];

  function resetForm() {
    setKind("url");
    setLocation("");
    setContent("");
  }

  function openCreateDialog() {
    setError(null);
    resetForm();
    setDialogOpen(true);
  }

  function onFileChange(file: File | undefined) {
    if (!file) return;
    setLocation(file.name);
    const reader = new FileReader();
    if (file.name.toLowerCase().endsWith(".pdf")) {
      reader.onload = () => {
        const result = String(reader.result ?? "");
        setContent(result.slice(result.indexOf(",") + 1));
      };
      reader.readAsDataURL(file);
    } else {
      reader.onload = () => setContent(String(reader.result ?? ""));
      reader.readAsText(file);
    }
  }

  async function createSource() {
    setBusy(true);
    setError(null);
    try {
      await apiRequest("/api/sources", {
        method: "POST",
        body: JSON.stringify(
          kind === "url"
            ? { kind: "url", location }
            : { kind: "file", location, content }
        )
      });
      resetForm();
      setDialogOpen(false);
      toast.success(t("sources.created"));
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

  async function retrySource(id: string) {
    setBusy(true);
    setError(null);
    try {
      await apiRequest(`/api/sources/${id}/retry`, {
        method: "POST",
        body: JSON.stringify({})
      });
      await refresh();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusy(false);
    }
  }

  async function deleteSource(id: string) {
    setBusy(true);
    setError(null);
    try {
      await apiRequest(`/api/sources/${id}`, { method: "DELETE" });
      toast.success(t("sources.deleted"));
      await refresh();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page-content sources-page">
      <PageHeader
        eyebrow={t("sources.eyebrow")}
        title={t("sources.title")}
        description={t("sources.description")}
        action={
          <Button type="button" onClick={openCreateDialog}>
            <Plus size={16} />
            {t("sources.add")}
          </Button>
        }
      />
      {error ? <div className="error-banner">{error}</div> : null}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="source-dialog">
          <form
            className="source-dialog-form"
            onSubmit={(event) => {
              event.preventDefault();
              void createSource();
            }}
          >
            <DialogHeader>
              <DialogTitle>{t("sources.add")}</DialogTitle>
              <DialogDescription>{t("sources.addDescription")}</DialogDescription>
            </DialogHeader>

            <div className="source-dialog-body">
              <fieldset className="choice-fieldset">
                <legend>{t("sources.kind")}</legend>
                <div className="choice-fieldset-row">
                  <label className="check-row">
                    <input
                      type="radio"
                      name="source-kind"
                      checked={kind === "url"}
                      onChange={() => setKind("url")}
                    />
                    <span>{t("sources.kindUrl")}</span>
                  </label>
                  <label className="check-row">
                    <input
                      type="radio"
                      name="source-kind"
                      checked={kind === "file"}
                      onChange={() => setKind("file")}
                    />
                    <span>{t("sources.kindFile")}</span>
                  </label>
                </div>
              </fieldset>

              {kind === "url" ? (
                <div className="grid gap-2">
                  <Label htmlFor="source-location">{t("sources.location")}</Label>
                  <Input
                    id="source-location"
                    placeholder={t("sources.locationUrlHint")}
                    value={location}
                    onChange={(event) => setLocation(event.target.value)}
                  />
                </div>
              ) : (
                <>
                  <div className="grid gap-2">
                    <Label htmlFor="source-file">{t("sources.location")}</Label>
                    <Input
                      id="source-file"
                      type="file"
                      accept=".md,.txt,.markdown,.pdf,text/plain,text/markdown,application/pdf"
                      onChange={(event) =>
                        onFileChange(event.target.files?.[0])
                      }
                    />
                    {location ? (
                      <p className="text-xs text-muted-foreground">
                        {location}
                      </p>
                    ) : null}
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="source-content">
                      {t("sources.content")}
                    </Label>
                    <Textarea
                      id="source-content"
                      rows={8}
                      value={content}
                      onChange={(event) => setContent(event.target.value)}
                    />
                  </div>
                </>
              )}
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
                  !location.trim() ||
                  (kind === "file" && !content.trim())
                }
              >
                {busy ? (
                  <LoaderCircle className="spin" size={16} />
                ) : (
                  <Check size={16} />
                )}
                {t("sources.create")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <section className="panel source-library-panel" aria-labelledby="source-library-title">
        <div className="source-library-toolbar">
          <div className="source-library-title">
            <BookOpen size={17} />
            <h2 id="source-library-title">{t("sources.library")}</h2>
            <Badge variant="secondary">{sources.length}</Badge>
          </div>
        </div>

        <div className="source-card-scroll">
          {sources.length === 0 ? (
            <div className="source-library-empty">
              <BookOpen size={22} />
              <p>{t("sources.none")}</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={openCreateDialog}
              >
                <Plus size={15} />
                {t("sources.add")}
              </Button>
            </div>
          ) : (
            <div className="source-card-grid">
              {sources.map((source) => (
                <Card key={source.id} className="source-card">
                  <CardHeader className="source-card-header">
                    <div className="source-card-heading">
                      <span className="source-card-mark" aria-hidden="true">
                        <BookOpen size={16} />
                      </span>
                      <div>
                        <CardTitle className="source-card-title">
                          {source.title}
                        </CardTitle>
                        <p className="source-card-location">{source.location}</p>
                      </div>
                    </div>
                    <Badge variant={STATUS_VARIANTS[source.status]}>
                      {t(STATUS_KEYS[source.status])}
                    </Badge>
                  </CardHeader>
                  <CardContent className="source-card-content">
                    <div className="source-card-meta">
                      <span>{source.kind === "url" ? t("sources.kindUrl") : t("sources.kindFile")}</span>
                      <span>{t("sources.chunkCount", { count: source.chunkCount })}</span>
                    </div>
                    {source.status === "failed" && source.error ? (
                      <p className="source-card-error">{source.error}</p>
                    ) : null}
                  </CardContent>
                  <CardFooter className="source-card-footer">
                    <span>
                      {source.status === "failed"
                        ? t("source.status.failed")
                        : t("sources.library")}
                    </span>
                    <div className="button-row">
                      {source.status === "failed" ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={busy}
                          onClick={() => retrySource(source.id)}
                        >
                          <RefreshCw size={14} />
                          {t("sources.retry")}
                        </Button>
                      ) : null}
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="text-[var(--danger)]"
                        title={t("sources.delete")}
                        disabled={busy}
                        onClick={() => deleteSource(source.id)}
                      >
                        <Trash2 size={16} />
                      </Button>
                    </div>
                  </CardFooter>
                </Card>
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
