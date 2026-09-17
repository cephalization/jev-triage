import { useEffect, useRef, useState } from "react";

/**
 * Measured width of an element, for deciding which table columns to render. Columns are
 * chosen in code rather than hidden with CSS because a fixed-layout table maps cells to
 * columns by position: a cell with display:none vanishes from the row and shifts every
 * cell after it into the wrong column.
 */
export function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.getBoundingClientRect().width);
    const ro = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

/** Breakpoints for list density, in px of the list's own width (not the viewport). */
export const NARROW = 768;
export const MEDIUM = 1024;
