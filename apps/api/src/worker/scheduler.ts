/**
 * Backpressure for one TypeSafe scope (a repo). Pure scheduling, no I/O:
 *  - at most one job in flight;
 *  - a poke while in flight only sets `dirty` (counted as dropped);
 *  - pokes inside the collect window share one job (counted as coalesced);
 *  - after a job, re-run only if dirty or the job reports more work, after `cadenceMs`.
 * The job itself never triggers a poke, so there is no feedback storm.
 */
export interface SchedulerStats {
  inFlight: boolean;
  dirty: boolean;
  dropped: number;
  coalesced: number;
  runs: number;
}

export interface JobResult {
  /** True when a follow-up run is worthwhile (e.g. more issues remain). */
  more: boolean;
  /** Delay before the follow-up, in ms. */
  cadenceMs: number;
}

export type Job = () => Promise<JobResult>;

export class Scheduler {
  readonly stats: SchedulerStats = {
    inFlight: false,
    dirty: false,
    dropped: 0,
    coalesced: 0,
    runs: 0,
  };
  #timer: ReturnType<typeof setTimeout> | null = null;
  readonly #job: Job;
  readonly #collectMs: number;
  readonly #onChange: (s: SchedulerStats) => void;

  constructor(job: Job, collectMs: number, onChange: (s: SchedulerStats) => void = () => {}) {
    this.#job = job;
    this.#collectMs = collectMs;
    this.#onChange = onChange;
  }

  poke(): void {
    if (this.stats.inFlight) {
      this.stats.dirty = true;
      this.stats.dropped += 1;
      this.#onChange(this.stats);
      return;
    }
    if (this.#timer) {
      this.stats.coalesced += 1;
      this.#onChange(this.stats);
      return;
    }
    this.#schedule(this.#collectMs);
  }

  #schedule(ms: number): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.#run();
    }, ms);
  }

  async #run(): Promise<void> {
    this.stats.inFlight = true;
    this.stats.dirty = false;
    this.stats.runs += 1;
    this.#onChange(this.stats);
    let result: JobResult = { more: false, cadenceMs: 0 };
    try {
      result = await this.#job();
    } catch {
      // The job records its own error; scheduling continues only if poked again.
    } finally {
      this.stats.inFlight = false;
      this.#onChange(this.stats);
    }
    if (this.stats.dirty || result.more) {
      this.#schedule(Math.max(this.stats.dirty ? this.#collectMs : 0, result.cadenceMs));
    }
  }

  stop(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }
}
