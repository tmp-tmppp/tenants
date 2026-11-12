import { describe, expect, it } from "vitest";
import { DEFAULT_BATCH_SIZE, DEFAULT_LEASE_MS, IdentitySyncWorker } from "../../src/adapters/identity-sync/worker.js";
import type { MemoryStore } from "../../src/adapters/memory/memory-store.js";
import type { IdentitySyncItem } from "../../src/usecases/ports.js";
import { caller, createCore } from "../support/harness.js";

async function coreWithMember() {
  const core = createCore();
  const { tenant, adminInvite } = await core.useCases.createTenant.execute({ name: "Acme", slug: "acme", caller: caller("platform-1") });
  await core.useCases.acceptInvite.execute({ code: adminInvite.code, caller: caller("admin-1") });
  return { ...core, tenant };
}

const rowOf = (store: MemoryStore, key: string) => store.snapshot().identitySync.find((row) => row.key === key);

describe("the identity-sync queue of the memory store", () => {
  const T0 = new Date("2026-11-01T10:00:00.000Z");
  const later = (ms: number) => new Date(T0.getTime() + ms);

  it("upserts: a repeated enqueue bumps the version and makes the item due at once with a clean slate", async () => {
    const { store } = createCore();
    await store.transaction((r) => r.identitySync.enqueue("member", "u-1", T0));
    const [claimed] = await store.claimIdentitySync(5, later(30_000), T0);
    await store.failIdentitySync("member/u-1", claimed?.version ?? 0, "boom", later(60_000));
    expect(rowOf(store, "member/u-1")).toMatchObject({ version: 1, attempts: 1, lastError: "boom", dueAt: later(60_000), leaseUntil: null });

    await store.transaction((r) => r.identitySync.enqueue("member", "u-1", later(1000)));

    expect(store.snapshot().identitySync).toEqual([
      expect.objectContaining({ key: "member/u-1", version: 2, attempts: 0, lastError: null, dueAt: later(1000), createdAt: T0, updatedAt: later(1000) }),
    ]);
  });

  it("claims only items that are due and not leased, oldest first, up to the limit, and leases them without moving the due time", async () => {
    const { store } = createCore();
    await store.transaction(async (r) => {
      await r.identitySync.enqueue("member", "late", later(5000));
      await r.identitySync.enqueue("member", "b", later(1000));
      await r.identitySync.enqueue("tenant", "a", later(1000));
      await r.identitySync.enqueue("member", "oldest", T0);
    });

    const first = await store.claimIdentitySync(2, later(31_000), later(1000));

    expect(first.map((item) => item.key)).toEqual(["member/oldest", "member/b"]);
    expect(first[0]).toEqual({ key: "member/oldest", kind: "member", target: "oldest", version: expect.any(Number), attempts: 0 });
    expect(rowOf(store, "member/oldest")).toMatchObject({ dueAt: T0, leaseUntil: later(31_000) });
    // The leased items are not claimable while the lease lasts; the next claim gets the one that was left.
    expect((await store.claimIdentitySync(10, later(31_000), later(1000))).map((item) => item.key)).toEqual(["tenant/a"]);
    expect(await store.claimIdentitySync(10, later(31_000), later(1000))).toEqual([]);
    // The item that was not due yet, and the leased ones once their lease is over.
    expect((await store.claimIdentitySync(10, later(99_000), later(5000))).map((item) => item.key)).toEqual(["member/late"]);
    // The due time stayed where it was, so they come in the order of their due times, then of their keys.
    expect((await store.claimIdentitySync(10, later(99_000), later(31_000))).map((item) => item.key)).toEqual(["member/oldest", "member/b", "tenant/a"]);
  });

  it("keeps the lease when a change is queued again: a second claimer gets nothing until the lease has ended", async () => {
    const { store } = createCore();
    await store.transaction((r) => r.identitySync.enqueue("member", "u-1", T0));
    const [first] = await store.claimIdentitySync(1, later(DEFAULT_LEASE_MS), T0);

    // A change arrives while the first claimer works on the item: a new version, due at once, but still leased.
    await store.transaction((r) => r.identitySync.enqueue("member", "u-1", later(1000)));

    expect(rowOf(store, "member/u-1")).toMatchObject({ dueAt: later(1000), leaseUntil: later(DEFAULT_LEASE_MS) });
    expect(rowOf(store, "member/u-1")?.version).toBeGreaterThan(first?.version ?? 0);
    expect(await store.claimIdentitySync(5, later(2 * DEFAULT_LEASE_MS), later(1000))).toEqual([]);
    expect(await store.claimIdentitySync(5, later(2 * DEFAULT_LEASE_MS), later(DEFAULT_LEASE_MS - 1))).toEqual([]);
    // A first claimer that never reports back (a crashed instance) loses the item when the lease has ended.
    const [takenOver] = await store.claimIdentitySync(5, later(2 * DEFAULT_LEASE_MS), later(DEFAULT_LEASE_MS));
    expect(takenOver).toMatchObject({ key: "member/u-1", version: rowOf(store, "member/u-1")?.version });
  });

  it("makes the newer version claimable at once when the claimer completes the old version", async () => {
    const { store } = createCore();
    await store.transaction((r) => r.identitySync.enqueue("member", "u-1", T0));
    const [first] = await store.claimIdentitySync(1, later(DEFAULT_LEASE_MS), T0);
    await store.transaction((r) => r.identitySync.enqueue("member", "u-1", later(1000)));
    expect(await store.claimIdentitySync(5, later(2 * DEFAULT_LEASE_MS), later(2000))).toEqual([]);

    await store.completeIdentitySync("member/u-1", first?.version ?? 0);

    expect(rowOf(store, "member/u-1")).toMatchObject({ leaseUntil: null, attempts: 0, lastError: null, dueAt: later(1000) });
    const [next] = await store.claimIdentitySync(5, later(2 * DEFAULT_LEASE_MS), later(2001));
    expect(next).toMatchObject({ key: "member/u-1", version: rowOf(store, "member/u-1")?.version });
    expect(next?.version).toBeGreaterThan(first?.version ?? 0);
  });

  it("clears the lease when the claimed version fails, and only the lease when a newer version is queued", async () => {
    const { store } = createCore();
    await store.transaction((r) => r.identitySync.enqueue("member", "u-1", T0));
    const [claimed] = await store.claimIdentitySync(1, later(DEFAULT_LEASE_MS), T0);

    await store.failIdentitySync("member/u-1", claimed?.version ?? 0, "boom", later(5000));

    expect(rowOf(store, "member/u-1")).toMatchObject({ leaseUntil: null, attempts: 1, lastError: "boom", dueAt: later(5000) });
    expect(await store.claimIdentitySync(5, later(DEFAULT_LEASE_MS), later(4999))).toEqual([]);
    const [retried] = await store.claimIdentitySync(5, later(DEFAULT_LEASE_MS + 5000), later(5000));
    expect(retried).toMatchObject({ key: "member/u-1", attempts: 1 });

    // A change arrives while the retry is processed; the retry then fails: the newer row keeps its data, loses the lease.
    await store.transaction((r) => r.identitySync.enqueue("member", "u-1", later(6000)));
    await store.failIdentitySync("member/u-1", retried?.version ?? 0, "late failure", later(99_000));

    expect(rowOf(store, "member/u-1")).toMatchObject({ leaseUntil: null, attempts: 0, lastError: null, dueAt: later(6000) });
    expect((await store.claimIdentitySync(5, later(DEFAULT_LEASE_MS + 6000), later(6000))).map((item) => item.key)).toEqual(["member/u-1"]);
  });

  it("completes and fails only the version that was claimed", async () => {
    const { store } = createCore();
    await store.transaction((r) => r.identitySync.enqueue("member", "u-1", T0));
    const [claimed] = await store.claimIdentitySync(1, later(30_000), T0);
    // A change arrives while the item is being processed.
    await store.transaction((r) => r.identitySync.enqueue("member", "u-1", later(10)));

    await store.completeIdentitySync("member/u-1", claimed?.version ?? 0);
    expect(rowOf(store, "member/u-1")).toMatchObject({ version: 2, dueAt: later(10) });
    await store.failIdentitySync("member/u-1", claimed?.version ?? 0, "stale", later(99_000));
    expect(rowOf(store, "member/u-1")).toMatchObject({ version: 2, attempts: 0, lastError: null });

    await store.completeIdentitySync("member/u-1", 2);
    expect(store.snapshot().identitySync).toEqual([]);
    await expect(store.isIdentitySyncPending("member/u-1")).resolves.toBe(false);
  });

  it("keeps a newer row when an old claim is completed or failed late: a key that was deleted and queued again never gets an old version back", async () => {
    const { store } = createCore();
    await store.transaction((r) => r.identitySync.enqueue("member", "u-1", T0));
    // Worker A claims the item, then its lease runs out ...
    const [claimedByA] = await store.claimIdentitySync(1, later(30_000), T0);
    // ... worker B takes it over and finishes it, the row is deleted ...
    const [claimedByB] = await store.claimIdentitySync(1, later(90_000), later(31_000));
    await store.completeIdentitySync("member/u-1", claimedByB?.version ?? 0);
    expect(store.snapshot().identitySync).toEqual([]);
    // ... and a new change queues the key again, which used to start over at version 1.
    await store.transaction((r) => r.identitySync.enqueue("member", "u-1", later(32_000)));

    // Worker A is back and reports its old claim.
    await store.completeIdentitySync("member/u-1", claimedByA?.version ?? 0);
    await store.failIdentitySync("member/u-1", claimedByA?.version ?? 0, "late failure", later(99_000));

    const row = rowOf(store, "member/u-1");
    expect(row).toMatchObject({ attempts: 0, lastError: null, dueAt: later(32_000) });
    expect(row?.version).toBeGreaterThan(claimedByA?.version ?? 0);
    expect(row?.version).toBeGreaterThan(claimedByB?.version ?? 0);
    await expect(store.isIdentitySyncPending("member/u-1")).resolves.toBe(true);
  });

  it("numbers the versions with one counter for all keys, and a rolled-back enqueue still uses up a number", async () => {
    const { store } = createCore();
    const versions: number[] = [];
    const versionOf = (key: string) => rowOf(store, key)?.version ?? 0;
    await store.transaction((r) => r.identitySync.enqueue("member", "a", T0));
    versions.push(versionOf("member/a"));
    await store.transaction((r) => r.identitySync.enqueue("tenant", "t", T0));
    versions.push(versionOf("tenant/t"));
    await expect(
      store.transaction(async (r) => {
        await r.identitySync.enqueue("member", "b", T0);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await store.transaction((r) => r.identitySync.enqueue("member", "a", later(1)));
    versions.push(versionOf("member/a"));
    await store.transaction((r) => r.identitySync.enqueue("member", "b", later(2)));
    versions.push(versionOf("member/b"));

    expect(new Set(versions).size).toBe(versions.length);
    expect(versions).toEqual([...versions].sort((x, y) => x - y));
    // The rolled-back enqueue of "b" took a number between the second and third.
    expect(versions[2]).toBeGreaterThan((versions[1] ?? 0) + 1);
  });

  it("does not keep an item of a transaction that was rolled back", async () => {
    const { store } = createCore();
    await expect(
      store.transaction(async (r) => {
        await r.identitySync.enqueue("tenant", "t-1", T0);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await expect(store.isIdentitySyncPending("tenant/t-1")).resolves.toBe(false);
  });
});

describe("IdentitySyncWorker", () => {
  it("claims the due items, reconciles them and removes them from the queue", async () => {
    const { identitySync, identity, store, tenant } = await coreWithMember();

    const result = await identitySync.runOnce();

    expect(result).toEqual({ claimed: 2, done: 2, failed: 0 });
    expect(store.snapshot().identitySync).toEqual([]);
    expect(identity.organizations.get(tenant.id)).toBe("Acme");
    expect(identity.members.has(`${tenant.id}:admin-1`)).toBe(true);
    expect(identity.roleOf(tenant.id, "admin-1")).toBe("tenant-admin");
  });

  it("claims only items that are due", async () => {
    const { identitySync, identity, store, clock } = await coreWithMember();
    identity.available = false;
    await identitySync.runOnce(); // both fail and wait for their retry
    identity.available = true;

    expect(await identitySync.runOnce()).toEqual({ claimed: 0, done: 0, failed: 0 });

    clock.advanceMs(2000);
    expect(await identitySync.runOnce()).toEqual({ claimed: 2, done: 2, failed: 0 });
    expect(store.snapshot().identitySync).toEqual([]);
  });

  it("claims 5 items per poll by default, so that a batch fits well inside the lease", async () => {
    const { store, reconcile, clock, logger, identity } = createCore();
    for (let n = 1; n <= 12; n += 1) await store.transaction((r) => r.identitySync.enqueue("member", `u-${String(n).padStart(2, "0")}`, clock.now()));
    const worker = new IdentitySyncWorker({ store, reconcile, clock, logger, pollMs: 5 });
    expect(DEFAULT_BATCH_SIZE).toBe(5);
    identity.available = true;

    expect(await worker.runOnce()).toMatchObject({ claimed: 5 });
    expect(await worker.runOnce()).toMatchObject({ claimed: 5 });
    expect(await worker.runOnce()).toMatchObject({ claimed: 2 });
  });

  it("claims at most a batch and leases the items it took", async () => {
    const { identity, store, clock, reconcile, logger } = await coreWithMember();
    const worker = new IdentitySyncWorker({ store, reconcile, clock, logger, pollMs: 5, batchSize: 1, leaseMs: 10_000 });

    expect(await worker.runOnce()).toMatchObject({ claimed: 1, done: 1 });
    expect(await worker.runOnce()).toMatchObject({ claimed: 1, done: 1 });
    expect(await worker.runOnce()).toMatchObject({ claimed: 0 });
    expect(identity.calls.length).toBeGreaterThan(0);

    // An item that is claimed and neither completed nor failed (a crashed instance) returns after the lease.
    await store.transaction((r) => r.identitySync.enqueue("member", "ghost", clock.now()));
    await store.claimIdentitySync(5, new Date(clock.now().getTime() + 10_000), clock.now());
    expect(await worker.runOnce()).toMatchObject({ claimed: 0 });
    clock.advanceMs(10_000);
    expect(await worker.runOnce()).toMatchObject({ claimed: 1, done: 1 });
    expect(store.snapshot().identitySync).toEqual([]);
  });

  it("leases the items it claims for 120 seconds by default", async () => {
    const { store, reconcile, clock, logger } = await coreWithMember();
    const leases: Array<Date | null> = [];
    const spy = {
      execute: async (item: IdentitySyncItem) => {
        leases.push(rowOf(store, item.key)?.leaseUntil ?? null);
        await reconcile.execute(item);
      },
    };
    const worker = new IdentitySyncWorker({ store, reconcile: spy, clock, logger, pollMs: 5 });
    const started = clock.now().getTime();

    expect(await worker.runOnce()).toMatchObject({ claimed: 2, done: 2 });

    expect(DEFAULT_LEASE_MS).toBe(120_000);
    expect(leases).toEqual([new Date(started + 120_000), new Date(started + 120_000)]);
  });

  it("does not start the rest of a batch once the lease has passed, and leaves those items to the next claim", async () => {
    const { store, reconcile, clock, logger } = await coreWithMember();
    const seen: string[] = [];
    // The first item stalls until the lease of the batch is over.
    const stalled = {
      execute: async (item: IdentitySyncItem) => {
        seen.push(item.key);
        clock.advanceMs(10_000);
        await reconcile.execute(item);
      },
    };
    const worker = new IdentitySyncWorker({ store, reconcile: stalled, clock, logger, pollMs: 5, leaseMs: 10_000 });

    expect(await worker.runOnce()).toEqual({ claimed: 2, done: 1, failed: 0 });

    expect(seen).toHaveLength(1);
    expect(logger.lines.filter((line) => line.level === "warn")).toEqual([
      expect.objectContaining({ fields: { skipped: 1 }, message: expect.stringContaining("lease of the batch ran out") }),
    ]);
    // The item that was skipped is claimable at once: its lease has ended.
    expect(store.snapshot().identitySync).toHaveLength(1);
    expect(await new IdentitySyncWorker({ store, reconcile, clock, logger, pollMs: 5 }).runOnce()).toEqual({ claimed: 1, done: 1, failed: 0 });
    expect(store.snapshot().identitySync).toEqual([]);
  });

  it("keeps a row that was queued again while it was processed, and processes it in the next poll", async () => {
    const { identitySync, identity, store, clock } = await coreWithMember();
    await identitySync.runOnce();
    await store.transaction((r) => r.identitySync.enqueue("member", "admin-1", clock.now()));
    const queuedAs = rowOf(store, "member/admin-1")?.version ?? 0;

    // While the provider call is running, another change is queued for the same user.
    const setRole = identity.setRole.bind(identity);
    identity.setRole = async (tenantId, userId, role) => {
      await setRole(tenantId, userId, role);
      await store.transaction((r) => r.identitySync.enqueue("member", "admin-1", clock.now()));
      // The new version is already due, but the item is still leased: a second instance cannot take it now.
      expect(await store.claimIdentitySync(5, new Date(clock.now().getTime() + 1000), clock.now())).toEqual([]);
    };

    expect(await identitySync.runOnce()).toEqual({ claimed: 1, done: 1, failed: 0 });

    expect(rowOf(store, "member/admin-1")?.version).toBeGreaterThan(queuedAs);
    await expect(store.isIdentitySyncPending("member/admin-1")).resolves.toBe(true);
    identity.setRole = setRole;
    expect(await identitySync.runOnce()).toEqual({ claimed: 1, done: 1, failed: 0 });
    expect(store.snapshot().identitySync).toEqual([]);
  });

  it("retries an unavailable provider with a backoff that starts at 1 s, doubles and stops at 5 minutes", async () => {
    const { identitySync, identity, store, clock, logger, tenant } = await coreWithMember();
    identity.available = false;
    const delays: number[] = [];

    for (let attempt = 0; attempt < 12; attempt += 1) {
      const before = clock.now().getTime();
      expect(await identitySync.runOnce()).toMatchObject({ failed: 2 });
      const row = rowOf(store, `tenant/${tenant.id}`);
      expect(row?.attempts).toBe(attempt + 1);
      expect(row?.lastError).toContain("unavailable");
      delays.push((row?.dueAt.getTime() ?? 0) - before);
      // Not due before its time, due at its time.
      clock.advanceMs((row?.dueAt.getTime() ?? 0) - before - 1);
      expect(await identitySync.runOnce()).toMatchObject({ claimed: 0 });
      clock.advanceMs(1);
    }

    expect(delays).toEqual([1000, 2000, 4000, 8000, 16_000, 32_000, 64_000, 128_000, 256_000, 300_000, 300_000, 300_000]);
    const warnings = logger.lines.filter((line) => line.level === "warn");
    expect(warnings.length).toBeGreaterThan(0);
    expect(logger.lines.filter((line) => line.level === "error")).toEqual([]);
  });

  it("retries a provider that refused every 5 minutes and logs an error with the status", async () => {
    const { identitySync, identity, store, clock, logger } = await coreWithMember();
    identity.rejectWith = 403;

    const first = clock.now().getTime();
    expect(await identitySync.runOnce()).toMatchObject({ failed: 2 });
    clock.advanceMs(300_000);
    expect(await identitySync.runOnce()).toMatchObject({ failed: 2 });

    const rows = store.snapshot().identitySync;
    expect(rows.every((row) => row.attempts === 2 && row.dueAt.getTime() === first + 600_000)).toBe(true);
    expect(rows[0]?.lastError).toContain("403");
    const errors = logger.lines.filter((line) => line.level === "error");
    expect(errors).toHaveLength(4);
    expect(errors[0]?.fields).toMatchObject({ status: 403, retryInMs: 300_000 });
    expect(logger.lines.filter((line) => line.level === "warn")).toEqual([]);
  });

  it("converges once the provider is reachable again", async () => {
    const { identitySync, identity, store, clock, tenant } = await coreWithMember();
    identity.available = false;
    await identitySync.runOnce();
    identity.available = true;
    clock.advanceMs(1000);

    expect(await identitySync.runOnce()).toEqual({ claimed: 2, done: 2, failed: 0 });

    expect(identity.roleOf(tenant.id, "admin-1")).toBe("tenant-admin");
    expect(identity.organizations.has(tenant.id)).toBe(true);
    expect(store.snapshot().identitySync).toEqual([]);
  });

  it("treats an error of another kind like a refusal: logged as an error, tried again slowly", async () => {
    const { store, clock, logger } = await coreWithMember();
    const reconcile = { execute: (_item: IdentitySyncItem) => Promise.reject(new Error("not what the admin API documents")) };
    const worker = new IdentitySyncWorker({ store, reconcile, clock, logger, pollMs: 5 });

    expect(await worker.runOnce()).toMatchObject({ failed: 2 });

    expect(store.snapshot().identitySync.every((row) => row.dueAt.getTime() === clock.now().getTime() + 300_000)).toBe(true);
    expect(logger.lines.filter((line) => line.level === "error")).toHaveLength(2);
  });

  it("polls in the background, recovers from a failure and stops cleanly", async () => {
    const core = await coreWithMember();
    const { store, identity, logger, clock, reconcile, tenant } = core;
    identity.available = false;
    const worker = new IdentitySyncWorker({ store, reconcile, clock, logger, pollMs: 5 });

    worker.start();
    worker.start(); // a second start changes nothing
    await waitFor(() => logger.lines.some((line) => line.level === "warn"));
    identity.available = true;
    clock.advanceMs(1000);
    await waitFor(() => store.snapshot().identitySync.length === 0);
    await worker.stop();
    expect(identity.roleOf(tenant.id, "admin-1")).toBe("tenant-admin");

    // Stopped: a change written now stays in the queue.
    await store.transaction((r) => r.identitySync.enqueue("member", "admin-1", clock.now()));
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(store.snapshot().identitySync).toHaveLength(1);
    // And the worker can be started again.
    worker.start();
    await waitFor(() => store.snapshot().identitySync.length === 0);
    await worker.stop();
  });

  it("keeps running when the queue cannot be read, and stops without finishing the rest of a batch", async () => {
    const core = await coreWithMember();
    const { store, logger, clock, reconcile } = core;
    const claim = store.claimIdentitySync.bind(store);
    let failures = 2;
    store.claimIdentitySync = (...args) => {
      if (failures > 0) {
        failures -= 1;
        return Promise.reject(new Error("database is down"));
      }
      return claim(...args);
    };
    const seen: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow = {
      execute: async (item: IdentitySyncItem) => {
        seen.push(item.key);
        await gate;
        await reconcile.execute(item);
      },
    };
    const worker = new IdentitySyncWorker({ store, reconcile: slow, clock, logger, pollMs: 5 });

    worker.start();
    await waitFor(() => seen.length === 1);
    expect(logger.lines.filter((line) => line.level === "error")).toHaveLength(2);
    const stopped = worker.stop();
    release();
    await stopped;

    // The first item was finished, the second was left for its lease to end; nothing was lost.
    expect(seen).toHaveLength(1);
    expect(store.snapshot().identitySync).toHaveLength(1);
    clock.advanceMs(DEFAULT_LEASE_MS);
    expect(await new IdentitySyncWorker({ store, reconcile, clock, logger, pollMs: 5 }).runOnce()).toMatchObject({ claimed: 1, done: 1 });
    expect(store.snapshot().identitySync).toEqual([]);
  });
});

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for the condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
