"use client";

import {
  Activity,
  AlertTriangle,
  CircleStop,
  Clock3,
  LoaderCircle,
  RotateCcw,
  RefreshCw,
  Server,
  UsersRound,
  X
} from "lucide-react";
import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { useI18n } from "@/components/i18n-provider";
import { PageHeader } from "@/components/page-header";
import { useWorkspace } from "@/components/workspace-provider";
import { apiRequest } from "@/lib/api";
import type {
  DiagnosticsCommand,
  DiagnosticsCommandKind,
  DiagnosticsFailureKind,
  DiagnosticsHealth,
  DiagnosticsRun,
  DiagnosticsView
} from "@/lib/diagnostics-view";
import type { TranslationKey } from "@/lib/i18n";

function healthKey(status: DiagnosticsHealth): TranslationKey {
  return `diagnostics.${status}`;
}

function statusKey(status: string): TranslationKey {
  return `status.${status}` as TranslationKey;
}

function commandKey(kind: DiagnosticsCommandKind): TranslationKey {
  return `diagnostics.action.${kind}`;
}

const actionIcons = {
  cancel: <X size={13} />,
  stop: <CircleStop size={13} />,
  resume: <RotateCcw size={13} />,
  retry: <RefreshCw size={13} />
} satisfies Record<DiagnosticsCommandKind, ReactNode>;

function failureKey(kind: DiagnosticsFailureKind): TranslationKey {
  return `diagnostics.failure.${kind}`;
}

function formatTime(value: string | undefined): string {
  if (!value) return "—";
  return new Date(value).toLocaleTimeString();
}

function formatTokens(value: number): string {
  return new Intl.NumberFormat().format(value);
}

function formatCost(micros: number | null, currency?: string): string {
  if (micros === null) return "—";
  return `${currency ?? "USD"} ${(micros / 1_000_000).toFixed(4)}`;
}

function ActionButtons({
  actions,
  resourceLabel,
  busyAction,
  onAction
}: {
  actions: DiagnosticsCommand[];
  resourceLabel: string;
  busyAction: string | null;
  onAction: (action: DiagnosticsCommand) => void;
}) {
  const { t } = useI18n();
  if (actions.length === 0) return null;
  return (
    <div className="diagnostics-actions">
      {actions.map((action) => {
        const label = t(commandKey(action.kind));
        const busy = busyAction === action.href;
        return (
          <button
            key={`${action.kind}:${action.href}`}
            type="button"
            className={
              action.kind === "cancel"
                ? "button danger"
                : "button quiet"
            }
            aria-label={`${label}: ${resourceLabel}`}
            disabled={busyAction !== null}
            onClick={() => onAction(action)}
          >
            {busy ? (
              <LoaderCircle className="spin" size={13} />
            ) : (
              actionIcons[action.kind]
            )}
            {label}
          </button>
        );
      })}
    </div>
  );
}

function RunListItem({
  run,
  busyAction,
  onAction
}: {
  run: DiagnosticsRun;
  busyAction: string | null;
  onAction: (action: DiagnosticsCommand) => void;
}) {
  const { t } = useI18n();
  const label =
    run.taskTitle ?? run.discussionTitle ?? run.conversationTitle;
  return (
    <article className="diagnostics-list-item">
      <div>
        <strong>{label}</strong>
        <small>
          {run.conversationTitle}
          {run.errorCode ? ` · ${run.errorCode}` : ""}
        </small>
      </div>
      <span className={`status-pill ${run.status}`}>
        {t(statusKey(run.status))}
      </span>
      <Link
        href={run.href}
        aria-label={`${t("diagnostics.openConversation")}: ${label}`}
      >
        {t("diagnostics.openConversation")}
      </Link>
      {run.pendingApprovalCount > 0 ? (
        <small>
          {t("diagnostics.pendingApprovals", {
            count: run.pendingApprovalCount
          })}
        </small>
      ) : null}
      <ActionButtons
        actions={run.actions}
        resourceLabel={label}
        busyAction={busyAction}
        onAction={onAction}
      />
    </article>
  );
}

