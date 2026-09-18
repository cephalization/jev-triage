import { describe, expect, test } from "vite-plus/test";

process.env.ZERO_UPSTREAM_DB ??= "postgres://unused";
process.env.AUTH_SECRET ??= "test";
const { cellReachable, loadSnapshotInCell } = await import("../src/review/cell.ts");

describe("reviewer cell client", () => {
  test("a dead cell reads as unreachable, a healthy one as reachable", async () => {
    expect(await cellReachable({ url: "http://127.0.0.1:1" })).toBe(false);
    const ok = (async () => Response.json({ ok: true })) as typeof fetch;
    expect(await cellReachable({ url: "http://cell/" }, ok)).toBe(true);
  });

  test("loading a snapshot posts the token and fails with the cell's reason", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const ready = (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(init?.body as string) });
      return Response.json({ status: "ready" });
    }) as typeof fetch;
    const snap = await loadSnapshotInCell(
      { url: "http://cell", token: "shh" },
      "o/r",
      "abc1234",
      { token: "gh", apiBase: "https://api.github.com" },
      ready,
    );
    expect(snap).toEqual({ owner: "o", repo: "r", sha: "abc1234" });
    expect(calls[0]!.url).toBe("http://cell/snapshots/o/r/abc1234");
    expect(calls[0]!.body).toMatchObject({ token: "gh", sha: "abc1234" });
    const failed = (async () =>
      Response.json({
        status: "failed",
        error: "GitHub answered 404 for the tarball",
      })) as typeof fetch;
    await expect(
      loadSnapshotInCell(
        { url: "http://cell", token: null },
        "o/r",
        "abc1234",
        { token: null, apiBase: "x" },
        failed,
      ),
    ).rejects.toThrow("GitHub answered 404");
  });
});

describe("generation guard rails", async () => {
  const { RateLimiter, overBudget } = await import("../src/review/limits.ts");
  test("rate limiter allows the window and then answers with a retry delay", () => {
    const rl = new RateLimiter(2, 1000);
    expect(rl.take("u", 0)).toEqual({ ok: true });
    expect(rl.take("u", 100)).toEqual({ ok: true });
    expect(rl.take("u", 200)).toEqual({ ok: false, retryAfterMs: 800 });
    expect(rl.take("v", 200)).toEqual({ ok: true });
    expect(rl.take("u", 1001)).toEqual({ ok: true });
  });
  test("budget: zero is unlimited, otherwise spent >= budget refuses", () => {
    expect(overBudget(1_000_000, 0)).toBe(false);
    expect(overBudget(999, 1000)).toBe(false);
    expect(overBudget(1000, 1000)).toBe(true);
  });
});
