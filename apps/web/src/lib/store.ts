import { DEFAULT_WEIGHTS, type PriorityWeights } from "@triage/triage/priority";
import { useCallback, useState } from "react";

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...(JSON.parse(raw) as T) } : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // ignore
  }
}

/** Per-viewer convenience state (weights, selected repo). Shared state lives in Zero. */
export function useLocalState<T extends object>(key: string, fallback: T): [T, (next: T) => void] {
  const [value, setValue] = useState<T>(() => read(key, fallback));
  const set = useCallback(
    (next: T) => {
      setValue(next);
      write(key, next);
    },
    [key],
  );
  return [value, set];
}

export function useWeights() {
  return useLocalState<PriorityWeights>("typeful-triage.weights", DEFAULT_WEIGHTS);
}
