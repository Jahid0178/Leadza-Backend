import { describe, expect, it } from "vitest";
import { JobQueue, type JobQueueStats } from "../src/jobs/queue";

/**
 * Bounded load test for the in-process job queue (IMPLEMENTATION_PLAN step 36,
 * §59). The scripts/queue-load-test.ts script replays a full day's volume; this
 * file pins the queue's correctness under many concurrent jobs inside the
 * normal test timeout: nothing dropped, nothing double-run, counters truthful.
 */

describe("JobQueue under load (step 36)", () => {
  it("drains hundreds of jobs exactly once with nothing lost", async () => {
    const jobs = 400;
    const seen = new Map<string, number>();

    const queue = new JobQueue<number>({
      name: "load-test",
      concurrency: 8,
      handler: async (n) => {
        seen.set(`job:${n}`, (seen.get(`job:${n}`) ?? 0) + 1);
        // Simulate light provider work; every tenth job goes through instantly.
        await new Promise((resolve) => setTimeout(resolve, n % 10 === 0 ? 0 : 2));
      },
      keyOf: (n) => `job:${n}`,
    });

    let inFlightPeak = 0;
    queue.start();

    const started = Date.now();
    for (let i = 0; i < jobs; i += 1) {
      queue.enqueue(i);
      if (i % 25 === 0) {
        const { active } = queue.stats();
        inFlightPeak = Math.max(inFlightPeak, active);
      }
    }

    await queue.drain();

    const duration = Date.now() - started;
    expect(seen.size).toBe(jobs);
    // Exactly once each — no duplicate runs, no drops.
    for (const count of seen.values()) expect(count).toBe(1);
    expect(queue.stats().completed).toBe(jobs);
    expect(queue.stats().failed).toBe(0);
    expect(queue.stats().pending).toBe(0);

    expect(duration).toBeLessThan(15_000); // the vitest ceiling for the file
    expect(inFlightPeak).toBeGreaterThan(0);
  });

  it("counts retries and permanent failures in stats()", async () => {
    // Fails on the first attempt only.
    let flakyFirstCall = 0;
    // Always fails.
    let alwaysCalls = 0;

    const queue = new JobQueue<string>({
      name: "retry-test",
      concurrency: 4,
      maxAttempts: 3,
      retryDelayMs: 1,
      handler: async (id) => {
        if (id === "flaky") {
          flakyFirstCall += 1;
          if (flakyFirstCall === 1) throw new Error("transient");
          return;
        }
        alwaysCalls += 1;
        throw new Error("permanent");
      },
      keyOf: (id) => id,
    });

    queue.start();
    queue.enqueue("flaky");
    queue.enqueue("broken");
    await queue.drain();

    const stats: JobQueueStats = queue.stats();
    // "flaky": one retried attempt, then success → 2 handler calls.
    expect(flakyFirstCall).toBe(2);
    // "broken": exactly maxAttempts calls, then a permanent failure. Its first
    // two attempts count as retries; the third ends the job as failed.
    expect(alwaysCalls).toBe(3);
    expect(stats.retries).toBe(3);
    expect(stats.failed).toBe(1);
    expect(stats.completed).toBe(1);
  });

  it("honours enqueueLatest: a busy key runs once more, not zero or twice", async () => {
    // Assigned inside the promise executor, so TS sees it as possibly null.
    let releaseSecondRun: (() => void) | null = null;
    let runs = 0;

    const gate = new Promise<void>((resolve) => {
      releaseSecondRun = resolve;
    });

    const queue = new JobQueue<string>({
      name: "rerun-test",
      concurrency: 1,
      handler: async () => {
        runs += 1;
        // Only the first run waits; the rerun must proceed freely.
        if (runs === 1) await gate;
      },
      keyOf: (id) => id,
    });

    queue.start();
    queue.enqueue("same-key");
    // Busy → remembered for one more run.
    expect(queue.enqueueLatest("same-key")).toBe(false);
    expect(queue.enqueueLatest("same-key")).toBe(false);
    // A brand new key still enqueues normally.
    expect(queue.enqueueLatest("other-key")).toBe(true);

    const release = releaseSecondRun as (() => void) | null;
    release?.();
    await queue.drain();

    const stats = queue.stats();
    // The coalesced duplicate ran as exactly one follow-up, plus "other-key".
    expect(stats.reruns).toBe(1);
    expect(runs).toBe(3);
    expect(stats.completed).toBe(3);
  });
});