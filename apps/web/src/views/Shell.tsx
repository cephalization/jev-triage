import { Outlet, useNavigate } from "@tanstack/react-router";
import { cn } from "cn";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Sidebar } from "../components/Sidebar.tsx";
import { Sheet, SheetContent, SheetTitle } from "../components/ui/sheet.tsx";
import { useIssueRows, usePullRows, useRepo, useRepos } from "../lib/data.ts";
import { isTyping } from "../lib/keys.ts";
import { useNow, usePresenceHeartbeat } from "../lib/presence.ts";
import { useLocalState } from "../lib/store.ts";
import { useTheme } from "../lib/theme.ts";
import { rootRoute, type View, VIEW_PATH } from "../router.tsx";
import { ShellContext } from "./shell-context.ts";

const GO: Record<string, View> = { t: "triage", u: "unsure", p: "pulls", r: "repo", s: "system" };

/**
 * The frame around every view: sidebar (with live counts), the mobile navigation sheet, the
 * busy bar, and the global keys. The URL's `repo` is resolved here; views read it back.
 */
export function Shell() {
  const { session, logout, onSessionRejected } = rootRoute.useRouteContext();
  const search = rootRoute.useSearch();
  const navigate = useNavigate();
  const repos = useRepos();
  const [{ repoId: storedRepo }, setStoredRepo] = useLocalState<{ repoId: string | null }>(
    "typeful-triage.repo",
    { repoId: null },
  );
  // The URL names the repository; the last one is also remembered per browser for bare URLs.
  const wanted = search.repo ?? storedRepo;
  const repoId =
    wanted && repos.some((r) => r.id === wanted) ? wanted : (repos[0]?.id ?? wanted ?? null);
  useEffect(() => {
    if (!repoId) return;
    if (repoId !== search.repo)
      void navigate({ to: ".", search: (s) => ({ ...s, repo: repoId }), replace: true });
    if (repoId !== storedRepo) setStoredRepo({ repoId });
  }, [repoId, search.repo, storedRepo, navigate, setStoredRepo]);

  const repo = useRepo(repoId);
  const { rows } = useIssueRows(repoId, { state: "open", search: "" });
  const { pullRows } = usePullRows(repoId, { state: "open", search: "" });
  const counts = useMemo(
    () => ({
      triage: rows.filter((r) => !r.done).length,
      unsure: rows.filter((r) => !r.done && r.needsReview).length,
      pulls: pullRows.filter((r) => r.pull.state === "open").length,
    }),
    [rows, pullRows],
  );

  const [navOpen, setNavOpen] = useState(false);
  const [theme, setTheme] = useTheme();
  const now = useNow();
  const busy = repo?.sync_status === "running" || !!repo?.workerState?.in_flight;
  const shell = useMemo(() => ({ openNav: () => setNavOpen(true) }), []);

  // Presence: which issue this tab has open, read from the URL.
  const issueId = useOpenIssueId();
  usePresenceHeartbeat(repoId, issueId, onSessionRejected);

  // g then t/u/p/r/s switches views; / focuses the search box. Lists own j/k and Esc.
  const goTo = useCallback(
    (v: View) => {
      void navigate({ to: VIEW_PATH[v], search: (s) => ({ repo: s.repo }) });
      setNavOpen(false);
    },
    [navigate],
  );
  const chord = useRef(0);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e)) return;
      const chorded = Date.now() - chord.current < 800;
      chord.current = 0;
      if (chorded && GO[e.key]) {
        e.preventDefault();
        goTo(GO[e.key]!);
      } else if (e.key === "g") {
        chord.current = Date.now();
      } else if (e.key === "/") {
        e.preventDefault();
        document.querySelector<HTMLInputElement>("input[data-search]")?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [goTo]);

  const sidebar = (
    <Sidebar
      session={session}
      repoId={repoId}
      counts={counts}
      onNavigate={() => setNavOpen(false)}
      onLogout={logout}
      theme={theme}
      setTheme={setTheme}
      now={now}
    />
  );

  return (
    <ShellContext.Provider value={shell}>
      <div className="isolate flex h-dvh overflow-hidden bg-background text-sm text-foreground antialiased">
        <aside className="w-60 shrink-0 border-r border-sidebar-border max-lg:hidden">
          {sidebar}
        </aside>
        <Sheet open={navOpen} onOpenChange={setNavOpen}>
          <SheetContent side="left" className="w-64 p-0 pt-8">
            <SheetTitle className="sr-only">Navigation</SheetTitle>
            {sidebar}
          </SheetContent>
        </Sheet>
        <main className="relative flex min-w-0 flex-1 flex-col">
          <div
            className={cn(
              "pointer-events-none absolute inset-x-0 top-0 z-20 h-0.5 overflow-hidden transition-opacity",
              busy ? "opacity-100" : "opacity-0",
            )}
            aria-hidden="true"
          >
            <div className="h-full w-1/3 animate-[indeterminate_1.2s_ease-in-out_infinite] bg-primary" />
          </div>
          <Outlet />
        </main>
      </div>
    </ShellContext.Provider>
  );
}

/** The issue open in the split panel, if the current URL names one. */
function useOpenIssueId(): string | null {
  const path = useRouterPath();
  const [, view, id] = path.split("/");
  return (view === "triage" || view === "unsure") && id ? decodeURIComponent(id) : null;
}

function useRouterPath(): string {
  // useLocation re-renders on every navigation; the pathname is all presence needs.
  return useLocationPathname();
}

import { useLocation } from "@tanstack/react-router";
function useLocationPathname(): string {
  return useLocation({ select: (l) => l.pathname });
}
