import { describe, expect, test, vi } from "vite-plus/test";
import { Scheduler } from "../src/worker/scheduler.ts";

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

/** A job whose completions the test releases one at a time, in order. */
function controlledJob() {
  const pending: ((r: { more: boolean; cadenceMs: number }) => void)[] = [];
  const job = vi.fn(
    () =>
      new Promise<{ more: boolean; cadenceMs: number }>((resolve) => {
        pending.push(resolve);
      }),
  );
  const release = (more: boolean) => pending.shift()!({ more, cadenceMs: 0 });
  return { job, release };
}

describe("Scheduler", () => {
  test("pokes inside the collect window share one run; pokes at capacity set dirty and count as dropped", async () => {
    vi.useFakeTimers();
    const { job, release } = controlledJob();
    const s = new Scheduler(job, 100, 1);
    s.poke();
    s.poke();
    s.poke();
    expect(s.stats.coalesced).toBe(2);
    expect(job).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(job).toHaveBeenCalledTimes(1);
    expect(s.stats.inFlight).toBe(1);
    s.poke();
    s.poke();
    expect(s.stats.dropped).toBe(2);
    expect(s.stats.dirty).toBe(true);
    expect(job).toHaveBeenCalledTimes(1);
    release(false);
    await flush();
    expect(s.stats.inFlight).toBe(0);
    // dirty → exactly one follow-up run after the collect window
    await vi.advanceTimersByTimeAsync(100);
    expect(job).toHaveBeenCalledTimes(2);
    release(false);
    await flush();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(job).toHaveBeenCalledTimes(2);
    s.stop();
    vi.useRealTimers();
  });

  test("a job reporting more work fills every slot at once, and the slots drain when work runs out", async () => {
    vi.useFakeTimers();
    const { job, release } = controlledJob();
    const s = new Scheduler(job, 10, 3);
    s.poke();
    await vi.advanceTimersByTimeAsync(10);
    expect(job).toHaveBeenCalledTimes(1);
    expect(s.stats.inFlight).toBe(1);
    release(true);
    await flush();
    // One finished with more work: the other two slots start alongside a replacement.
    expect(s.stats.inFlight).toBe(3);
    expect(job).toHaveBeenCalledTimes(4);
    release(true);
    await flush();
    expect(s.stats.inFlight).toBe(3);
    expect(job).toHaveBeenCalledTimes(5);
    release(false);
    release(false);
    release(false);
    await flush();
    expect(s.stats.inFlight).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(job).toHaveBeenCalledTimes(5);
    expect(s.stats.runs).toBe(5);
    s.stop();
    vi.useRealTimers();
  });

  test("a cadence delays the follow-up instead of filling slots", async () => {
    vi.useFakeTimers();
    let remaining = 3;
    const job = vi.fn(async () => {
      remaining -= 1;
      return { more: remaining > 0, cadenceMs: 500 };
    });
    const s = new Scheduler(job, 50, 4);
    s.poke();
    await vi.advanceTimersByTimeAsync(50);
    expect(job).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(499);
    expect(job).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(job).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(500);
    expect(job).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(job).toHaveBeenCalledTimes(3);
    s.stop();
    vi.useRealTimers();
  });

  test("a failing job does not retrigger itself", async () => {
    vi.useFakeTimers();
    const job = vi.fn(async () => {
      throw new Error("boom");
    });
    const s = new Scheduler(job, 10, 4);
    s.poke();
    await vi.advanceTimersByTimeAsync(10);
    await flush();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(job).toHaveBeenCalledTimes(1);
    expect(s.stats.inFlight).toBe(0);
    s.stop();
    vi.useRealTimers();
  });
});
