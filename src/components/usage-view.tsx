"use client";

import {
  AlertTriangle,
  Boxes,
  ChartColumn,
  Coins,
  Hash,
  LoaderCircle,
  MessagesSquare,
  RefreshCw,
  Server,
  UsersRound
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useI18n } from "@/components/i18n-provider";
import { PageHeader } from "@/components/page-header";
import { apiRequest } from "@/lib/api";
import type { TranslationKey } from "@/lib/i18n";
import type {
  UsageBreakdownEntry,
  UsageBudgetState,
  UsageDiscussionBudget,
  UsageView,
  UsageWindow
} from "@/lib/usage-view";

const REFRESH_INTERVAL_MS = 15_000;

function windowKey(kind: UsageWindow): TranslationKey {
  return `usage.window.${kind}`;
}

function sourceKey(
  source: UsageView["tokens"]["source"]
): TranslationKey {
  return `usage.source.${source}`;
}

function formatTokens(value: number | undefined): string {
  if (value === undefined) return "—";
  return new Intl.NumberFormat().format(value);
}

function formatAmount(costMicros: number): string {
  return (costMicros / 1_000_000).toFixed(4);
}

function formatCost(costMicros: number, currency: string): string {
  return `${currency} ${formatAmount(costMicros)}`;
}

function formatTime(value: string): string {
  return new Date(value).toLocaleTimeString();
}

function StatCard({
  icon,
  label,
  value,
  detail
}: {
  icon: ReactNode;
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <article className="usage-stat">
      {icon}
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </article>
  );
}

type BreakdownIdentity = {
  id: string;
  label: string;
  detail?: string;
};

/**
 * Renders the Discussion's budget. Limits are enforced across the
 * Discussion's whole lifetime, not the window the rest of the page shows,
 * so the note names its scope rather than leaving the two side by side
 * unlabelled. Returns nothing when no budget is configured, so such a row
 * carries no budget indication at all.
 */
function DiscussionBudgetNote({
  budget
}: {
  budget: UsageDiscussionBudget | null;
}) {
  const { t } = useI18n();
  if (!budget) return null;

  // Each dimension reports its own state, so a hard cost breach is never
  // masked by a soft token threshold on the same row.
  const withState = (text: string, state: UsageBudgetState) =>
    state === "unbounded"
      ? text
      : `${text} · ${t(`usage.budgetState.${state}` as TranslationKey)}`;

  const parts = [
    t("usage.budgetScope"),
    withState(
      budget.tokens.hard !== undefined
        ? t("chat.tokenBudgetUsed", {
            used: formatTokens(budget.tokens.used),
            limit: formatTokens(budget.tokens.hard)
          })
        : t("chat.tokenBudgetUsedOnly", {
            used: formatTokens(budget.tokens.used)
          }),
      budget.tokens.state
    )
  ];

  if (budget.cost.hardMicros !== undefined) {
    parts.push(
      withState(
        t("chat.costBudgetUsed", {
          used: formatAmount(budget.cost.usedMicros),
          limit: formatAmount(budget.cost.hardMicros),
          currency: budget.cost.currency ?? ""
        }),
        budget.cost.state
      )
    );
  }

  const unknownAttempts =
    budget.tokens.unknownAttempts + budget.cost.unknownAttempts;
  if (unknownAttempts > 0) {
    parts.push(t("chat.budgetUnknownCoverage", { count: unknownAttempts }));
  }

  return <small>{parts.join(" · ")}</small>;
}

