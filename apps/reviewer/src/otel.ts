import { createWorkersTracing, type WorkersTracing } from "@triage/openinference-workers";

/**
 * One tracer provider per isolate per collector. The API names the collector, the project and
 * any headers the collector wants (a Phoenix API key) in each stage request; they are
 * deployment configuration, not per-review state, so the first request builds the provider
 * and later ones reuse it. Without a collector the cell traces into nothing.
 */
export interface TraceTarget {
  endpoint: string;
  project: string;
  headers?: Record<string, string>;
}

const providers = new Map<string, WorkersTracing>();

export function tracingFor(target: TraceTarget | null): WorkersTracing | null {
  if (!target) return null;
  const key = `${target.endpoint}|${target.project}|${JSON.stringify(target.headers ?? {})}`;
  let t = providers.get(key);
  if (!t) {
    t = createWorkersTracing({
      endpoint: target.endpoint,
      projectName: target.project,
      serviceName: "typeful-reviewer",
      headers: target.headers,
    });
    providers.set(key, t);
  }
  return t;
}
