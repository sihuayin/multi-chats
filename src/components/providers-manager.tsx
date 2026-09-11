"use client";

import { KeyRound, LoaderCircle, RefreshCw, Trash2 } from "lucide-react";
import { useState } from "react";
import { apiRequest } from "@/lib/api";
import { useWorkspace } from "@/components/workspace-provider";
import { PageHeader } from "@/components/page-header";

const providerOptions = [
  ["openai", "OpenAI"],
  ["anthropic", "Anthropic"],
  ["google", "Google Gemini"],
  ["openrouter", "OpenRouter"],
  ["deepseek", "DeepSeek"],
  ["groq", "Groq"],
  ["mistral", "Mistral"]
] as const;

export function ProvidersManager() {
  const { data, refresh } = useWorkspace();
  const [provider, setProvider] = useState("openai");
  const [label, setLabel] = useState("Primary provider");
  const [credential, setCredential] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function createProvider() {
    setBusy(true);
    setError(null);
    try {
      await apiRequest("/api/providers", {
        method: "POST",
        body: JSON.stringify({ provider, label, credential })
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
    const credential = window.prompt("New API credential");
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
        eyebrow="Workspace configuration"
        title="Providers"
        description="Credentials stay encrypted on the server and are never returned to the browser."
      />
      {error ? <div className="error-banner">{error}</div> : null}
      <div className="two-column">
        <section className="panel">
          <div className="panel-title">
            <KeyRound size={17} />
            <h2>Add provider</h2>
          </div>
          <label>
            Provider
            <select value={provider} onChange={(event) => setProvider(event.target.value)}>
              {providerOptions.map(([value, text]) => (
                <option key={value} value={value}>
                  {text}
                </option>
              ))}
            </select>
          </label>
          <label>
            Label
            <input value={label} onChange={(event) => setLabel(event.target.value)} />
          </label>
          <label>
            API credential
            <input
              type="password"
              value={credential}
              onChange={(event) => setCredential(event.target.value)}
              autoComplete="off"
            />
          </label>
          <button
            className="button primary"
            onClick={createProvider}
            disabled={busy || !credential.trim()}
          >
            {busy ? <LoaderCircle className="spin" size={16} /> : <KeyRound size={16} />}
            Validate and save
          </button>
        </section>

        <section className="panel">
          <div className="panel-title">
            <KeyRound size={17} />
            <h2>Configured providers</h2>
          </div>
          <div className="stack-list">
            {(data?.providers ?? []).map((item) => (
              <article key={item.id} className="list-card">
                <div>
                  <strong>{item.label}</strong>
                  <span>{item.provider}</span>
                </div>
                <div className="button-row">
                  <button
                    className="icon-button"
                    title="Rotate credential"
                    onClick={() => rotateProvider(item.id)}
                    disabled={busy}
                  >
                    <RefreshCw size={16} />
                  </button>
                  <button
                    className="icon-button danger-text"
                    title="Delete provider"
                    onClick={() => removeProvider(item.id)}
                    disabled={busy}
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              </article>
            ))}
            {data?.providers.length === 0 ? (
              <p className="muted">No credentials configured.</p>
            ) : null}
          </div>
        </section>
      </div>
    </div>
  );
}
