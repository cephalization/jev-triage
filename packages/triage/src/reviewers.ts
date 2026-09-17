import type { ReviewerCandidate } from "./types.ts";

/**
 * Reviewer statistics and shortlisting, all pure and derived from synced pull requests.
 *  - deriveReviewers: who has reviewed what, from closed + open pulls and their reviews;
 *  - rankReviewers: the code-side shortlist for one pull (directory overlap, recency, volume);
 *  - assignReviewers: spread the model's per-pull reviewer distributions across people so
 *    one expert does not get every pull. Runs in the UI; changes no inference.
 */

export interface ReviewEvent {
  pullId: string;
  reviewer: string;
  /** APPROVED | CHANGES_REQUESTED | COMMENTED | DISMISSED | PENDING */
  state: string;
  submittedAt: number;
}

export interface PullForStats {
  id: string;
  title: string;
  author: string;
  state: string;
  createdAt: number;
  files: readonly string[];
  requestedReviewers: readonly string[];
}

export interface ReviewerStats {
  login: string;
  reviews: number;
  approvals: number;
  changesRequested: number;
  lastReviewAt: number | null;
  medianResponseHours: number | null;
  /** Directories reviewed, most first. */
  dirs: { dir: string; count: number }[];
  recentTitles: string[];
  openLoad: number;
}

export const DIR_DEPTH = 2;
export const DIRS_KEPT = 12;
export const TITLES_KEPT = 6;
export const RECENCY_HALF_LIFE_DAYS = 45;
export const SHORTLIST = 5;

const DAY_MS = 86_400_000;

/** GitHub apps and AI review accounts: useful history, never a suggested reviewer. */
export function isBot(login: string): boolean {
  return (
    /\[bot\]$/i.test(login) ||
    /^(dependabot|renovate|github-|codecov|copilot|claude|coderabbit|gemini-code|cursor|devin|codex)/i.test(
      login,
    )
  );
}

/** `src/api/routes.ts` → `src/api`; a root file stays as its own name. */
export function dirOf(path: string, depth = DIR_DEPTH): string {
  const parts = path.split("/");
  if (parts.length === 1) return parts[0]!;
  return parts.slice(0, Math.min(depth, parts.length - 1)).join("/");
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export function deriveReviewers(
  pulls: readonly PullForStats[],
  reviews: readonly ReviewEvent[],
): ReviewerStats[] {
  const byId = new Map(pulls.map((p) => [p.id, p]));
  type Acc = {
    reviews: number;
    approvals: number;
    changesRequested: number;
    lastReviewAt: number | null;
    dirs: Map<string, number>;
    responses: number[];
    approved: { at: number; title: string }[];
    seenPulls: Set<string>;
    firstReview: Map<string, number>;
  };
  const acc = new Map<string, Acc>();
  const get = (login: string): Acc => {
    let a = acc.get(login);
    if (!a) {
      a = {
        reviews: 0,
        approvals: 0,
        changesRequested: 0,
        lastReviewAt: null,
        dirs: new Map(),
        responses: [],
        approved: [],
        seenPulls: new Set(),
        firstReview: new Map(),
      };
      acc.set(login, a);
    }
    return a;
  };

  for (const r of reviews) {
    if (r.state === "PENDING" || isBot(r.reviewer)) continue;
    const pull = byId.get(r.pullId);
    if (!pull || pull.author === r.reviewer) continue;
    const a = get(r.reviewer);
    a.reviews += 1;
    if (r.state === "APPROVED") {
      a.approvals += 1;
      a.approved.push({ at: r.submittedAt, title: pull.title });
    }
    if (r.state === "CHANGES_REQUESTED") a.changesRequested += 1;
    if (a.lastReviewAt === null || r.submittedAt > a.lastReviewAt) a.lastReviewAt = r.submittedAt;
    const first = a.firstReview.get(pull.id);
    if (first === undefined || r.submittedAt < first) a.firstReview.set(pull.id, r.submittedAt);
    if (!a.seenPulls.has(pull.id)) {
      a.seenPulls.add(pull.id);
      // Count each directory once per pull so a 200-file pull does not dominate.
      for (const d of new Set(pull.files.map((f) => dirOf(f)))) {
        a.dirs.set(d, (a.dirs.get(d) ?? 0) + 1);
      }
    }
  }

  // Open load: requested on, or already reviewing, a pull that is still open.
  const load = new Map<string, number>();
  for (const p of pulls) {
    if (p.state !== "open") continue;
    const people = new Set(p.requestedReviewers);
    for (const [login, a] of acc) if (a.seenPulls.has(p.id)) people.add(login);
    for (const login of people) load.set(login, (load.get(login) ?? 0) + 1);
  }

  const out: ReviewerStats[] = [];
  for (const [login, a] of acc) {
    for (const [pullId, at] of a.firstReview) {
      const p = byId.get(pullId);
      if (p) a.responses.push(Math.max(0, (at - p.createdAt) / 3_600_000));
    }
    out.push({
      login,
      reviews: a.reviews,
      approvals: a.approvals,
      changesRequested: a.changesRequested,
      lastReviewAt: a.lastReviewAt,
      medianResponseHours: median(a.responses),
      dirs: [...a.dirs.entries()]
        .map(([dir, count]) => ({ dir, count }))
        .sort((x, y) => y.count - x.count || x.dir.localeCompare(y.dir))
        .slice(0, DIRS_KEPT),
      recentTitles: a.approved
        .sort((x, y) => y.at - x.at)
        .slice(0, TITLES_KEPT)
        .map((t) => t.title),
      openLoad: load.get(login) ?? 0,
    });
  }
  return out.sort((x, y) => y.reviews - x.reviews || x.login.localeCompare(y.login));
}

/** Share of the pull's directories this reviewer has reviewed at least a few times. */
export function pathOverlap(
  files: readonly string[],
  dirs: readonly { dir: string; count: number }[],
) {
  const pullDirs = [...new Set(files.map((f) => dirOf(f)))];
  if (pullDirs.length === 0) return 0;
  const exact = new Map(dirs.map((d) => [d.dir, d.count]));
  const top = new Map<string, number>();
  for (const d of dirs) {
    const t = d.dir.split("/")[0]!;
    top.set(t, (top.get(t) ?? 0) + d.count);
  }
  let sum = 0;
  for (const d of pullDirs) {
    const c = exact.get(d);
    if (c !== undefined) {
      sum += Math.min(1, c / 3);
      continue;
    }
    const t = top.get(d.split("/")[0]!);
    if (t !== undefined) sum += 0.5 * Math.min(1, t / 3);
  }
  return sum / pullDirs.length;
}

export function rankReviewers(
  pull: { author: string; files: readonly string[]; requestedReviewers: readonly string[] },
  reviewers: readonly ReviewerStats[],
  now: number,
  max = SHORTLIST,
): ReviewerCandidate[] {
  const maxReviews = Math.max(1, ...reviewers.map((r) => r.reviews));
  const scored = reviewers
    .filter((r) => r.login !== pull.author && r.reviews > 0 && !isBot(r.login))
    .map((r) => {
      const overlap = pathOverlap(pull.files, r.dirs);
      const ageDays = r.lastReviewAt === null ? null : (now - r.lastReviewAt) / DAY_MS;
      const recency = ageDays === null ? 0 : Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS);
      const volume = Math.log1p(r.reviews) / Math.log1p(maxReviews);
      const requested = pull.requestedReviewers.includes(r.login);
      const score = 0.6 * overlap + 0.2 * recency + 0.2 * volume + (requested ? 0.1 : 0);
      return { r, overlap, ageDays, requested, score };
    })
    .sort((a, b) => b.score - a.score || a.r.login.localeCompare(b.r.login));
  return scored.slice(0, max).map(({ r, overlap, ageDays, requested }) => ({
    login: r.login,
    reviews: r.reviews,
    approvals: r.approvals,
    dirs: r.dirs.map((d) => d.dir),
    recentTitles: r.recentTitles,
    openLoad: r.openLoad,
    lastReviewDays: ageDays,
    pathOverlap: overlap,
    requested,
  }));
}

