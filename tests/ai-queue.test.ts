import { afterAll, describe, expect, it } from "vitest";
import {
  aiReplyQueueDepth,
  drainAiReplyQueue,
  enqueueAiReply,
  startAiReplyQueue,
  stopAiReplyQueue,
} from "../src/jobs/ai-reply-queue";
import { JobQueue } from "../src/jobs/queue";

/**
 * Background queue tests (agent.md §24, IMPLEMENTATION_PLAN step 20).
 *
 * The queue is what keeps a slow model out of the HTTP request path, so its
 * contracts — dedupe, retry, bounded failure, start/stop — are worth pinning.
 */

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("JobQueue", () => {
  it("holds jobs until started, then drains them", async () => {
    const seen: number[] = [];
    const queue = new JobQueue<number>({
      name: "test-hold",
      keyOf: (n) => String(n),
      handler: async (n) => {
        seen.push(n);
      },
    });

    queue.enqueue(1);
    queue.enqueue(2);
    expect(queue.pending).toBe(2);
    expect(seen).toEqual([]);

    queue.start();
    await queue.drain();
    expect(seen.sort()).toEqual([1, 2]);
    expect(queue.pending).toBe(0);
    queue.stop();
  });

  it("deduplicates jobs that share a key while one is pending", async () => {
    let runs = 0;
    const queue = new JobQueue<string>({
      name: "test-dedupe",
      keyOf: (key) => key,
      handler: async () => {
        runs += 1;
        await wait(5);
      },
    });

    queue.start();
    expect(queue.enqueue("conversation-1")).toBe(true);
    expect(queue.enqueue("conversation-1")).toBe(false);
    await queue.drain();
    expect(runs).toBe(1);

    // Once settled, the key is free again.
    expect(queue.enqueue("conversation-1")).toBe(true);
    await queue.drain();
    expect(runs).toBe(2);
    queue.stop();
  });

  it("retries a failing job and succeeds", async () => {
    let attempts = 0;
    const queue = new JobQueue<number>({
      name: "test-retry",
      keyOf: (n) => String(n),
      maxAttempts: 3,
      retryDelayMs: 1,
      handler: async () => {
        attempts += 1;
        if (attempts < 3) throw new Error("transient");
      },
    });

    queue.start();
    queue.enqueue(1);
    await queue.drain();
    expect(attempts).toBe(3);
    queue.stop();
  });

  it("gives up after the attempt limit without throwing", async () => {
    let attempts = 0;
    const queue = new JobQueue<number>({
      name: "test-giveup",
      keyOf: (n) => String(n),
      maxAttempts: 2,
      retryDelayMs: 1,
      handler: async () => {
        attempts += 1;
        throw new Error("always fails");
      },
    });

    queue.start();
    queue.enqueue(1);
    await queue.drain();
    expect(attempts).toBe(2);
    queue.stop();
  });

  it("drops pending jobs on stop", async () => {
    const seen: number[] = [];
    const queue = new JobQueue<number>({
      name: "test-stop",
      keyOf: (n) => String(n),
      handler: async (n) => {
        seen.push(n);
      },
    });

    queue.enqueue(1);
    queue.stop();
    expect(queue.pending).toBe(0);
    await queue.drain();
    expect(seen).toEqual([]);
  });
});

describe("AI reply queue wiring", () => {
  afterAll(() => {
    stopAiReplyQueue();
  });

  it("processes an enqueued conversation without throwing", async () => {
    startAiReplyQueue();
    // An unknown conversation resolves to a no-op "not_found" run, which
    // exercises the enqueue → agent wiring end to end.
    enqueueAiReply("wiring-check-missing-conversation");
    expect(aiReplyQueueDepth()).toBeGreaterThanOrEqual(0);
    await expect(drainAiReplyQueue()).resolves.toBeUndefined();
    expect(aiReplyQueueDepth()).toBe(0);
  });
});
