import { logger } from "../utils/logger";

/**
 * A minimal in-process background job queue (agent.md §24, §54).
 *
 * Long-running work — model calls above all — must not run inside an HTTP
 * request. This provides just enough queue for the MVP: FIFO order, a
 * concurrency cap, per-key deduplication, and bounded retries with backoff.
 * It is intentionally dependency-free and in-process; when the load outgrows
 * one Node process, this interface can be reimplemented on a real broker
 * (Redis/BullMQ) without touching the callers.
 *
 * Trade-off, stated plainly: jobs live in memory, so a crash loses the queue.
 * That is acceptable for AI replies, which are re-triggered by the next
 * inbound message; it would not be acceptable for billing (step 30).
 */

export type JobHandler<T> = (payload: T) => Promise<void>;

export interface JobQueueOptions<T> {
  /** Name used in logs. */
  name: string;
  handler: JobHandler<T>;
  /** Two jobs that share a key are never queued or run at the same time. */
  keyOf: (payload: T) => string;
  concurrency?: number;
  /** Total tries per job, including the first. */
  maxAttempts?: number;
  /** Base delay between retries; grows linearly with the attempt number. */
  retryDelayMs?: number;
}

interface QueueItem<T> {
  payload: T;
  key: string;
}

/** Cumulative counters (step 36) — load tests and observability. */
export interface JobQueueStats {
  /** Jobs waiting to be picked up. */
  pending: number;
  /** Jobs in flight right now. */
  active: number;
  /** Runs that finished successfully (a key processed twice via rerun counts twice). */
  completed: number;
  /** Failed attempts that will be retried. */
  retries: number;
  /** Jobs that exhausted every allowed attempt. */
  failed: number;
  /** Follow-up runs `enqueueLatest` scheduled after a key was busy. */
  reruns: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class JobQueue<T> {
  private readonly items: Array<QueueItem<T>> = [];
  private readonly activeKeys = new Set<string>();
  /** A follow-up run requested for a key that is already queued or running. */
  private readonly rerun = new Map<string, T>();
  private readonly waiters: Array<() => void> = [];
  private readonly options: Required<Pick<JobQueueOptions<T>, "concurrency" | "maxAttempts" | "retryDelayMs">> &
    JobQueueOptions<T>;
  private active = 0;
  private running = false;
  private readonly counts = { completed: 0, retries: 0, failed: 0, reruns: 0 };

  constructor(options: JobQueueOptions<T>) {
    this.options = {
      concurrency: 1,
      maxAttempts: 3,
      retryDelayMs: 2000,
      ...options,
    };
  }

  /** True once `start()` has been called and `stop()` has not. */
  get isRunning(): boolean {
    return this.running;
  }

  /** Jobs waiting to be picked up (not counting those in flight). */
  get pending(): number {
    return this.items.length;
  }

  /** Cumulative counters — step 36 observability and load tests. */
  stats(): JobQueueStats {
    return {
      pending: this.items.length,
      active: this.active,
      completed: this.counts.completed,
      retries: this.counts.retries,
      failed: this.counts.failed,
      reruns: this.counts.reruns,
    };
  }

  /**
   * Add a job. Returns false when an identical key is already queued or
   * running, so a burst of messages for one conversation runs the agent once.
   */
  enqueue(payload: T): boolean {
    const key = this.options.keyOf(payload);
    if (this.activeKeys.has(key)) return false;
    this.activeKeys.add(key);
    this.items.push({ payload, key });
    this.pump();
    return true;
  }

  /**
   * Add a job, or — when its key is already queued or running — remember it and
   * run it once more after the current run finishes. Unlike `enqueue`, a
   * duplicate never vanishes: a customer message that lands while the agent is
   * answering still gets a reply instead of being swallowed (§24).
   */
  enqueueLatest(payload: T): boolean {
    const key = this.options.keyOf(payload);
    if (this.activeKeys.has(key)) {
      this.rerun.set(key, payload);
      return false;
    }
    return this.enqueue(payload);
  }

  /** Begin processing. Enqueued jobs wait until this is called. */
  start(): void {
    if (this.running) return;
    this.running = true;
    logger.info({ job: this.options.name }, "job queue started");
    this.pump();
  }

  /** Stop processing and drop anything still queued (graceful shutdown). */
  stop(): void {
    this.running = false;
    this.items.length = 0;
    this.rerun.clear();
    this.settleWaiters();
    logger.info({ job: this.options.name }, "job queue stopped");
  }

  /** Resolve once nothing is queued and nothing is in flight. */
  drain(): Promise<void> {
    if (this.isIdle()) return Promise.resolve();
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }

  private isIdle(): boolean {
    return this.items.length === 0 && this.active === 0;
  }

  private settleWaiters(): void {
    if (!this.isIdle()) return;
    const waiters = this.waiters.splice(0, this.waiters.length);
    for (const resolve of waiters) resolve();
  }

  private pump(): void {
    while (
      this.running &&
      this.active < this.options.concurrency &&
      this.items.length > 0
    ) {
      const item = this.items.shift();
      if (!item) break;
      this.active += 1;
      void this.run(item).finally(() => {
        this.active -= 1;
        this.activeKeys.delete(item.key);
        this.scheduleRerun(item.key);
        this.pump();
        this.settleWaiters();
      });
    }
  }

  /**
   * If a follow-up run was requested while `key` was busy, queue it now. The
   * key is re-marked active before the item is pushed so a concurrent
   * `enqueueLatest` still coalesces into one more run rather than two.
   */
  private scheduleRerun(key: string): void {
    const payload = this.rerun.get(key);
    if (payload === undefined) return;
    this.rerun.delete(key);
    this.counts.reruns += 1;
    this.activeKeys.add(key);
    this.items.push({ payload, key });
  }

  private async run(item: QueueItem<T>): Promise<void> {
    const { handler, name, maxAttempts, retryDelayMs } = this.options;
    for (let attempt = 1; ; attempt += 1) {
      try {
        await handler(item.payload);
        this.counts.completed += 1;
        return;
      } catch (err) {
        if (attempt >= maxAttempts) {
          logger.error(
            { err, job: name, key: item.key, attempts: attempt },
            "job failed permanently",
          );
          this.counts.failed += 1;
          return;
        }
        logger.warn(
          { err, job: name, key: item.key, attempt },
          "job failed — retrying",
        );
        this.counts.retries += 1;
        if (retryDelayMs > 0) await sleep(retryDelayMs * attempt);
      }
    }
  }
}
