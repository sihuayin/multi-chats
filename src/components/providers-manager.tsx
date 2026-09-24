"use client";

import {
  KeyRound,
  LoaderCircle,
  Pencil,
  Plus,
  Trash2,
  Wifi
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { apiRequest } from "@/lib/api";
import { paginationEntries } from "@/lib/pagination";
import { providerCatalog } from "@/lib/provider-catalog";
import type {
  ProviderConnectionTest,
  PublicProvider
} from "@/lib/workspace-view";
import { useI18n } from "@/components/i18n-provider";
import { useWorkspace } from "@/components/workspace-provider";
import { PageHeader } from "@/components/page-header";
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
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious
} from "@/components/ui/pagination";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "@/components/ui/table";

const PAGE_SIZE = 20;

/**
 * Newest first. A Provider's `id` is a random UUID, so it carries no order of
 * its own and sorting by it would shuffle the table between loads. `createdAt`
 * is the timestamp the Provider was configured; `id` breaks a tie between two
 * rows configured in the same millisecond, which keeps the order stable rather
 * than arbitrary.
 */
function byNewestFirst(left: PublicProvider, right: PublicProvider): number {
  return (
    right.createdAt.localeCompare(left.createdAt) ||
    right.id.localeCompare(left.id)
  );
}

function formatValidationTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

