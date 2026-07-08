import { describe, it, expect } from "vitest";
import { KeyedMutex, Semaphore } from "../async-lock.js";

describe("KeyedMutex", () => {
  it("serializes calls for the same key in FIFO order", async () => {
    const mutex = new KeyedMutex();
    const order: number[] = [];
    const calls = [1, 2, 3].map((n) =>
      mutex.withLock("k", async () => {
        await new Promise((resolve) => setTimeout(resolve, n === 1 ? 20 : 0));
        order.push(n);
      })
    );
    await Promise.all(calls);
    expect(order).toEqual([1, 2, 3]);
  });

  it("does not serialize calls for different keys", async () => {
    const mutex = new KeyedMutex();
    let concurrent = 0;
    let maxConcurrent = 0;
    const run = (key: string) =>
      mutex.withLock(key, async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((resolve) => setTimeout(resolve, 10));
        concurrent--;
      });
    await Promise.all([run("a"), run("b"), run("c")]);
    expect(maxConcurrent).toBeGreaterThan(1);
  });

  it("releases the lock even when fn throws", async () => {
    const mutex = new KeyedMutex();
    await expect(
      mutex.withLock("k", async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");

    // Lock must be released — a subsequent call should run immediately, not hang.
    let ran = false;
    await mutex.withLock("k", async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  it("isLocked reflects in-flight work and clears after settling", async () => {
    const mutex = new KeyedMutex();
    expect(mutex.isLocked("k")).toBe(false);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held = mutex.withLock("k", async () => {
      await gate;
    });
    expect(mutex.isLocked("k")).toBe(true);
    release();
    await held;
    expect(mutex.isLocked("k")).toBe(false);
  });
});

describe("Semaphore", () => {
  it("never allows more than `limit` concurrent holders", async () => {
    const sem = new Semaphore(3);
    let concurrent = 0;
    let maxConcurrent = 0;
    const task = () =>
      sem.withPermit(async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((resolve) => setTimeout(resolve, Math.random() * 10));
        concurrent--;
      });
    await Promise.all(Array.from({ length: 25 }, task));
    expect(maxConcurrent).toBeLessThanOrEqual(3);
    expect(sem.inFlightCount).toBe(0);
  });

  it("tryAcquire fails fast once the limit is reached", async () => {
    const sem = new Semaphore(1);
    const release1 = sem.tryAcquire();
    expect(release1).not.toBeNull();
    const release2 = sem.tryAcquire();
    expect(release2).toBeNull();
    release1!();
    const release3 = sem.tryAcquire();
    expect(release3).not.toBeNull();
    release3!();
  });

  it("acquire() queues and resolves FIFO as permits free up", async () => {
    const sem = new Semaphore(1);
    const order: number[] = [];
    const release0 = await sem.acquire();
    const p1 = sem.acquire().then((r) => {
      order.push(1);
      return r;
    });
    const p2 = sem.acquire().then((r) => {
      order.push(2);
      return r;
    });
    // Give the microtask queue a beat to prove neither has resolved yet.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual([]);
    release0();
    const release1 = await p1;
    expect(order).toEqual([1]);
    release1();
    await p2;
    expect(order).toEqual([1, 2]);
  });

  it("release() is idempotent", async () => {
    const sem = new Semaphore(1);
    const release = sem.tryAcquire()!;
    release();
    release();
    expect(sem.inFlightCount).toBe(0);
  });
});