function BreakdownPanel<T extends UsageBreakdownEntry>({
  title,
  icon,
  entries,
  identify,
  renderNote,
  emptyLabel
}: {
  title: string;
  icon: ReactNode;
  entries: T[];
  identify: (entry: T) => BreakdownIdentity;
  renderNote?: (entry: T) => ReactNode;
  emptyLabel: string;
}) {
  const { t } = useI18n();
  return (
    <section className="panel usage-panel">
      <div className="panel-title">
        {icon}
        <h2>{title}</h2>
      </div>
      {entries.length === 0 ? (
        <p className="usage-empty">{emptyLabel}</p>
      ) : (
        <div className="usage-breakdown-list">
          <div className="usage-row-header">
            <span />
            <span>{t("usage.tokens")}</span>
            <span>{t("usage.cost")}</span>
          </div>
          {entries.map((entry) => {
            const identity = identify(entry);
            return (
              <div key={identity.id} className="usage-row">
                <div className="usage-row-label">
                  <strong>{identity.label}</strong>
                  {identity.detail ? <small>{identity.detail}</small> : null}
                  {renderNote ? renderNote(entry) : null}
                </div>
                <span className="usage-row-tokens">
                  {formatTokens(entry.tokens.totalTokens)}
                </span>
                <span className="usage-row-cost">
                  {entry.costTotals.length === 0
                    ? "—"
                    : entry.costTotals.map((total) => (
                        <span key={total.currency}>
                          {formatCost(total.costMicros, total.currency)}
                        </span>
                      ))}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

export function UsageWorkspace() {
  const { t } = useI18n();
  const [view, setView] = useState<UsageView | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load(silent = false) {
      if (!silent) setLoading(true);
      try {
        const next = await apiRequest<UsageView>("/api/usage");
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
    const timer = window.setInterval(() => void load(true), REFRESH_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  async function refresh() {
    setRefreshing(true);
    try {
      setView(await apiRequest<UsageView>("/api/usage"));
      setError(null);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setRefreshing(false);
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

  const currencies = view?.cost.totals ?? [];
  const unknownAttempts =
    (view?.coverage.unknownUsageAttempts ?? 0) +
    (view?.coverage.unknownPricingAttempts ?? 0);

  return (
    <div className="page-content usage-page">
      <PageHeader
        eyebrow={t("usage.eyebrow")}
        title={t("usage.title")}
        description={t("usage.description")}
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
            {t("usage.refresh")}
          </button>
        }
      />
      {error ? <div className="error-banner">{error}</div> : null}
      {view ? (
        <>
          <section className="usage-summary" aria-label={t("usage.title")}>
            <StatCard
              icon={<ChartColumn size={16} />}
              label={t("usage.windowLabel")}
              value={t(windowKey(view.window.kind))}
              detail={t(sourceKey(view.tokens.source))}
            />
            <StatCard
              icon={<Hash size={16} />}
              label={t("usage.tokens")}
              value={formatTokens(view.tokens.totalTokens)}
              detail={t("usage.attempts", { count: view.attemptCount })}
            />
            <StatCard
              icon={<Coins size={16} />}
              label={t("usage.cost")}
              value={
                currencies.length === 1
                  ? formatCost(currencies[0].costMicros, currencies[0].currency)
                  : currencies.length === 0
                    ? "—"
                    : t("usage.currencies", { count: currencies.length })
              }
              detail={t("usage.pricedAttempts", {
                count: view.cost.pricedAttemptCount
              })}
            />
            <StatCard
              icon={<AlertTriangle size={16} />}
              label={t("usage.coverage")}
              value={String(unknownAttempts)}
              detail={`${t("usage.unknownUsage")} ${view.coverage.unknownUsageAttempts} · ${t("usage.unknownPricing")} ${view.coverage.unknownPricingAttempts}`}
            />
          </section>

          {view.empty ? (
            <section className="panel usage-panel">
              <p className="usage-empty">{t("usage.empty")}</p>
            </section>
          ) : (
            <div className="usage-grid">
              <section className="panel usage-panel">
                <div className="panel-title">
                  <Hash size={17} />
                  <h2>{t("usage.tokens")}</h2>
                </div>
                <dl className="usage-breakdown">
                  <div>
                    <dt>{t("usage.inputTokens")}</dt>
                    <dd>{formatTokens(view.tokens.inputTokens)}</dd>
                  </div>
                  <div>
                    <dt>{t("usage.outputTokens")}</dt>
                    <dd>{formatTokens(view.tokens.outputTokens)}</dd>
                  </div>
                  <div>
                    <dt>{t("usage.cachedInputTokens")}</dt>
                    <dd>{formatTokens(view.tokens.cachedInputTokens)}</dd>
                  </div>
                  <div>
                    <dt>{t("usage.reasoningTokens")}</dt>
                    <dd>{formatTokens(view.tokens.reasoningTokens)}</dd>
                  </div>
                  <div>
                    <dt>{t("usage.totalTokens")}</dt>
                    <dd>{formatTokens(view.tokens.totalTokens)}</dd>
                  </div>
                </dl>
              </section>

              <section className="panel usage-panel">
                <div className="panel-title">
                  <Coins size={17} />
                  <h2>{t("usage.cost")}</h2>
                </div>
                <div className="usage-currencies">
                  {currencies.map((total) => (
                    <div key={total.currency} className="usage-currency">
                      <span>{total.currency}</span>
                      <strong>{formatAmount(total.costMicros)}</strong>
                    </div>
                  ))}
                  {currencies.length === 0 ? (
                    <p className="usage-empty">{t("usage.noCost")}</p>
                  ) : null}
                </div>
                <p className="usage-note">{t("usage.perCurrencyNote")}</p>
              </section>

              <BreakdownPanel
                title={t("usage.byModel")}
                icon={<Boxes size={17} />}
                entries={view.byModel}
                identify={(entry) => ({
                  id: `${entry.provider}/${entry.modelId}`,
                  label: entry.modelId,
                  detail: entry.provider
                })}
                emptyLabel={t("usage.noModels")}
              />

              <BreakdownPanel
                title={t("usage.byProvider")}
                icon={<Server size={17} />}
                entries={view.byProvider}
                identify={(entry) => ({
                  id: entry.provider,
                  label: entry.provider
                })}
                emptyLabel={t("usage.noProviders")}
              />

              <BreakdownPanel
                title={t("usage.byDiscussion")}
                icon={<UsersRound size={17} />}
                entries={view.byDiscussion}
                identify={(entry) => ({
                  id: entry.discussionId,
                  label: entry.title
                })}
                renderNote={(entry) => (
                  <DiscussionBudgetNote budget={entry.budget} />
                )}
                emptyLabel={t("usage.noDiscussions")}
              />

              <BreakdownPanel
                title={t("usage.byConversation")}
                icon={<MessagesSquare size={17} />}
                entries={view.byConversation}
                identify={(entry) => ({
                  id: entry.conversationId,
                  label: entry.title
                })}
                emptyLabel={t("usage.noConversations")}
              />
            </div>
          )}
          <p className="usage-updated">
            {t("usage.generatedAt", { time: formatTime(view.generatedAt) })}
          </p>
        </>
      ) : null}
    </div>
  );
}