export interface AssignablePull {
  id: string;
  /** Higher first: these get their preferred reviewer before the rest. */
  priority: number;
  /** Model probabilities keyed by login (already resolved from candidate keys). */
  probabilities: Readonly<Record<string, number>>;
}

export interface Assignment {
  login: string;
  /** Probability the model gave this reviewer for this pull. */
  probability: number;
  /** True when someone else was the model's first pick but was already loaded. */
  balanced: boolean;
}

/** Existing open load counts at this fraction of a fresh assignment (they may be near done). */
export const EXISTING_LOAD_WEIGHT = 1 / 3;

/**
 * Greedy load balancing over the model's distributions. Each pull, in priority order, takes
 * the reviewer maximising p(login) − penalty × (assignments so far + existing open load / 3).
 * With penalty 0 this is just the argmax; the default trades ~0.12 of probability per pull
 * already handed out here, so a repo's busiest expert is not wiped out by their current queue.
 */
export function assignReviewers(
  pulls: readonly AssignablePull[],
  openLoad: Readonly<Record<string, number>> = {},
  penalty = 0.12,
): Map<string, Assignment> {
  const load = new Map<string, number>(
    Object.entries(openLoad).map(([k, v]) => [k, v * EXISTING_LOAD_WEIGHT]),
  );
  const out = new Map<string, Assignment>();
  const ordered = [...pulls].sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
  for (const p of ordered) {
    const entries = Object.entries(p.probabilities).filter(([k]) => k !== "none");
    if (entries.length === 0) continue;
    let best: { login: string; probability: number; adjusted: number } | null = null;
    let top: { login: string; probability: number } | null = null;
    for (const [login, probability] of entries) {
      if (!top || probability > top.probability) top = { login, probability };
      const adjusted = probability - penalty * (load.get(login) ?? 0);
      if (!best || adjusted > best.adjusted) best = { login, probability, adjusted };
    }
    if (!best || !top) continue;
    load.set(best.login, (load.get(best.login) ?? 0) + 1);
    out.set(p.id, {
      login: best.login,
      probability: best.probability,
      balanced: best.login !== top.login,
    });
  }
  return out;
}