export function DiagnosticsWorkspace() {
  const { t } = useI18n();
  const { refresh: refreshWorkspace } = useWorkspace();
  const [view, setView] = useState<DiagnosticsView | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load(silent = false) {
      if (!silent) setLoading(true);
      try {
        const next = await apiRequest<DiagnosticsView>("/api/diagnostics");
        if (!cancelled) {
          setView(next);
          setError(null);
        }
      } catch (nextError) {
        if (!cancelled) {
          setError(
            nextError instanceof Error ? nextError.message : String(nextError)
          );
        }
      } finally {
        if (!cancelled && !silent) setLoading(false);
      }
    }
    void load();
    const timer = window.setInterval(() => void load(true), 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  async function refresh() {
    setRefreshing(true);
    try {
      setView(await apiRequest<DiagnosticsView>("/api/diagnostics"));
      setError(null);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setRefreshing(false);
    }
  }

  async function execute(action: DiagnosticsCommand) {
    setBusyAction(action.href);
    setError(null);
    try {
      await apiRequest(action.href, {
        method: action.method,
        ...(action.method === "POST"
          ? {
              body: "{}",
              headers: { "idempotency-key": crypto.randomUUID() }
            }
          : {})
      });
      await refresh();
      await refreshWorkspace();
      toast.success(t("diagnostics.actionApplied"));
    } catch (nextError) {
      const message =
        nextError instanceof Error ? nextError.message : String(nextError);
      setError(message);
      toast.error(message);
    } finally {
      setBusyAction(null);
    }
  }

  if (loading && !view) {
    return (
      <div className="empty-state">
        <LoaderCircle className="spin" size={20} />
        <span>{t("shell.loading")}</span>
      </div>
    );
  }

  const attentionProviders =
    view?.providers.filter((provider) => provider.status !== "healthy").length ??
    0;
  const activeWork = (view?.runs.active.length ?? 0) + (view?.runs.queued.length ?? 0);

  return (
    <div className="page-content diagnostics-page">
      <PageHeader
        eyebrow={t("diagnostics.eyebrow")}
        title={t("diagnostics.title")}
        description={t("diagnostics.description")}
        action={
          <button
            className="button secondary"
            onClick={() => void refresh()}
            disabled={refreshing}
          >
            {refreshing ? (
              <LoaderCircle className="spin" size={15} />
            ) : (
              <RefreshCw size={15} />
            )}
            {t("diagnostics.refresh")}
          </button>
        }
      />
      {error ? <div className="error-banner">{error}</div> : null}
      {view ? (
        <>
          <section className="diagnostics-summary" aria-label={t("diagnostics.title")}>
            <article className="diagnostics-stat">
              <Server size={16} />
              <span>{t("diagnostics.worker")}</span>
              <strong className={`health-text ${view.worker.status}`}>
                {t(healthKey(view.worker.status))}
              </strong>
              <small>
                {view.worker.heartbeatAt
                  ? t("diagnostics.lastAttempt", {
                      time: formatTime(view.worker.heartbeatAt)
                    })
                  : t("diagnostics.unavailable")}
              </small>
            </article>
            <article className="diagnostics-stat">
              <Activity size={16} />
              <span>{t("diagnostics.activeWork")}</span>
              <strong>{activeWork}</strong>
              <small>
                {t("diagnostics.queue")} {view.runs.queued.length}
              </small>
            </article>
            <article className="diagnostics-stat">
              <AlertTriangle size={16} />
              <span>{t("diagnostics.providerAttention")}</span>
              <strong>{attentionProviders}</strong>
              <small>{view.providers.length} Providers</small>
            </article>
            <article className="diagnostics-stat">
              <Clock3 size={16} />
              <span>{t("diagnostics.windowUsage")}</span>
              <strong>{formatTokens(view.usage.totalTokens)}</strong>
              <small>
                {formatCost(
                  view.usage.estimatedCostMicros,
                  view.usage.currency
                )}
              </small>
            </article>
          </section>

          <div className="diagnostics-grid">
            <section className="panel diagnostics-panel">
              <div className="panel-title">
                <Server size={17} />
                <h2>{t("diagnostics.providers")}</h2>
              </div>
              <div className="diagnostics-list">
                {view.providers.map((provider) => (
                  <article key={provider.id} className="diagnostics-list-item">
                    <div>
                      <strong>{provider.label}</strong>
                      <small>
                        {provider.provider} · {provider.recentAttemptCount}{" "}
                        {t("chat.attempts", {
                          count: provider.recentAttemptCount
                        })}
                      </small>
                    </div>
                    <span className={`status-pill ${provider.status}`}>
                      {t(healthKey(provider.status))}
                    </span>
                    <small>
                      {provider.lastErrorCode
                        ? `${provider.lastErrorCode} · `
                        : ""}
                      {provider.lastAttemptAt
                        ? t("diagnostics.lastAttempt", {
                            time: formatTime(provider.lastAttemptAt)
                          })
                        : provider.lastValidatedAt
                          ? t("diagnostics.lastValidated", {
                              time: formatTime(provider.lastValidatedAt)
                            })
                          : t("diagnostics.validationUnknown")}
                    </small>
                  </article>
                ))}
                {view.providers.length === 0 ? (
                  <p className="diagnostics-empty">{t("diagnostics.noProviders")}</p>
                ) : null}
              </div>
            </section>

            <section className="panel diagnostics-panel">
              <div className="panel-title">
                <Activity size={17} />
                <h2>{t("diagnostics.runs")}</h2>
              </div>
              <div className="diagnostics-list">
                {[...view.runs.active, ...view.runs.queued].map((run) => (
                  <RunListItem
                    key={run.id}
                    run={run}
                    busyAction={busyAction}
                    onAction={(action) => void execute(action)}
                  />
                ))}
                {activeWork === 0 ? (
                  <p className="diagnostics-empty">
                    {t("diagnostics.noActiveRuns")}
                  </p>
                ) : null}
              </div>
            </section>

            <section className="panel diagnostics-panel">
              <div className="panel-title">
                <RotateCcw size={17} />
                <h2>{t("diagnostics.recovery")}</h2>
              </div>
              <div className="diagnostics-list">
                {view.runs.recoverable.map((run) => (
                  <RunListItem
                    key={run.id}
                    run={run}
                    busyAction={busyAction}
                    onAction={(action) => void execute(action)}
                  />
                ))}
                {view.runs.recoverable.length === 0 ? (
                  <p className="diagnostics-empty">
                    {t("diagnostics.noRecoverableRuns")}
                  </p>
                ) : null}
              </div>
            </section>

            <section className="panel diagnostics-panel">
              <div className="panel-title">
                <UsersRound size={17} />
                <h2>{t("diagnostics.discussions")}</h2>
              </div>
              <div className="diagnostics-list">
                {view.discussions.map((discussion) => (
                  <article key={discussion.id} className="diagnostics-list-item">
                    <div>
                      <strong>{discussion.title}</strong>
                      <small>
                        {discussion.mode} · {discussion.currentRound}/
                        {discussion.maxRounds} ·{" "}
                        {t("diagnostics.pendingInterventions")}{" "}
                        {discussion.pendingInterventionCount}
                      </small>
                    </div>
                    <span className={`status-pill ${discussion.status}`}>
                      {t(statusKey(discussion.status))}
                    </span>
                    <small>
                      {t("diagnostics.budget")}: {discussion.tokenBudgetState}/
                      {discussion.costBudgetState}
                      {discussion.reason ? ` · ${discussion.reason}` : ""}
                    </small>
                    <Link
                      href={discussion.href}
                      aria-label={`${t("diagnostics.openDiscussion")}: ${discussion.title}`}
                    >
                      {t("diagnostics.openDiscussion")}
                    </Link>
                    <ActionButtons
                      actions={discussion.actions}
                      resourceLabel={discussion.title}
                      busyAction={busyAction}
                      onAction={(action) => void execute(action)}
                    />
                  </article>
                ))}
                {view.discussions.length === 0 ? (
                  <p className="diagnostics-empty">
                    {t("diagnostics.noDiscussions")}
                  </p>
                ) : null}
              </div>
            </section>

            <section className="panel diagnostics-panel">
              <div className="panel-title">
                <Activity size={17} />
                <h2>{t("diagnostics.windowUsage")}</h2>
              </div>
              <dl className="diagnostics-usage">
                <div>
                  <dt>{t("diagnostics.tokens")}</dt>
                  <dd>{formatTokens(view.usage.totalTokens)}</dd>
                </div>
                <div>
                  <dt>{t("diagnostics.cost")}</dt>
                  <dd>
                    {formatCost(
                      view.usage.estimatedCostMicros,
                      view.usage.currency
                    )}
                  </dd>
                </div>
                <div>
                  <dt>{t("diagnostics.retries")}</dt>
                  <dd>{view.usage.retryAttempts}</dd>
                </div>
                <div>
                  <dt>{t("diagnostics.fallbacks")}</dt>
                  <dd>{view.usage.fallbackAttempts}</dd>
                </div>
                <div>
                  <dt>{t("diagnostics.unknownUsage")}</dt>
                  <dd>{view.usage.unknownUsageAttempts}</dd>
                </div>
                <div>
                  <dt>{t("diagnostics.unknownPricing")}</dt>
                  <dd>{view.usage.unknownPricingAttempts}</dd>
                </div>
              </dl>
            </section>

            <section className="panel diagnostics-panel diagnostics-wide">
              <div className="panel-title">
                <AlertTriangle size={17} />
                <h2>{t("diagnostics.failures")}</h2>
              </div>
              <div className="diagnostics-list">
                {view.failures.map((failure) => (
                  <article
                    key={`${failure.provider}:${failure.modelId}`}
                    className="diagnostics-list-item"
                  >
                    <div>
                      <strong>
                        {failure.provider} / {failure.modelId}
                      </strong>
                      <small>
                        {t("chat.attempts", { count: failure.count })} ·{" "}
                        {failure.statuses.join(", ")}
                      </small>
                      <small>
                        {failure.failureKinds
                          .map((kind) => t(failureKey(kind)))
                          .join(" · ")}
                      </small>
                      {failure.usedFallback ? (
                        <small>{t("diagnostics.failure.fallback")}</small>
                      ) : null}
                      <small>
                        {t("diagnostics.latestAttempt", {
                          id: failure.latestAttemptId
                        })}
                      </small>
                      {[...failure.errorKinds, ...failure.errorCodes].length >
                      0 ? (
                        <small>
                          {[
                            ...failure.errorKinds,
                            ...failure.errorCodes
                          ].join(" · ")}
                        </small>
                      ) : null}
                    </div>
                    <time>{formatTime(failure.lastOccurredAt)}</time>
                    {failure.href ? (
                      <Link
                        href={failure.href}
                        aria-label={`${t("diagnostics.openAffectedWork")}: ${failure.provider} / ${failure.modelId}`}
                      >
                        {t("diagnostics.openAffectedWork")}
                      </Link>
                    ) : null}
                  </article>
                ))}
                {view.failures.length === 0 ? (
                  <p className="diagnostics-empty">
                    {t("diagnostics.noFailures")}
                  </p>
                ) : null}
              </div>
            </section>
          </div>
          <p className="diagnostics-updated">
            {t("diagnostics.generatedAt", {
              time: formatTime(view.generatedAt)
            })}
          </p>
        </>
      ) : null}
    </div>
  );
}
