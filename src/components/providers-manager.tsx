"use client";

import { KeyRound, LoaderCircle, RefreshCw, Trash2 } from "lucide-react";
import { useState } from "react";
import { apiRequest } from "@/lib/api";
import { providerCatalog } from "@/lib/provider-catalog";
import { useI18n } from "@/components/i18n-provider";
import { useWorkspace } from "@/components/workspace-provider";
import { PageHeader } from "@/components/page-header";

export function ProvidersManager() {
  const { data, refresh } = useWorkspace();
  const { t } = useI18n();
  const [provider, setProvider] = useState("openai");
  const [label, setLabel] = useState("");
  const [credential, setCredential] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function createProvider() {
    setBusy(true);
    setError(null);
    try {
      await apiRequest("/api/providers", {
        method: "POST",
        body: JSON.stringify({
          provider,
          label: label || t("providers.defaultLabel"),
          credential
        })
      });
      setCredential("");
      await refresh();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusy(false);
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

  async function rotateProvider(id: string) {
    const provider = data?.providers.find((item) => item.id === id);
    if (!provider) return;
    const credential = window.prompt(t("providers.newCredential"));
    if (!credential) return;
    setBusy(true);
    setError(null);
    try {
      await apiRequest(`/api/providers/${id}`, {
        method: "PUT",
        body: JSON.stringify({
          provider: provider.provider,
          label: provider.label,
          credential
        })
      });
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
        eyebrow={t("providers.eyebrow")}
        title={t("providers.title")}
        description={t("providers.description")}
      />
      {error ? <div className="error-banner">{error}</div> : null}
      <div className="provider-layout">
        <section className="panel provider-form-panel">
          <div className="panel-title">
            <KeyRound size={17} />
            <h2>{t("providers.add")}</h2>
          </div>
          <div className="provider-field-grid">
            <label>
              {t("providers.provider")}
              <select
                value={provider}
                onChange={(event) => setProvider(event.target.value)}
              >
                {providerCatalog.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t("providers.label")}
              <input
                value={label}
                placeholder={t("providers.defaultLabel")}
                onChange={(event) => setLabel(event.target.value)}
              />
            </label>
          </div>
          <label>
            {t("providers.apiCredential")}
            <input
              type="password"
              value={credential}
              onChange={(event) => setCredential(event.target.value)}
              autoComplete="off"
            />
          </label>
          <div className="provider-form-actions">
            <button
              className="button primary"
              onClick={createProvider}
              disabled={busy || !credential.trim()}
            >
              {busy ? (
                <LoaderCircle className="spin" size={16} />
              ) : (
                <KeyRound size={16} />
              )}
              {t("providers.validateSave")}
            </button>
          </div>
        </section>

        <section className="panel provider-list-panel">
          <div className="panel-title">
            <KeyRound size={17} />
            <h2>{t("providers.configured")}</h2>
          </div>
          <div className="stack-list">
            {(data?.providers ?? []).map((item) => (
              <article key={item.id} className="list-card provider-card">
                <div className="provider-identity">
                  <span className="provider-mark" aria-hidden="true">
                    {item.provider.slice(0, 2).toUpperCase()}
                  </span>
                  <div>
                    <strong>{item.label}</strong>
                    <span className="provider-code">{item.provider}</span>
                  </div>
                </div>
                <div className="button-row">
                  <button
                    className="icon-button"
                    title={t("providers.rotate")}
                    onClick={() => rotateProvider(item.id)}
                    disabled={busy}
                  >
                    <RefreshCw size={16} />
                  </button>
                  <button
                    className="icon-button danger-text"
                    title={t("providers.delete")}
                    onClick={() => removeProvider(item.id)}
                    disabled={busy}
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              </article>
            ))}
            {data?.providers.length === 0 ? (
              <p className="provider-empty">{t("providers.none")}</p>
            ) : null}
          </div>
        </section>
      </div>
    </div>
  );
}
