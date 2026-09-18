import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  redirect,
  retainSearchParams,
  stripSearchParams,
} from "@tanstack/react-router";
import type { Session } from "./lib/auth.ts";
import {
  PULLS_DEFAULTS,
  pullsSearch,
  REVIEW_DEFAULTS,
  reviewSearch,
  rootSearch,
  TRIAGE_DEFAULTS,
  triageSearch,
  UNSURE_DEFAULTS,
  unsureSearch,
} from "./lib/search.ts";
import { PullsView } from "./views/PullsView.tsx";
import { RepoView } from "./views/RepoView.tsx";
import { ReviewView } from "./views/ReviewView.tsx";
import { Shell } from "./views/Shell.tsx";
import { SystemView } from "./views/SystemView.tsx";
import { TriageView } from "./views/TriageView.tsx";
import { UnsureView } from "./views/UnsureView.tsx";

/**
 * `/{view}/{id}?repo=owner/name&…filters`. The repository rides along on every route; each
 * list validates its own filters and strips defaults so URLs only say what differs.
 */

export interface RouterContext {
  session: Session;
  logout: () => void;
  onSessionRejected: (error: unknown) => void;
}

export const rootRoute = createRootRouteWithContext<RouterContext>()({
  validateSearch: rootSearch,
  search: { middlewares: [retainSearchParams(["repo"])] },
  component: Shell,
  notFoundComponent: NotFound,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: ({ search }) => {
    throw redirect({ to: "/triage", search: { repo: search.repo } });
  },
});

export const triageRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "triage",
  validateSearch: triageSearch,
  search: { middlewares: [stripSearchParams(TRIAGE_DEFAULTS)] },
  component: TriageView,
});
const triageIssueRoute = createRoute({ getParentRoute: () => triageRoute, path: "$issueId" });

export const unsureRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "unsure",
  validateSearch: unsureSearch,
  search: { middlewares: [stripSearchParams(UNSURE_DEFAULTS)] },
  component: UnsureView,
});
const unsureIssueRoute = createRoute({ getParentRoute: () => unsureRoute, path: "$issueId" });

export const pullsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "pulls",
  validateSearch: pullsSearch,
  search: { middlewares: [stripSearchParams(PULLS_DEFAULTS)] },
  component: PullsView,
});
const pullRoute = createRoute({ getParentRoute: () => pullsRoute, path: "$pullId" });

/** The full-screen guided review of one pull request; more specific than /pulls/$pullId. */
export const reviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "pulls/$pullId/review",
  validateSearch: reviewSearch,
  search: { middlewares: [stripSearchParams(REVIEW_DEFAULTS)] },
  component: ReviewView,
});

export const repoRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "repo",
  component: RepoView,
});
export const systemRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "system",
  component: SystemView,
});

export type View = "triage" | "unsure" | "pulls" | "repo" | "system";
export const VIEW_PATH = {
  triage: "/triage",
  unsure: "/unsure",
  pulls: "/pulls",
  repo: "/repo",
  system: "/system",
} as const;

const routeTree = rootRoute.addChildren([
  indexRoute,
  triageRoute.addChildren([triageIssueRoute]),
  unsureRoute.addChildren([unsureIssueRoute]),
  pullsRoute.addChildren([pullRoute]),
  reviewRoute,
  repoRoute,
  systemRoute,
]);

function NotFound() {
  return (
    <div className="flex flex-1 items-center justify-center p-10 text-sm text-muted-foreground">
      Nothing here.{" "}
      <a className="ml-1 underline" href="/triage">
        Back to triage.
      </a>
    </div>
  );
}

export function makeRouter(context: RouterContext) {
  return createRouter({ routeTree, context, defaultPreload: false });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof makeRouter>;
  }
}
