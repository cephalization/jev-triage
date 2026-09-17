import { describe, expect, test, vi } from "vite-plus/test";
import { Scheduler } from "../src/worker/scheduler.ts";

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("Scheduler", () => {
  test("pokes inside the collect window share one run; pokes in flight set dirty and count as dropped", async () => {
    vi.useFakeTimers();
    let release: () => void = () => {};
    const job = vi.fn(
      () =>
        new Promise<{ more: boolean; cadenceMs: number }>((resolve) => {
          release = () => resolve({ more: false, cadenceMs: 0 });
        }),
    );
    const s = new Scheduler(job, 100);
    s.poke();
    s.poke();
    s.poke();
    expect(s.stats.coalesced).toBe(2);
    expect(job).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(job).toHaveBeenCalledTimes(1);
    expect(s.stats.inFlight).toBe(true);
    s.poke();
    s.poke();
    expect(s.stats.dropped).toBe(2);
    expect(s.stats.dirty).toBe(true);
    expect(job).toHaveBeenCalledTimes(1);
    release();
    await flush();
    expect(s.stats.inFlight).toBe(false);
    // dirty → exactly one follow-up run after the collect window
    await vi.advanceTimersByTimeAsync(100);
    expect(job).toHaveBeenCalledTimes(2);
    release();
    await flush();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(job).toHaveBeenCalledTimes(2);
    s.stop();
    vi.useRealTimers();
  });

  test("a job reporting more work re-runs after its cadence, then stops when done", async () => {
    vi.useFakeTimers();
    let remaining = 3;
    const job = vi.fn(async () => {
      remaining -= 1;
      return { more: remaining > 0, cadenceMs: 500 };
    });
    const s = new Scheduler(job, 50);
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
    expect(s.stats.runs).toBe(3);
    s.stop();
    vi.useRealTimers();
  });

  test("a failing job does not retrigger itself", async () => {
    vi.useFakeTimers();
    const job = vi.fn(async () => {
      throw new Error("boom");
    });
    const s = new Scheduler(job, 10);
    s.poke();
    await vi.advanceTimersByTimeAsync(10);
    await flush();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(job).toHaveBeenCalledTimes(1);
    expect(s.stats.inFlight).toBe(false);
    s.stop();
    vi.useRealTimers();
  });
});