export function ProvidersManager() {
  const { data, refresh } = useWorkspace();
  const { t } = useI18n();
  const [provider, setProvider] = useState("openai");
  const [label, setLabel] = useState("");
  const [credential, setCredential] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogMode, setDialogMode] = useState<"create" | "edit">("create");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [page, setPage] = useState(1);

  // `data.providers` belongs to the shared Workspace view, so copy it first:
  // `Array.prototype.sort` mutates in place.
  const providers = [...(data?.providers ?? [])].sort(byNewestFirst);
  const pageCount = Math.max(1, Math.ceil(providers.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const pageStart = (safePage - 1) * PAGE_SIZE;
  const visibleProviders = providers.slice(pageStart, pageStart + PAGE_SIZE);

  function openCreateDialog() {
    setError(null);
    setDialogMode("create");
    setEditingId(null);
    setProvider("openai");
    setLabel("");
    setCredential("");
    setDialogOpen(true);
  }

  function openEditDialog(id: string) {
    const item = providers.find((provider) => provider.id === id);
    if (!item) return;
    setError(null);
    setDialogMode("edit");
    setEditingId(item.id);
    setProvider(item.provider);
    setLabel(item.label);
    setCredential("");
    setDialogOpen(true);
  }

  async function saveProvider() {
    setBusy(true);
    setError(null);
    try {
      const isEditing = dialogMode === "edit" && editingId;
      await apiRequest(isEditing ? `/api/providers/${editingId}` : "/api/providers", {
        method: isEditing ? "PUT" : "POST",
        body: JSON.stringify({
          provider,
          label: label || t("providers.defaultLabel"),
          ...(credential.trim() ? { credential } : {})
        })
      });
      setProvider("openai");
      setLabel("");
      setCredential("");
      setDialogOpen(false);
      toast.success(
        isEditing ? t("providers.updated") : t("providers.saved")
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

  /**
   * Asks the server to reach the Provider with the credential it already
   * stores. The outcome is the toast's whole content: a success reports how
   * long the round trip took, and a failure reports what the Provider said.
   * Only the first is worth refreshing for, since only a success moves the
   * row's validation time.
   */
  async function testConnection(id: string) {
    setTestingId(id);
    try {
      const result = await apiRequest<ProviderConnectionTest>(
        `/api/providers/${id}/test`,
        { method: "POST" }
      );
      toast.success(t("providers.testSucceeded", { ms: result.latencyMs }));
      await refresh();
    } catch (nextError) {
      toast.error(
        t("providers.testFailed", {
          message:
            nextError instanceof Error ? nextError.message : String(nextError)
        })
      );
    } finally {
      setTestingId(null);
    }
  }

  async function removeProvider(id: string) {
    setBusy(true);
    setError(null);
    try {
      await apiRequest(`/api/providers/${id}`, { method: "DELETE" });
      await refresh();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page-content providers-page">
      <PageHeader
        eyebrow={t("providers.eyebrow")}
        title={t("providers.title")}
        description={t("providers.description")}
        action={
          <Button type="button" onClick={openCreateDialog}>
            <Plus size={16} />
            {t("providers.add")}
          </Button>
        }
      />
      {error ? <div className="error-banner">{error}</div> : null}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="provider-dialog">
          <form
            className="provider-dialog-form"
            onSubmit={(event) => {
              event.preventDefault();
              void saveProvider();
            }}
          >
            <DialogHeader>
              <DialogTitle>
                {dialogMode === "edit"
                  ? t("providers.edit")
                  : t("providers.add")}
              </DialogTitle>
              <DialogDescription>
                {dialogMode === "edit"
                  ? t("providers.editDescription")
                  : t("providers.addDescription")}
              </DialogDescription>
            </DialogHeader>
            <div className="provider-field-grid">
              <div className="grid gap-2">
                <Label htmlFor="provider-name">
                  {t("providers.provider")}
                </Label>
                <Select
                  value={provider}
                  onValueChange={setProvider}
                  disabled={dialogMode === "edit"}
                >
                  <SelectTrigger
                    id="provider-name"
                    aria-label={t("providers.provider")}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {providerCatalog.map((item) => (
                      <SelectItem key={item.id} value={item.id}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="provider-label">{t("providers.label")}</Label>
                <Input
                  id="provider-label"
                  value={label}
                  placeholder={t("providers.defaultLabel")}
                  onChange={(event) => setLabel(event.target.value)}
                />
              </div>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="provider-credential">
                {t("providers.apiCredential")}
              </Label>
              <Input
                id="provider-credential"
                type={dialogMode === "edit" ? "text" : "password"}
                value={dialogMode === "edit" ? "*" : credential}
                readOnly={dialogMode === "edit"}
                onChange={
                  dialogMode === "create"
                    ? (event) => setCredential(event.target.value)
                    : undefined
                }
                className={
                  dialogMode === "edit"
                    ? "provider-credential-readonly"
                    : undefined
                }
                autoComplete="off"
              />
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
                  !label.trim() ||
                  (dialogMode === "create" && !credential.trim())
                }
              >
                {busy ? (
                  <LoaderCircle className="spin" size={16} />
                ) : (
                  <KeyRound size={16} />
                )}
                {dialogMode === "edit"
                  ? t("providers.saveChanges")
                  : t("providers.validateSave")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <section
        className="panel provider-list-panel"
        aria-labelledby="provider-list-title"
      >
        <div className="provider-list-toolbar">
          <div className="provider-list-title">
            <KeyRound size={17} />
            <h2 id="provider-list-title">{t("providers.configured")}</h2>
            <Badge variant="secondary">{providers.length}</Badge>
          </div>
        </div>
        <div className="provider-table-scroll">
          {providers.length === 0 ? (
            <div className="provider-table-empty">
              <KeyRound size={22} />
              <p>{t("providers.none")}</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={openCreateDialog}
              >
                <Plus size={15} />
                {t("providers.add")}
              </Button>
            </div>
          ) : (
            <Table className="provider-table">
              <TableHeader className="provider-table-header">
                <TableRow>
                  <TableHead>{t("providers.provider")}</TableHead>
                  <TableHead>{t("providers.label")}</TableHead>
                  <TableHead className="provider-validation-column">
                    {t("providers.validated")}
                  </TableHead>
                  <TableHead className="provider-actions-column">
                    {t("providers.actions")}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleProviders.map((item) => (
                  <TableRow key={item.id} className="provider-table-row">
                    <TableCell>
                      <div className="provider-identity">
                        <span className="provider-mark" aria-hidden="true">
                          {item.provider.slice(0, 2).toUpperCase()}
                        </span>
                        <Badge variant="outline">{item.provider}</Badge>
                      </div>
                    </TableCell>
                    <TableCell>
                      <strong className="provider-label">{item.label}</strong>
                    </TableCell>
                    <TableCell className="provider-validation-column">
                      {item.lastValidatedAt ? (
                        <span className="provider-validation">
                          <span
                            className="provider-validation-dot"
                            aria-hidden="true"
                          />
                          <time dateTime={item.lastValidatedAt}>
                            {formatValidationTime(item.lastValidatedAt)}
                          </time>
                        </span>
                      ) : (
                        <span className="provider-validation pending">
                          {t("providers.neverValidated")}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="provider-actions-column">
                      <div className="button-row">
                        <Button
                          variant="ghost"
                          size="icon"
                          title={t("providers.testConnection")}
                          onClick={() => void testConnection(item.id)}
                          disabled={busy || testingId !== null}
                        >
                          {testingId === item.id ? (
                            <LoaderCircle className="spin" size={16} />
                          ) : (
                            <Wifi size={16} />
                          )}
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          title={t("providers.edit")}
                          onClick={() => openEditDialog(item.id)}
                          disabled={busy || testingId !== null}
                        >
                          <Pencil size={16} />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="text-[var(--danger)]"
                          title={t("providers.delete")}
                          onClick={() => removeProvider(item.id)}
                          disabled={busy || testingId !== null}
                        >
                          <Trash2 size={16} />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
        <footer className="collection-pagination">
          <p className="collection-pagination-summary">
            {t("providers.pageStatus", {
              page: safePage,
              pages: pageCount,
              count: providers.length
            })}
          </p>
          <Pagination
            aria-label={t("providers.pagination")}
            className="collection-pagination-controls"
          >
            <PaginationContent>
              <PaginationItem>
                <PaginationPrevious
                  label={t("providers.previousPage")}
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
                      aria-label={t("providers.goToPage", { page: entry })}
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
                  label={t("providers.nextPage")}
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
