import { describe, expect, test } from "vite-plus/test";
import {
  assignReviewers,
  deriveReviewers,
  dirOf,
  isBot,
  pathOverlap,
  rankReviewers,
  type PullForStats,
  type ReviewEvent,
} from "../src/reviewers.ts";

const DAY = 86_400_000;
const now = 100 * DAY;

const pulls: PullForStats[] = [
  {
    id: "p1",
    title: "Fix api auth",
    author: "alice",
    state: "merged",
    createdAt: 10 * DAY,
    files: ["src/api/auth.ts", "src/api/routes.ts"],
    requestedReviewers: [],
  },
  {
    id: "p2",
    title: "Core cache",
    author: "alice",
    state: "merged",
    createdAt: 20 * DAY,
    files: ["src/core/cache.ts"],
    requestedReviewers: [],
  },
  {
    id: "p3",
    title: "Docs typo",
    author: "bob",
    state: "merged",
    createdAt: 30 * DAY,
    files: ["README.md"],
    requestedReviewers: [],
  },
  {
    id: "p4",
    title: "Open api change",
    author: "dave",
    state: "open",
    createdAt: 90 * DAY,
    files: ["src/api/x.ts"],
    requestedReviewers: ["carol"],
  },
];
const reviews: ReviewEvent[] = [
  { pullId: "p1", reviewer: "bob", state: "COMMENTED", submittedAt: 10 * DAY + 2 * 3_600_000 },
  { pullId: "p1", reviewer: "bob", state: "APPROVED", submittedAt: 11 * DAY },
  { pullId: "p2", reviewer: "bob", state: "APPROVED", submittedAt: 21 * DAY },
  {
    pullId: "p2",
    reviewer: "carol",
    state: "CHANGES_REQUESTED",
    submittedAt: 20 * DAY + 6 * 3_600_000,
  },
  { pullId: "p3", reviewer: "bob", state: "APPROVED", submittedAt: 31 * DAY }, // own pull: ignored
  { pullId: "p3", reviewer: "dependabot[bot]", state: "APPROVED", submittedAt: 31 * DAY },
  { pullId: "p4", reviewer: "bob", state: "COMMENTED", submittedAt: 91 * DAY },
];

describe("deriveReviewers", () => {
  const stats = deriveReviewers(pulls, reviews);
  test("counts reviews and approvals, skipping bots and self-reviews", () => {
    expect(stats.map((s) => s.login)).toEqual(["bob", "carol"]);
    const bob = stats[0]!;
    expect(bob.reviews).toBe(4);
    expect(bob.approvals).toBe(2);
    expect(bob.recentTitles).toEqual(["Core cache", "Fix api auth"]);
  });
  test("directories are counted once per pull; response time is the median first-review delay", () => {
    const bob = stats[0]!;
    expect(bob.dirs).toEqual([
      { dir: "src/api", count: 2 },
      { dir: "src/core", count: 1 },
    ]);
    // p1: 2h, p2: 24h, p4: 24h → median 24h
    expect(bob.medianResponseHours).toBe(24);
    expect(stats[1]!.medianResponseHours).toBe(6);
  });
  test("open load counts requested and active reviewers on open pulls", () => {
    expect(stats.find((s) => s.login === "bob")!.openLoad).toBe(1);
    expect(stats.find((s) => s.login === "carol")!.openLoad).toBe(1);
  });
});

describe("shortlisting", () => {
  test("dirOf and isBot", () => {
    expect(dirOf("src/api/routes.ts")).toBe("src/api");
    expect(dirOf("README.md")).toBe("README.md");
    expect(dirOf("a/b/c/d.ts")).toBe("a/b");
    expect(isBot("renovate[bot]")).toBe(true);
    expect(isBot("bob")).toBe(false);
  });
  test("pathOverlap rewards exact directories and half-credits the top level", () => {
    const dirs = [{ dir: "src/api", count: 3 }];
    expect(pathOverlap(["src/api/a.ts"], dirs)).toBe(1);
    expect(pathOverlap(["src/core/a.ts"], dirs)).toBe(0.5);
    expect(pathOverlap(["docs/a.md"], dirs)).toBe(0);
    expect(pathOverlap([], dirs)).toBe(0);
  });
  test("rankReviewers excludes the author and prefers overlap", () => {
    const stats = deriveReviewers(pulls, reviews);
    const ranked = rankReviewers(
      { author: "carol", files: ["src/api/new.ts"], requestedReviewers: [] },
      stats,
      now,
    );
    expect(ranked.map((r) => r.login)).toEqual(["bob"]);
    expect(ranked[0]!.pathOverlap).toBeCloseTo(2 / 3);
    const withCarol = rankReviewers(
      { author: "dave", files: ["src/core/new.ts"], requestedReviewers: ["carol"] },
      stats,
      now,
    );
    expect(withCarol.find((r) => r.login === "carol")?.requested).toBe(true);
  });
});

describe("assignReviewers", () => {
  test("spreads pulls across people when one expert would take them all", () => {
    const probs = { bob: 0.6, carol: 0.4 };
    const out = assignReviewers(
      [
        { id: "a", priority: 0.9, probabilities: probs },
        { id: "b", priority: 0.8, probabilities: probs },
        { id: "c", priority: 0.7, probabilities: probs },
      ],
      {},
    );
    expect(out.get("a")).toEqual({ login: "bob", probability: 0.6, balanced: false });
    expect(out.get("b")).toEqual({ login: "bob", probability: 0.6, balanced: false });
    expect(out.get("c")).toEqual({ login: "carol", probability: 0.4, balanced: true });
  });
  test("existing open load counts at a third and none is never assigned", () => {
    const pull = { id: "a", priority: 1, probabilities: { bob: 0.5, carol: 0.45, none: 0.05 } };
    expect(assignReviewers([pull], { bob: 2 }).get("a")?.login).toBe("carol");
    expect(assignReviewers([pull], { bob: 1 }).get("a")?.login).toBe("bob");
    expect(assignReviewers([{ id: "z", priority: 1, probabilities: { none: 1 } }]).size).toBe(0);
  });
});
