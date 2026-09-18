import { useQuery, useZero } from "@rocicorp/zero/react";
import {
  mutators,
  PROVIDER_KINDS,
  queries,
  type ProviderKind,
  type ProviderModel,
} from "@triage/schema";
import { Check, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { apiJson } from "../lib/api.ts";
import type { Session } from "../lib/auth.ts";
import { Tag } from "./Marks.tsx";
import { Button } from "./ui/button.tsx";
import { Input } from "./ui/input.tsx";
import { Label } from "./ui/label.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select.tsx";
import { Textarea } from "./ui/textarea.tsx";

interface KindInfo {
  label: string;
  baseUrl: string | null;
  keyEnv: string;
}

const FALLBACK_KINDS: Record<ProviderKind, KindInfo> = {
  anthropic: { label: "Anthropic", baseUrl: "https://api.anthropic.com/v1", keyEnv: "" },
  openai: { label: "OpenAI", baseUrl: "https://api.openai.com/v1", keyEnv: "" },
  openrouter: { label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", keyEnv: "" },
  "openai-compatible": { label: "OpenAI-compatible", baseUrl: null, keyEnv: "" },
};

/**
 * Admin-only: the model providers reviews can run on. The row (kind, label, base URL, models)
 * syncs through Zero; the key goes straight to the API and only its tail ever comes back.
 */
export function Providers({ session }: { session: Session }) {
  const z = useZero();
  const [providers] = useQuery(queries.providers.all());
  const [kinds, setKinds] = useState<Record<ProviderKind, KindInfo>>(FALLBACK_KINDS);
  useEffect(() => {
    apiJson<{ kinds: Record<ProviderKind, KindInfo> }>(session.token, "/api/providers/kinds")
      .then((d) => setKinds(d.kinds))
      .catch(() => {});
  }, [session.token]);

  return (
    <div className="flex flex-col gap-6">
      {providers.map((p) => (
        <ProviderCard key={p.id} provider={p} session={session} kinds={kinds} />
      ))}
      {providers.length === 0 && (
        <p className="text-xs text-muted-foreground">
          No providers yet. Add one below; reviews cannot run until a provider has a key.
        </p>
      )}
      <AddProvider kinds={kinds} onAdd={(args) => void z.mutate(mutators.provider.save(args))} />
    </div>
  );
}

function AddProvider({
  kinds,
  onAdd,
}: {
  kinds: Record<ProviderKind, KindInfo>;
  onAdd: (args: { id: string; kind: ProviderKind; label: string; baseUrl: string }) => void;
}) {
  const [kind, setKind] = useState<ProviderKind>("anthropic");
  const [label, setLabel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const defaultBase = kinds[kind].baseUrl;
  const effectiveBase = defaultBase ?? baseUrl.trim();
  const ok = label.trim().length > 0 && /^https?:\/\//.test(effectiveBase);
  return (
    <form
      className="flex flex-col gap-3 border-t pt-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ok) return;
        onAdd({
          id: `pv_${crypto.randomUUID().slice(0, 8)}`,
          kind,
          label: label.trim(),
          baseUrl: effectiveBase,
        });
        setLabel("");
        setBaseUrl("");
      }}
    >
      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="pv-kind">Kind</Label>
          <Select value={kind} onValueChange={(v) => setKind(v as ProviderKind)}>
            <SelectTrigger id="pv-kind" size="sm" className="h-8">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PROVIDER_KINDS.map((k) => (
                <SelectItem key={k} value={k}>
                  {kinds[k].label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="pv-label">Label</Label>
          <Input
            id="pv-label"
            className="h-8"
            placeholder={kinds[kind].label}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
        </div>
        {defaultBase === null && (
          <div className="col-span-2 flex flex-col gap-1.5">
            <Label htmlFor="pv-base">Base URL</Label>
            <Input
              id="pv-base"
              className="h-8"
              placeholder="https://host/v1"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              spellCheck={false}
            />
          </div>
        )}
      </div>
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs text-muted-foreground">
          {defaultBase ? defaultBase : "Any server that speaks the OpenAI chat API."}
        </span>
        <Button type="submit" size="sm" disabled={!ok}>
          Add provider
        </Button>
      </div>
    </form>
  );
}

function ProviderCard({
  provider: p,
  session,
  kinds,
}: {
  provider: {
    id: string;
    kind: string;
    label: string;
    base_url: string;
    key_hint: string | null;
    models_json: ProviderModel[];
  };
  session: Session;
  kinds: Record<ProviderKind, KindInfo>;
}) {
  const z = useZero();
  const kind = (p.kind in kinds ? p.kind : "openai-compatible") as ProviderKind;
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState<"key" | "models" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const models = useMemo(
    () => (Array.isArray(p.models_json) ? p.models_json : []),
    [p.models_json],
  );
  const [modelText, setModelText] = useState("");
  useEffect(() => {
    setModelText(models.map((m) => (m.enabled ? m.id : `# ${m.id}`)).join("\n"));
  }, [models]);
  const enabled = models.filter((m) => m.enabled).length;

  async function saveKey() {
    if (!key.trim()) return;
    setBusy("key");
    setError(null);
    try {
      await apiJson(session.token, `/api/providers/${p.id}/key`, {
        method: "PUT",
        body: { key: key.trim() },
      });
      setKey("");
      setNotice("Key saved.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }
  async function clearKey() {
    setBusy("key");
    setError(null);
    try {
      await apiJson(session.token, `/api/providers/${p.id}/key`, { method: "DELETE" });
      setNotice("Key removed.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }
  async function fetchModels() {
    setBusy("models");
    setError(null);
    try {
      const { models: fresh } = await apiJson<{ models: { id: string; label: string }[] }>(
        session.token,
        `/api/providers/${p.id}/models`,
        { method: "POST" },
      );
      const known = new Map(models.map((m) => [m.id, m.enabled]));
      // New models arrive disabled unless the list was empty, so a 300-model catalog stays quiet.
      const merged = fresh.map((m) => ({ ...m, enabled: known.get(m.id) ?? models.length === 0 }));
      await z.mutate(
        mutators.provider.save({
          id: p.id,
          kind,
          label: p.label,
          baseUrl: p.base_url,
          models: merged,
        }),
      ).client;
      setNotice(`${fresh.length} models listed.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }
  function saveModelText() {
    const lines = modelText
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    const labels = new Map(models.map((m) => [m.id, m.label]));
    const next: ProviderModel[] = lines.map((l) => {
      const off = l.startsWith("#");
      const id = l.replace(/^#\s*/, "");
      return { id, label: labels.get(id) ?? id, enabled: !off };
    });
    void z.mutate(
      mutators.provider.save({ id: p.id, kind, label: p.label, baseUrl: p.base_url, models: next }),
    );
    setEditing(false);
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <span className="font-medium">{p.label}</span>
        <Tag>{kinds[kind].label}</Tag>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{p.base_url}</span>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={`Remove ${p.label}`}
          onClick={() => {
            if (confirm(`Remove ${p.label} and its key?`))
              void z.mutate(mutators.provider.remove({ id: p.id }));
          }}
        >
          <Trash2 />
        </Button>
      </div>

      <div className="flex items-center gap-2">
        <span className="w-16 shrink-0 text-xs text-muted-foreground">Key</span>
        {p.key_hint ? (
          <>
            <span className="inline-flex items-center gap-1 text-xs">
              <Check className="size-3 text-status-good" strokeWidth={3} />
              set {p.key_hint}
            </span>
            <span className="flex-1" />
            <Button size="xs" variant="ghost" disabled={busy !== null} onClick={clearKey}>
              Remove key
            </Button>
          </>
        ) : (
          <>
            <Input
              className="h-8"
              type="password"
              placeholder={`${kinds[kind].label} API key`}
              value={key}
              onChange={(e) => setKey(e.target.value)}
              autoComplete="off"
            />
            <Button size="sm" disabled={busy !== null || !key.trim()} onClick={saveKey}>
              {busy === "key" ? "Saving…" : "Save key"}
            </Button>
          </>
        )}
      </div>

      <div className="flex items-start gap-2">
        <span className="w-16 shrink-0 pt-1 text-xs text-muted-foreground">Models</span>
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          {editing ? (
            <>
              <Textarea
                rows={Math.min(12, Math.max(4, models.length + 1))}
                className="font-mono text-xs"
                value={modelText}
                onChange={(e) => setModelText(e.target.value)}
                spellCheck={false}
                placeholder={"one model id per line\n# a leading # keeps it listed but disabled"}
              />
              <div className="flex gap-2">
                <Button size="xs" onClick={saveModelText}>
                  Save models
                </Button>
                <Button size="xs" variant="ghost" onClick={() => setEditing(false)}>
                  Cancel
                </Button>
              </div>
            </>
          ) : (
            <div className="flex flex-wrap items-center gap-1.5">
              {models
                .filter((m) => m.enabled)
                .slice(0, 12)
                .map((m) => (
                  <Tag key={m.id}>{m.id}</Tag>
                ))}
              {enabled > 12 && <Tag>+{enabled - 12}</Tag>}
              {enabled === 0 && (
                <span className="text-xs text-muted-foreground">
                  none enabled{models.length ? ` (${models.length} listed)` : ""}
                </span>
              )}
              <Button size="xs" variant="ghost" onClick={() => setEditing(true)}>
                Edit
              </Button>
              <Button
                size="xs"
                variant="ghost"
                disabled={busy !== null || !p.key_hint}
                onClick={fetchModels}
                title={p.key_hint ? "Ask the provider for its model list" : "Set a key first"}
              >
                <RefreshCw className={busy === "models" ? "animate-spin" : ""} />
                Fetch
              </Button>
            </div>
          )}
        </div>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
      {notice && !error && <p className="text-xs text-muted-foreground">{notice}</p>}
    </div>
  );
}
