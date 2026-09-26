/**
 * Backpressure for one TypeSafe scope (a repo). Pure scheduling, no I/O:
 *  - up to `maxInFlight` jobs at once; a job that reports more work fills the remaining slots;
 *  - a poke while every slot is busy only sets `dirty` (counted as dropped);
 *  - pokes inside the collect window share one start (counted as coalesced);
 *  - when a job ends, another starts at once while it reported more work; otherwise a dirty
 *    flag starts one more after the collect window.
 * The job itself never triggers a poke, so there is no feedback storm.
 */
export interface SchedulerStats {
  /** Jobs running right now. */
  inFlight: number;
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
    inFlight: 0,
    dirty: false,
    dropped: 0,
    coalesced: 0,
    runs: 0,
  };
  #timer: ReturnType<typeof setTimeout> | null = null;
  readonly #job: Job;
  readonly #collectMs: number;
  readonly #maxInFlight: number;
  readonly #onChange: (s: SchedulerStats) => void;

  constructor(
    job: Job,
    collectMs: number,
    maxInFlight = 1,
    onChange: (s: SchedulerStats) => void = () => {},
  ) {
    this.#job = job;
    this.#collectMs = collectMs;
    this.#maxInFlight = Math.max(1, maxInFlight);
    this.#onChange = onChange;
  }

  poke(): void {
    if (this.stats.inFlight >= this.#maxInFlight) {
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
      this.#start();
    }, ms);
  }

  /** Starts one run if a slot is free; runs that find more work fill the other slots. */
  #start(): void {
    if (this.stats.inFlight >= this.#maxInFlight) return;
    void this.#run();
  }

  #fill(): void {
    while (this.stats.inFlight < this.#maxInFlight) void this.#run();
  }

  async #run(): Promise<void> {
    this.stats.inFlight += 1;
    this.stats.dirty = false;
    this.stats.runs += 1;
    this.#onChange(this.stats);
    let result: JobResult = { more: false, cadenceMs: 0 };
    try {
      result = await this.#job();
    } catch {
      // The job records its own error; scheduling continues only if poked again.
    } finally {
      this.stats.inFlight -= 1;
      this.#onChange(this.stats);
    }
    if (result.more) {
      if (result.cadenceMs > 0) this.#schedule(result.cadenceMs);
      else this.#fill();
    } else if (this.stats.dirty && this.stats.inFlight === 0 && !this.#timer) {
      this.#schedule(this.#collectMs);
    }
  }

  stop(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }
}
