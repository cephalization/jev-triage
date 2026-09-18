import { useQuery, useZero } from "@rocicorp/zero/react";
import { mutators, queries, type ProviderModel } from "@triage/schema";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select.tsx";

const NONE = "__none__";

/** Per-repo default provider and model for guided reviews; a shared knob like the others. */
export function ReviewDefaults({
  repo,
}: {
  repo: { id: string; review_provider_id: string | null; review_model: string | null };
}) {
  const z = useZero();
  const [providers] = useQuery(queries.providers.all());
  const ready = providers.filter((p) => p.key_hint);
  const current = providers.find((p) => p.id === repo.review_provider_id) ?? null;
  const models: ProviderModel[] = current
    ? (Array.isArray(current.models_json) ? current.models_json : []).filter((m) => m.enabled)
    : [];
  const set = (patch: { reviewProviderId?: string | null; reviewModel?: string | null }) =>
    void z.mutate(mutators.repo.setKnobs({ repoId: repo.id, ...patch }));

  if (providers.length === 0)
    return (
      <p className="text-xs text-muted-foreground">
        No providers configured yet. An admin adds them in the Providers section above.
      </p>
    );
  return (
    <div className="grid grid-cols-2 gap-3">
      <div className="flex flex-col gap-1.5">
        <span className="text-xs text-muted-foreground">Provider</span>
        <Select
          value={repo.review_provider_id ?? NONE}
          onValueChange={(v) => set({ reviewProviderId: v === NONE ? null : v, reviewModel: null })}
        >
          <SelectTrigger size="sm" className="h-8" aria-label="Review provider">
            <SelectValue placeholder="Pick a provider" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>none</SelectItem>
            {providers.map((p) => (
              <SelectItem key={p.id} value={p.id} disabled={!p.key_hint}>
                {p.label}
                {!p.key_hint && (
                  <span className="ml-auto text-xs text-muted-foreground [[data-slot=select-value]_&]:hidden">
                    no key
                  </span>
                )}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-xs text-muted-foreground">Model</span>
        <Select
          value={repo.review_model ?? NONE}
          onValueChange={(v) => set({ reviewModel: v === NONE ? null : v })}
          disabled={!current}
        >
          <SelectTrigger size="sm" className="h-8" aria-label="Review model">
            <SelectValue placeholder={current ? "Pick a model" : "Pick a provider first"} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>none</SelectItem>
            {repo.review_model && !models.some((m) => m.id === repo.review_model) && (
              <SelectItem value={repo.review_model}>{repo.review_model}</SelectItem>
            )}
            {models.map((m) => (
              <SelectItem key={m.id} value={m.id}>
                {m.label === m.id ? m.id : `${m.label} (${m.id})`}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {ready.length === 0 && (
        <p className="col-span-2 text-xs text-muted-foreground">
          No provider has a key yet, so nothing can run.
        </p>
      )}
    </div>
  );
}
