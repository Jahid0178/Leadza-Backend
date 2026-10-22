import { JobQueue } from "../src/jobs/queue";
import { logger } from "../src/utils/logger";

/**
 * Load test for the AI reply queue (IMPLEMENTATION_PLAN step 36, §59).
 *
 * Replays a configurable day's message volume through the REAL queue module —
 * keyed enqueue, coalescing, concurrency cap, retries — with a synthetic
 * handler standing in for the model call, so no key or spend is involved.
 *
 *   tsx scripts/queue-load-test.ts [--jobs 5000] [--concurrency 1]
 *       [--work 80] [--retries 0.02]
 *
 *   --jobs         conversations to run (one AI reply job each).
 *                  Default 5000 — roughly a busy day of widget conversations
 *                  across the platform at MVP scale.
 *   --concurrency  mirrors ai-reply-queue.ts's setting (1 in production);
 *                  higher values probe whether the cap leaves headroom.
 *   --work         simulated model latency per job (ms). Default 80 — the
 *                  upper end of a small free-tier completion.
 *   --retries      fraction of jobs whose first attempt fails, so the real
 *                  backoff path carries load too.
 *
 * Pass criteria: every job completes (plus its scheduled retries), nothing is
 * dropped or double-run, and the run finishes inside a wall clock the business
 * could survive (reported — a customer polling a thread waits on this queue).
 * Exit code 0 only when nothing was lost.
 */

function readNumber(flag: string, fallback: number): number {
  const index = process.argv.indexOf(flag);
  if (index === -1) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${flag} must be a positive number`);
  }
  return value;
}

const jobs = Math.floor(readNumber("--jobs", 5_000));
const concurrency = Math.floor(readNumber("--concurrency", 1));
const workMs = readNumber("--work", 80);
const retryFraction = Math.max(0, Math.min(0.5, readNumber("--retries", 0.02)));

/** Roughly `workMs` of "model time", ±20% jitter so durations are not identical. */
const simulatedReply = () => workMs * (0.8 + Math.random() * 0.4);

/** Attempt counts per conversation id. A retried job shows 2 attempts. */
const seen = new Map<string, number>();
/** Ids whose final attempt succeeded. */
const completed = new Set<string>();

const queue = new JobQueue<string>({
  name: "queue-load-test",
  concurrency,
  maxAttempts: 3,
  retryDelayMs: 250,
  handler: async (id) => {
    const attempts = (seen.get(id) ?? 0) + 1;
    seen.set(id, attempts);
    // First attempt only: at most one transient failure per job.
    if (attempts === 1 && retryFraction > 0 && Math.random() < retryFraction) {
      throw new Error(`simulated transient failure for ${id}`);
    }
    await new Promise((resolve) => setTimeout(resolve, simulatedReply()));
    completed.add(id);
  },
  keyOf: (id) => `conversation:${id}`,
});

queue.start();

const enqueuedAt = Date.now();
/** Wall-clock sampling of the queue's depth while it drains. */
let peakPending = 0;
let peakActive = 0;
const sampler = setInterval(() => {
  const stats = queue.stats();
  peakPending = Math.max(peakPending, stats.pending);
  peakActive = Math.max(peakActive, stats.active);
}, 200);

for (let i = 0; i < jobs; i += 1) queue.enqueue(`conversation-${i}`);
logger.info({ jobs, concurrency, workMs, retryFraction }, "queue load test: enqueued");

await queue.drain();
clearInterval(sampler);
queue.stop();

const durationMs = Date.now() - enqueuedAt;
const stats = queue.stats();
const lost = jobs - completed.size;
// More than one attempt would be a rerun bug (2 = one accounted retry).
const duplicated = [...seen.values()].filter((count) => count > 2).length;

const report = {
  jobs,
  concurrency,
  simulatedWorkMs: workMs,
  durationMs,
  secondsPerJob: Number((durationMs / 1000 / jobs).toFixed(5)),
  throughputPerMinute: Number(((jobs / durationMs) * 60_000).toFixed(1)),
  peakPending,
  peakActive,
  queueStats: stats,
  lost,
  duplicated,
  ok: lost === 0 && duplicated === 0 && completed.size === jobs,
};

console.log(JSON.stringify(report, null, 2));

if (!report.ok) {
  console.error("queue load test FAILED — lost or duplicated jobs");
  process.exit(1);
}

logger.info(
  {
    durationMs: report.durationMs,
    perMinute: report.throughputPerMinute,
    failed: stats.failed,
    retries: stats.retries,
  },
  "queue load test complete",
);