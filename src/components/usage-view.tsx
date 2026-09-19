"use client";

import {
  AlertTriangle,
  ChartColumn,
  Coins,
  Hash,
  LoaderCircle,
  RefreshCw
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useI18n } from "@/components/i18n-provider";
import { PageHeader } from "@/components/page-header";
import { apiRequest } from "@/lib/api";
import type { TranslationKey } from "@/lib/i18n";
import type { UsageView, UsageWindow } from "@/lib/usage-view";

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
