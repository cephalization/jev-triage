import { useCallback, useEffect, useState } from "react";

export type Theme = "system" | "light" | "dark";
const KEY = "typeful-triage.theme";

export function loadTheme(): Theme {
  try {
    const t = localStorage.getItem(KEY);
    return t === "light" || t === "dark" ? t : "system";
  } catch {
    return "system";
  }
}

/** The CSS only looks at html.light / html.dark; "system" clears both so prefers-color-scheme wins. */
export function applyTheme(theme: Theme) {
  const root = document.documentElement;
  root.classList.toggle("light", theme === "light");
  root.classList.toggle("dark", theme === "dark");
}

/**
 * The theme in effect, resolved to light or dark, for components that theme themselves (the
 * diff renderer runs in a shadow root and cannot see our CSS variables). Follows the class as
 * the shell toggles it and the OS preference when no class is set.
 */
export function useResolvedTheme(): "light" | "dark" {
  const read = (): "light" | "dark" => {
    const c = document.documentElement.classList;
    if (c.contains("dark")) return "dark";
    if (c.contains("light")) return "light";
    return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  };
  const [type, setType] = useState(read);
  useEffect(() => {
    const update = () => setType(read());
    const obs = new MutationObserver(update);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    const mq = matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", update);
    return () => {
      obs.disconnect();
      mq.removeEventListener("change", update);
    };
  }, []);
  return type;
}

export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setThemeState] = useState<Theme>(() => loadTheme());
  useEffect(() => applyTheme(theme), [theme]);
  const setTheme = useCallback((t: Theme) => {
    setThemeState(t);
    try {
      localStorage.setItem(KEY, t);
    } catch {
      // storage unavailable; the choice lives for this page only
    }
  }, []);
  return [theme, setTheme];
}
