import { useEffect } from "react";

export function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return (
    !!t &&
    (t.tagName === "INPUT" ||
      t.tagName === "TEXTAREA" ||
      t.tagName === "SELECT" ||
      t.isContentEditable ||
      t.getAttribute("role") === "combobox")
  );
}

/** The neighbour to land on when `selectedId` leaves the list (marked done, for example). */
export function neighbourOf(ids: readonly string[], selectedId: string | null): string | null {
  const idx = ids.indexOf(selectedId ?? "");
  if (idx < 0) return null;
  return ids[idx + 1] ?? ids[idx - 1] ?? null;
}

export function scrollRowIntoView(id: string) {
  document
    .querySelector(`[data-issue-id="${id}"], [data-pull-id="${id}"]`)
    ?.scrollIntoView({ block: "nearest" });
}

/**
 * List navigation for a view: j/k and the arrows move the selection through `ids` in display
 * order, Esc closes. Modifier keys and typing are left alone; view switching lives in the
 * shell and the panels own their own letters.
 */
export function useListKeys({
  ids,
  selectedId,
  onSelect,
  onClose,
}: {
  ids: readonly string[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const move = (delta: number) => {
      if (ids.length === 0) return;
      const idx = ids.indexOf(selectedId ?? "");
      const next =
        idx < 0
          ? delta > 0
            ? 0
            : ids.length - 1
          : Math.min(ids.length - 1, Math.max(0, idx + delta));
      const id = ids[next]!;
      onSelect(id);
      scrollRowIntoView(id);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Escape") {
        (document.activeElement as HTMLElement | null)?.blur();
        onClose();
        return;
      }
      if (isTyping(e)) return;
      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        move(1);
      } else if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        move(-1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ids, selectedId, onSelect, onClose]);
}
