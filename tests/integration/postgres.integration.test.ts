import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { IdentitySyncWorker } from "../../src/adapters/identity-sync/worker.js";
import { FakeIdentityProvider } from "../../src/adapters/memory/fake-identity-provider.js";
import { MemoryEventPublisher } from "../../src/adapters/memory/memory-publisher.js";
import { OutboxRelay } from "../../src/adapters/outbox/relay.js";
import { MIGRATIONS_DIR, runMigrations } from "../../src/adapters/postgres/migrate.js";
import { PostgresStore, createPool } from "../../src/adapters/postgres/postgres-store.js";
import { newTenant } from "../../src/domain/tenant.js";
import { AcceptInvite } from "../../src/usecases/accept-invite.js";
import { ChangeMemberRole } from "../../src/usecases/change-member-role.js";
import { CreateInvite } from "../../src/usecases/create-invite.js";
import { CreateTenant } from "../../src/usecases/create-tenant.js";
import { ListMembers } from "../../src/usecases/list-members.js";
import { ListMyOrganizations } from "../../src/usecases/list-my-organizations.js";
import { ListTenants } from "../../src/usecases/list-tenants.js";
import { ShareJoin } from "../../src/usecases/share-join.js";
import type { OutboxMessage, UseCaseDeps } from "../../src/usecases/ports.js";
import { ReconcileIdentity } from "../../src/usecases/reconcile-identity.js";
import { FakeMarkets, shareToken } from "../support/fake-markets.js";
import { RecordingLogger, SequentialIds, TestClock, caller } from "../support/harness.js";

// These tests need a running Docker daemon: "npm run test:integration". They are not part of "npm test".

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let store: PostgresStore;
const logger = new RecordingLogger();

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:18").withDatabase("tenants").start();
  pool = createPool(container.getConnectionUri(), 8);
  await runMigrations(pool, logger);
  store = new PostgresStore(pool);
});

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  // RESTART IDENTITY also restarts the version sequence of the sync queue (it is owned by the column), so the versions
  // a test expects count from 1.
  await pool.query("TRUNCATE shared.identity_sync, shared.outbox, shared.invite_codes, shared.memberships, shared.tenants RESTART IDENTITY");
});

const now = new Date("2026-11-01T10:00:00.000Z");
const T1 = "00000000-0000-7000-8000-000000000001";
const T2 = "00000000-0000-7000-8000-000000000002";

async function insertTenant(id: string, slug: string): Promise<void> {
  await store.transaction((r) => r.tenants.insert(newTenant({ id, name: slug, slug, createdBy: "admin", now })));
}

describe("migrations", () => {
  it("record the applied files and apply nothing on a second run", async () => {
    const versions = await pool.query<{ version: string }>("SELECT version FROM shared.schema_migrations ORDER BY version");
    expect(versions.rows.map((row) => row.version)).toEqual(expect.arrayContaining(["001_init.sql", "002_identity_sync.sql", "003_identity_sync_version.sql", "004_identity_sync_lease.sql", "005_several_memberships.sql"]));
    expect(await runMigrations(pool, logger)).toEqual([]);
  });

  it("let 005 drop the one-tenant-per-user constraint, keep one membership per user and tenant, and queue every tenant and member again", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tenants-upgrade-005-"));
    await pool.query("DROP DATABASE IF EXISTS upgrade_probe WITH (FORCE)");
    await pool.query("CREATE DATABASE upgrade_probe");
    const url = new URL(container.getConnectionUri());
    url.pathname = "/upgrade_probe";
    const probe = createPool(url.toString(), 2);
    try {
      const earlier = ["001_init.sql", "002_identity_sync.sql", "003_identity_sync_version.sql", "004_identity_sync_lease.sql"];
      for (const file of earlier) await copyFile(new URL(file, MIGRATIONS_DIR), join(directory, file));
      const directoryUrl = pathToFileURL(`${directory}/`);
      await runMigrations(probe, logger, directoryUrl);
      const tenant = (id: string, slug: string) =>
        probe.query("INSERT INTO shared.tenants (id, name, slug, status, created_by, created_at) VALUES ($1, $2, $2, 'active', 'a', now())", [id, slug]);
      const member = (tenantId: string, userId: string) =>
        probe.query("INSERT INTO shared.memberships (tenant_id, user_id, role, joined_at, updated_at) VALUES ($1, $2, 'trader', now(), now())", [tenantId, userId]);
      await tenant(T1, "tenant-one");
      await tenant(T2, "tenant-two");
      await member(T1, "user-1");
      await member(T1, "user-2");
      // Before 005 a user belongs to one tenant only.
      await expect(member(T2, "user-1")).rejects.toMatchObject({ code: "23505" });
      // One tenant is queued already, as it would be during a sync: it keeps its row and gets a newer version.
      await probe.query("INSERT INTO shared.identity_sync (key, kind, target, version, due_at, attempts, last_error, created_at, updated_at) VALUES ($1, 'tenant', $2, 1, now() + interval '1 hour', 4, 'old', now(), now())", [`tenant/${T1}`, T1]);

      await copyFile(new URL("005_several_memberships.sql", MIGRATIONS_DIR), join(directory, "005_several_memberships.sql"));
      expect(await runMigrations(probe, logger, directoryUrl)).toEqual(["005_several_memberships.sql"]);

      await member(T2, "user-1");
      await expect(member(T2, "user-1")).rejects.toMatchObject({ code: "23505" });
      const queued = await probe.query<{ key: string; attempts: number; last_error: string | null; due: boolean }>(
        "SELECT key, attempts, last_error, due_at <= now() AS due FROM shared.identity_sync ORDER BY key",
      );
      expect(queued.rows.map((row) => row.key)).toEqual([`member/user-1`, `member/user-2`, `tenant/${T1}`, `tenant/${T2}`].sort());
      expect(queued.rows.every((row) => row.attempts === 0 && row.last_error === null && row.due)).toBe(true);
      const index = await probe.query("SELECT 1 FROM pg_indexes WHERE schemaname = 'shared' AND indexname = 'memberships_user_idx'");
      expect(index.rowCount).toBe(1);
    } finally {
      await probe.end();
      await pool.query("DROP DATABASE IF EXISTS upgrade_probe WITH (FORCE)");
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("start the version sequence of the sync queue above the versions that are already queued (003) and lease no existing row (004), on a database with rows", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tenants-upgrade-"));
    await pool.query("DROP DATABASE IF EXISTS upgrade_probe WITH (FORCE)");
    await pool.query("CREATE DATABASE upgrade_probe");
    const url = new URL(container.getConnectionUri());
    url.pathname = "/upgrade_probe";
    const probe = createPool(url.toString(), 2);
    try {
      for (const file of ["001_init.sql", "002_identity_sync.sql"]) await copyFile(new URL(file, MIGRATIONS_DIR), join(directory, file));
      const directoryUrl = pathToFileURL(`${directory}/`);
      await runMigrations(probe, logger, directoryUrl);
      await probe.query(
        `INSERT INTO shared.identity_sync (key, kind, target, version, due_at, created_at, updated_at)
         VALUES ('member/a', 'member', 'a', 7, now(), now(), now()), ('member/b', 'member', 'b', 3, now(), now(), now())`,
      );

      await copyFile(new URL("003_identity_sync_version.sql", MIGRATIONS_DIR), join(directory, "003_identity_sync_version.sql"));
      expect(await runMigrations(probe, logger, directoryUrl)).toEqual(["003_identity_sync_version.sql"]);

      // The next version is above every queued one, and a row inserted without a version takes the next one.
      expect((await probe.query<{ v: string }>("SELECT nextval('shared.identity_sync_version_seq') AS v")).rows[0]?.v).toBe("8");
      await probe.query("INSERT INTO shared.identity_sync (key, kind, target, due_at, created_at, updated_at) VALUES ('member/c', 'member', 'c', now(), now(), now())");
      expect((await probe.query<{ version: string }>("SELECT version FROM shared.identity_sync WHERE key = 'member/c'")).rows[0]?.version).toBe("9");

      // 004 adds the lease column: the rows that were queued before it are not leased and can be claimed at once.
      await copyFile(new URL("004_identity_sync_lease.sql", MIGRATIONS_DIR), join(directory, "004_identity_sync_lease.sql"));
      expect(await runMigrations(probe, logger, directoryUrl)).toEqual(["004_identity_sync_lease.sql"]);
      expect((await probe.query("SELECT 1 FROM shared.identity_sync WHERE lease_until IS NULL")).rowCount).toBe(3);
      const probeStore = new PostgresStore(probe);
      const claimed = await probeStore.claimIdentitySync(10, new Date(Date.now() + 60_000), new Date(Date.now() + 1000));
      expect(claimed.map((item) => item.key).sort()).toEqual(["member/a", "member/b", "member/c"]);
    } finally {
      await probe.end();
      await pool.query("DROP DATABASE IF EXISTS upgrade_probe WITH (FORCE)");
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("refuse a file that was changed after it was applied, and apply a new file once under concurrency", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tenants-migrations-"));
    try {
      const url = pathToFileURL(`${directory}/`);
      await writeFile(join(directory, "900_probe.sql"), "CREATE TABLE shared.probe (id integer);\n");
      const runs = await Promise.all([runMigrations(pool, logger, url), runMigrations(pool, logger, url)]);
      expect(runs.map((applied) => applied.length).sort()).toEqual([0, 1]);

      await writeFile(join(directory, "900_probe.sql"), "CREATE TABLE shared.probe (id bigint);\n");
      await expect(runMigrations(pool, logger, url)).rejects.toThrow(/changed after it was applied/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("constraints are the last guard", () => {
  it("rejects a malformed slug, an unknown status and a duplicate slug", async () => {
    const insert = (slug: string, status = "active") =>
      pool.query("INSERT INTO shared.tenants (id, name, slug, status, created_by, created_at) VALUES ($1, 'n', $2, $3, 'a', now())", [T1, slug, status]);
    await expect(insert("Bad Slug")).rejects.toMatchObject({ code: "23514" });
    await expect(insert("-bad")).rejects.toMatchObject({ code: "23514" });
    await expect(insert("ab")).rejects.toMatchObject({ code: "23514" });
    await expect(insert("good-slug", "deleted")).rejects.toMatchObject({ code: "23514" });
    await insert("good-slug");
    await expect(store.transaction((r) => r.tenants.insert(newTenant({ id: T2, name: "x", slug: "good-slug", createdBy: "a", now })))).rejects.toMatchObject({
      code: "slug_taken",
    });
  });

  it("keeps one membership per user and tenant, lets a user belong to several tenants, and restricts roles", async () => {
    await insertTenant(T1, "tenant-one");
    await insertTenant(T2, "tenant-two");
    const insert = (tenantId: string, userId: string, role = "trader") =>
      pool.query("INSERT INTO shared.memberships (tenant_id, user_id, role, joined_at, updated_at) VALUES ($1, $2, $3, now(), now())", [tenantId, userId, role]);
    await insert(T1, "user-1");
    await insert(T2, "user-1");
    await expect(insert(T1, "user-1")).rejects.toMatchObject({ code: "23505" });
    await expect(insert(T2, "user-1", "tenant-admin")).rejects.toMatchObject({ code: "23505" });
    await expect(insert(T1, "user-2", "owner")).rejects.toMatchObject({ code: "23514" });
    await expect(insert("00000000-0000-7000-8000-0000000000ff", "user-3")).rejects.toMatchObject({ code: "23503" });
  });

  it("keeps invite uses within 0..max_uses", async () => {
    await insertTenant(T1, "tenant-one");
    const insert = (hash: string, maxUses: number, uses: number) =>
      pool.query(
        "INSERT INTO shared.invite_codes (code_hash, tenant_id, role, max_uses, uses, expires_at, created_by, created_at) VALUES ($1, $2, 'trader', $3, $4, now(), 'a', now())",
        [hash, T1, maxUses, uses],
      );
    await insert("h1", 2, 2);
    await expect(insert("h2", 0, 0)).rejects.toMatchObject({ code: "23514" });
    await expect(insert("h3", 1, 2)).rejects.toMatchObject({ code: "23514" });
    await expect(insert("h4", 1, -1)).rejects.toMatchObject({ code: "23514" });
    await expect(pool.query("UPDATE shared.invite_codes SET uses = uses + 1 WHERE code_hash = 'h1'")).rejects.toMatchObject({ code: "23514" });
  });
});

describe("transactions", () => {
  it("roll back every statement when the callback fails", async () => {
    await expect(
      store.transaction(async (r) => {
        await r.tenants.insert(newTenant({ id: T1, name: "x", slug: "rolled-back", createdBy: "a", now }));
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect((await pool.query("SELECT 1 FROM shared.tenants")).rowCount).toBe(0);
  });

  it("commit tenant, invite, outbox row and sync item together", async () => {
    const deps = depsOver(store);
    const created = await new CreateTenant(deps, 168).execute({ name: "Acme", slug: "acme", caller: caller("platform-1") });
    expect((await pool.query("SELECT 1 FROM shared.tenants")).rowCount).toBe(1);
    expect((await pool.query("SELECT 1 FROM shared.invite_codes WHERE tenant_id = $1", [created.tenant.id])).rowCount).toBe(1);
    expect((await pool.query("SELECT key, kind, target, version, attempts FROM shared.identity_sync")).rows).toEqual([
      { key: `tenant/${created.tenant.id}`, kind: "tenant", target: created.tenant.id, version: "1", attempts: 0 },
    ]);
    const outbox = await pool.query<{ subject: string; payload: { data: { slug: string } } }>("SELECT subject, payload FROM shared.outbox");
    expect(outbox.rows).toEqual([{ subject: `chance.tenants.TenantCreated.${created.tenant.id}`, payload: expect.objectContaining({ data: expect.objectContaining({ slug: "acme" }) }) }]);
  });
});

describe("outbox claim", () => {
  const message = (n: number): OutboxMessage => ({
    id: `00000000-0000-7000-8000-${String(n).padStart(12, "0")}`,
    aggregateId: "agg",
    subject: "chance.tenants.TenantCreated.x",
    type: "si.chance.tenants.TenantCreated.v1",
    payload: { specversion: "1.0", id: "x", source: "/chance/tenants", type: "t", subject: "s", time: now.toISOString(), datacontenttype: "application/json", tenantid: "x", correlationid: "c", causationid: "r", data: {} },
    createdAt: new Date(now.getTime() + n),
  });

  it("lets one relay claim at a time: while a claim transaction is open, a second claim gets nothing (advisory lock)", async () => {
    await store.transaction(async (r) => {
      for (let n = 1; n <= 4; n += 1) await r.outbox.add(message(n));
    });

    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    let firstHasClaimed: () => void = () => undefined;
    const claimed = new Promise<void>((resolve) => (firstHasClaimed = resolve));
    let claimedByFirst: string[] = [];
    const first = store.transaction(async (r) => {
      claimedByFirst = (await r.outbox.claimBatch(2)).map((row) => row.id);
      firstHasClaimed();
      await held;
    });
    await claimed;

    // The other rows are free, but the second relay still gets nothing: it must not publish while the first does.
    const second = await store.transaction(async (r) => (await r.outbox.claimBatch(10)).map((row) => row.id));
    const publisher = new MemoryEventPublisher();
    const relay = new OutboxRelay({ store, publisher, clock: new TestClock(), logger, pollMs: 10 });
    const polled = await relay.runOnce();
    release();
    await first;

    expect(claimedByFirst).toEqual([message(1).id, message(2).id]);
    expect(second).toEqual([]);
    expect(polled).toEqual({ published: 0, failed: false });
    expect(publisher.published).toEqual([]);
    // Once the first transaction has ended, the next claim gets the rows again, in order.
    const third = await store.transaction(async (r) => (await r.outbox.claimBatch(10)).map((row) => row.id));
    expect(third).toEqual([1, 2, 3, 4].map((n) => message(n).id));
  });

  it("frees the lock when the claiming transaction fails, so a crashed relay does not block the others", async () => {
    await store.transaction((r) => r.outbox.add(message(1)));

    await expect(
      store.transaction(async (r) => {
        expect(await r.outbox.claimBatch(10)).toHaveLength(1);
        throw new Error("the relay died");
      }),
    ).rejects.toThrow("the relay died");

    expect(await store.transaction(async (r) => (await r.outbox.claimBatch(10)).map((row) => row.id))).toEqual([message(1).id]);
  });

  it("keeps the order with two relays running at once: while the first publishes rows 1 and 2, the second must not take row 3", async () => {
    await store.transaction(async (r) => {
      for (let n = 1; n <= 3; n += 1) await r.outbox.add(message(n));
    });
    const publisher = new MemoryEventPublisher();
    let publishing: () => void = () => undefined;
    const started = new Promise<void>((resolve) => (publishing = resolve));
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const publish = publisher.publish.bind(publisher);
    let slowOnce = true;
    publisher.publish = async (...args) => {
      if (slowOnce) {
        slowOnce = false;
        publishing();
        await gate; // a slow broker, for the first publish only
      }
      return publish(...args);
    };
    const options = { store, publisher, clock: new TestClock(), logger, pollMs: 10 };

    // The first relay holds rows 1 and 2; row 3 is not locked by anyone, and only the advisory lock keeps it back.
    const slow = new OutboxRelay({ ...options, batchSize: 2 }).runOnce();
    await started;
    const other = await new OutboxRelay(options).runOnce();
    open();

    expect(other).toEqual({ published: 0, failed: false });
    expect(await slow).toEqual({ published: 2, failed: false });
    expect(await new OutboxRelay(options).runOnce()).toEqual({ published: 1, failed: false });
    expect(publisher.published.map((m) => m.messageId)).toEqual([1, 2, 3].map((n) => message(n).id));
  });

  it("deletes the rows published before the cutoff and keeps later, equal and unpublished ones", async () => {
    await store.transaction(async (r) => {
      for (let n = 1; n <= 4; n += 1) await r.outbox.add(message(n));
    });
    const cutoff = new Date(now.getTime() + 10_000);
    await store.transaction(async (r) => {
      await r.outbox.markPublished(message(1).id, new Date(cutoff.getTime() - 1));
      await r.outbox.markPublished(message(2).id, cutoff);
      await r.outbox.markPublished(message(3).id, new Date(cutoff.getTime() + 1));
    });

    expect(await store.repositories.outbox.purgePublished(cutoff)).toBe(1);

    const left = await pool.query<{ id: string }>("SELECT id FROM shared.outbox ORDER BY created_at");
    expect(left.rows.map((row) => row.id)).toEqual([2, 3, 4].map((n) => message(n).id));
    expect(await store.repositories.outbox.purgePublished(cutoff)).toBe(0);
  });

  it("is purged by the relay: rows published more than 30 days ago (the default) go, younger and unpublished rows stay", async () => {
    await store.transaction(async (r) => {
      for (let n = 1; n <= 3; n += 1) await r.outbox.add(message(n));
    });
    const clock = new TestClock();
    const relay = new OutboxRelay({ store, publisher: new MemoryEventPublisher(), clock, logger, pollMs: 10, batchSize: 2 });
    await relay.runOnce(); // rows 1 and 2 are published now (TestClock time), row 3 waits
    clock.advanceHours(24 * 31);

    expect(await relay.purgeIfDue()).toBe(2);

    expect((await pool.query<{ id: string }>("SELECT id FROM shared.outbox")).rows.map((row) => row.id)).toEqual([message(3).id]);
  });

  it("is drained in order by the relay, which marks the rows", async () => {
    await store.transaction(async (r) => {
      for (let n = 1; n <= 3; n += 1) await r.outbox.add(message(n));
    });
    const publisher = new MemoryEventPublisher();
    const relay = new OutboxRelay({ store, publisher, clock: new TestClock(), logger, pollMs: 10 });

    expect(await relay.runOnce()).toEqual({ published: 3, failed: false });

    expect(publisher.published.map((m) => m.messageId)).toEqual([message(1).id, message(2).id, message(3).id]);
    expect((await pool.query("SELECT 1 FROM shared.outbox WHERE published_at IS NULL")).rowCount).toBe(0);
  });
});

function depsOver(target: PostgresStore): UseCaseDeps {
  return { store: target, clock: new TestClock(), ids: new SequentialIds(), logger };
}

describe("identity sync queue", () => {
  const at = (ms: number) => new Date(now.getTime() + ms);
  const enqueue = (kind: "tenant" | "member", target: string, when: Date) => store.transaction((r) => r.identitySync.enqueue(kind, target, when));
  const rowOf = async (key: string) =>
    (await pool.query<{ version: string; attempts: number; last_error: string | null; due_at: Date; lease_until: Date | null; updated_at: Date; created_at: Date }>(
      "SELECT version, attempts, last_error, due_at, lease_until, updated_at, created_at FROM shared.identity_sync WHERE key = $1",
      [key],
    )).rows[0];

  it("accepts only the two kinds", async () => {
    const insert = (kind: string) =>
      pool.query("INSERT INTO shared.identity_sync (key, kind, target, due_at, created_at, updated_at) VALUES ($1, $2, 't', now(), now(), now())", [`${kind}/t`, kind]);
    await insert("tenant");
    await insert("member");
    await expect(insert("organization")).rejects.toMatchObject({ code: "23514" });
    await expect(insert("tenant")).rejects.toMatchObject({ code: "23505" });
  });

  it("enqueues once per key: a repeat bumps the version, makes the item due at once and clears the failures", async () => {
    await enqueue("member", "u-1", at(0));
    expect(await rowOf("member/u-1")).toMatchObject({ version: "1", attempts: 0, last_error: null, due_at: at(0), created_at: at(0), updated_at: at(0) });
    const [claimed] = await store.claimIdentitySync(5, at(30_000), at(0));
    await store.failIdentitySync("member/u-1", claimed?.version ?? 0, "boom", at(60_000));
    expect(await rowOf("member/u-1")).toMatchObject({ version: "1", attempts: 1, last_error: "boom", due_at: at(60_000) });

    await enqueue("member", "u-1", at(1000));

    // The version is a new number from the sequence (not necessarily the next one: an enqueue that finds the row
    // has taken a number for the insert it did not do).
    const bumped = await rowOf("member/u-1");
    expect(bumped).toMatchObject({ attempts: 0, last_error: null, due_at: at(1000), created_at: at(0), updated_at: at(1000) });
    expect(Number(bumped?.version)).toBeGreaterThan(1);
    expect((await pool.query("SELECT 1 FROM shared.identity_sync")).rowCount).toBe(1);
  });

  it("keeps an item of a transaction that is rolled back out of the queue", async () => {
    await expect(
      store.transaction(async (r) => {
        await r.identitySync.enqueue("tenant", T1, at(0));
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await store.isIdentitySyncPending(`tenant/${T1}`)).toBe(false);
  });

  it("claims only due items that are not leased, oldest first, up to the limit, and leases them in the same statement without moving the due time", async () => {
    await enqueue("member", "late", at(5000));
    await enqueue("member", "b", at(1000));
    await enqueue("tenant", "a", at(1000));
    await enqueue("member", "oldest", at(0));

    const first = await store.claimIdentitySync(2, at(31_000), at(1000));

    expect(first.map((item) => item.key).sort()).toEqual(["member/b", "member/oldest"]);
    expect(first.find((item) => item.key === "member/oldest")).toEqual({ key: "member/oldest", kind: "member", target: "oldest", version: expect.any(Number), attempts: 0 });
    expect(await rowOf("member/oldest")).toMatchObject({ due_at: at(0), lease_until: at(31_000) });
    // Leased items are not claimable while the lease lasts; the next claim gets the one that was left, never the item that is not due yet.
    expect((await store.claimIdentitySync(10, at(31_000), at(1000))).map((item) => item.key)).toEqual(["tenant/a"]);
    expect(await store.claimIdentitySync(10, at(31_000), at(1000))).toEqual([]);
    // The item that was not due is claimed once its time has come; the leased ones are claimable again after their lease.
    expect((await store.claimIdentitySync(10, at(99_000), at(5000))).map((item) => item.key)).toEqual(["member/late"]);
    expect((await store.claimIdentitySync(10, at(99_000), at(31_000))).map((item) => item.key).sort()).toEqual(["member/b", "member/oldest", "tenant/a"]);
  });

  it("gives two concurrent claims different items", async () => {
    for (let n = 1; n <= 6; n += 1) await enqueue("member", `u-${n}`, at(n));

    const [one, two] = await Promise.all([store.claimIdentitySync(3, at(30_000), at(100)), store.claimIdentitySync(3, at(30_000), at(100))]);

    expect(one).toHaveLength(3);
    expect(two).toHaveLength(3);
    expect(new Set([...one, ...two].map((item) => item.key)).size).toBe(6);
  });

  it("skips rows that another worker has locked at this moment instead of waiting for them (SKIP LOCKED)", async () => {
    for (let n = 1; n <= 4; n += 1) await enqueue("member", `u-${n}`, at(n));
    const holder = await pool.connect();
    try {
      await holder.query("BEGIN");
      const locked = await holder.query<{ key: string }>("SELECT key FROM shared.identity_sync ORDER BY due_at, key LIMIT 2 FOR UPDATE");
      expect(locked.rows.map((row) => row.key)).toEqual(["member/u-1", "member/u-2"]);

      const claimed = await store.claimIdentitySync(10, at(30_000), at(100));

      expect(claimed.map((item) => item.key).sort()).toEqual(["member/u-3", "member/u-4"]);
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
    // The rows the holder had locked are still due and are claimed by the next poll.
    expect((await store.claimIdentitySync(10, at(30_000), at(100))).map((item) => item.key).sort()).toEqual(["member/u-1", "member/u-2"]);
  });

  it("completes only the claimed version: an enqueue that came meanwhile keeps the row", async () => {
    await enqueue("member", "u-1", at(0));
    const [claimed] = await store.claimIdentitySync(1, at(30_000), at(0));
    await enqueue("member", "u-1", at(10));
    const queuedAgain = Number((await rowOf("member/u-1"))?.version);
    expect(queuedAgain).toBeGreaterThan(claimed?.version ?? 0);

    await store.completeIdentitySync("member/u-1", claimed?.version ?? 0);

    expect(await rowOf("member/u-1")).toMatchObject({ version: String(queuedAgain), due_at: at(10) });
    expect(await store.isIdentitySyncPending("member/u-1")).toBe(true);
    await store.completeIdentitySync("member/u-1", queuedAgain);
    expect(await store.isIdentitySyncPending("member/u-1")).toBe(false);
  });

  it("keeps a newer row when an old claim is completed or failed late: a deleted and queued-again key never gets an old version back", async () => {
    await enqueue("member", "u-1", at(0));
    // Worker A claims the item and its lease runs out; worker B takes it over and finishes it ...
    const [claimedByA] = await store.claimIdentitySync(1, at(30_000), at(0));
    const [claimedByB] = await store.claimIdentitySync(1, at(90_000), at(31_000));
    await store.completeIdentitySync("member/u-1", claimedByB?.version ?? 0);
    expect(await rowOf("member/u-1")).toBeUndefined();
    // ... then a new change queues the key again. With a counter per key this row would have version 1 again.
    await enqueue("member", "u-1", at(32_000));

    // Worker A reports its old claim.
    await store.completeIdentitySync("member/u-1", claimedByA?.version ?? 0);
    await store.failIdentitySync("member/u-1", claimedByA?.version ?? 0, "late failure", at(99_000));

    const row = await rowOf("member/u-1");
    expect(row).toMatchObject({ attempts: 0, last_error: null, due_at: at(32_000) });
    expect(Number(row?.version)).toBeGreaterThan(claimedByB?.version ?? 0);
    expect(await store.isIdentitySyncPending("member/u-1")).toBe(true);
  });

  it("keeps the lease when a change is queued again: no second claimer, also not two at once, gets the row until the lease has ended", async () => {
    await enqueue("member", "u-1", at(0));
    const [first] = await store.claimIdentitySync(1, at(120_000), at(0));

    // A change arrives while the first claimer works on the item: a new version, due at once, but still leased.
    await enqueue("member", "u-1", at(1000));

    expect(await rowOf("member/u-1")).toMatchObject({ due_at: at(1000), lease_until: at(120_000) });
    expect(Number((await rowOf("member/u-1"))?.version)).toBeGreaterThan(first?.version ?? 0);
    expect(await Promise.all([store.claimIdentitySync(5, at(240_000), at(1000)), store.claimIdentitySync(5, at(240_000), at(119_999))])).toEqual([[], []]);
    // A first claimer that never reports back (a crashed instance) loses the item when the lease has ended.
    const [takenOver] = await store.claimIdentitySync(5, at(240_000), at(120_000));
    expect(takenOver).toMatchObject({ key: "member/u-1", version: Number((await rowOf("member/u-1"))?.version) });
  });

  it("makes the newer version claimable at once when the claimer completes the old version", async () => {
    await enqueue("member", "u-1", at(0));
    const [first] = await store.claimIdentitySync(1, at(120_000), at(0));
    await enqueue("member", "u-1", at(1000));
    expect(await store.claimIdentitySync(5, at(240_000), at(2000))).toEqual([]);

    await store.completeIdentitySync("member/u-1", first?.version ?? 0);

    expect(await rowOf("member/u-1")).toMatchObject({ lease_until: null, attempts: 0, last_error: null, due_at: at(1000) });
    const [next] = await store.claimIdentitySync(5, at(240_000), at(2001));
    expect(next).toMatchObject({ key: "member/u-1", version: Number((await rowOf("member/u-1"))?.version) });
    expect(next?.version).toBeGreaterThan(first?.version ?? 0);
    // Completing a key that is gone, or a version that is not the row's, changes nothing else.
    await store.completeIdentitySync("member/gone", 1);
    await store.completeIdentitySync("member/u-1", next?.version ?? 0);
    expect(await store.isIdentitySyncPending("member/u-1")).toBe(false);
  });

  it("clears the lease when the claimed version fails, and only the lease when a newer version is queued", async () => {
    await enqueue("member", "u-1", at(0));
    const [claimed] = await store.claimIdentitySync(1, at(120_000), at(0));

    await store.failIdentitySync("member/u-1", claimed?.version ?? 0, "boom", at(5000));

    expect(await rowOf("member/u-1")).toMatchObject({ lease_until: null, attempts: 1, last_error: "boom", due_at: at(5000) });
    expect(await store.claimIdentitySync(5, at(120_000), at(4999))).toEqual([]);
    const [retried] = await store.claimIdentitySync(5, at(125_000), at(5000));
    expect(retried).toMatchObject({ key: "member/u-1", attempts: 1 });

    // A change arrives while the retry is processed; the retry then fails: the newer row keeps its data and loses the lease.
    await enqueue("member", "u-1", at(6000));
    await store.failIdentitySync("member/u-1", retried?.version ?? 0, "late failure", at(99_000));

    expect(await rowOf("member/u-1")).toMatchObject({ lease_until: null, attempts: 0, last_error: null, due_at: at(6000) });
    expect((await store.claimIdentitySync(5, at(126_000), at(6000))).map((item) => item.key)).toEqual(["member/u-1"]);
  });

  it("takes every version from one sequence, so the versions of all keys differ and only grow, also after a rolled-back enqueue", async () => {
    const versionOf = async (key: string) => Number((await rowOf(key))?.version);
    await enqueue("member", "a", at(0));
    await enqueue("tenant", T1, at(0));
    await expect(
      store.transaction(async (r) => {
        await r.identitySync.enqueue("member", "b", at(0));
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await enqueue("member", "a", at(1));
    await enqueue("member", "b", at(2));

    const versions = [await versionOf("tenant/" + T1), await versionOf("member/a"), await versionOf("member/b")];

    expect(new Set(versions).size).toBe(3);
    expect(versions).toEqual([...versions].sort((x, y) => x - y));
    expect(await versionOf("member/a")).toBeGreaterThan(1);
  });

  it("fails only the claimed version: it counts the attempt, keeps the error and sets the retry time", async () => {
    await enqueue("tenant", T1, at(0));
    const [claimed] = await store.claimIdentitySync(1, at(30_000), at(0));
    await enqueue("tenant", T1, at(10));
    const current = Number((await rowOf(`tenant/${T1}`))?.version);

    await store.failIdentitySync(`tenant/${T1}`, claimed?.version ?? 0, "stale failure", at(99_000));
    expect(await rowOf(`tenant/${T1}`)).toMatchObject({ version: String(current), attempts: 0, last_error: null, due_at: at(10) });

    await store.failIdentitySync(`tenant/${T1}`, current, "unavailable", at(2000));
    await store.failIdentitySync(`tenant/${T1}`, current, "unavailable again", at(4000));
    expect(await rowOf(`tenant/${T1}`)).toMatchObject({ version: String(current), attempts: 2, last_error: "unavailable again", due_at: at(4000) });
    expect((await store.claimIdentitySync(5, at(40_000), at(3999))).map((item) => item.attempts)).toEqual([]);
    expect((await store.claimIdentitySync(5, at(40_000), at(4000))).map((item) => item.attempts)).toEqual([2]);
  });

  it("is drained by the worker over the real queue: organization, member and role end up in the provider", async () => {
    const deps = depsOver(store);
    const { tenant, adminInvite } = await new CreateTenant(deps, 168).execute({ name: "Acme", slug: "acme", caller: caller("platform-1") });
    await new AcceptInvite(deps).execute({ code: adminInvite.code, caller: caller("admin-a") });
    expect(await store.isIdentitySyncPending("member/admin-a")).toBe(true);
    const identity = new FakeIdentityProvider();
    const worker = new IdentitySyncWorker({ store, reconcile: new ReconcileIdentity({ store, identity }), clock: new TestClock(), logger, pollMs: 10 });

    expect(await worker.runOnce()).toEqual({ claimed: 2, done: 2, failed: 0 });

    expect(identity.organizations.get(tenant.id)).toBe("Acme");
    expect(identity.members.has(`${tenant.id}:admin-a`)).toBe(true);
    expect(identity.roleOf(tenant.id, "admin-a")).toBe("tenant-admin");
    expect((await pool.query("SELECT 1 FROM shared.identity_sync")).rowCount).toBe(0);
    expect(await store.isIdentitySyncPending("member/admin-a")).toBe(false);
  });
});

describe("use cases over PostgreSQL", () => {
  it("lets only one of two concurrent demotions of the two admins through", async () => {
    const deps = depsOver(store);
    const { tenant, adminInvite } = await new CreateTenant(deps, 168).execute({ name: "Acme", slug: "acme", caller: caller("platform-1") });
    const accept = new AcceptInvite(deps);
    await accept.execute({ code: adminInvite.code, caller: caller("admin-a") });
    const second = await new CreateInvite(deps).execute({ tenantId: tenant.id, role: "tenant-admin", maxUses: 1, expiresInHours: 1, caller: caller("admin-a") });
    await accept.execute({ code: second.code, caller: caller("admin-b") });

    const change = new ChangeMemberRole(deps);
    const results = await Promise.allSettled([
      change.execute({ tenantId: tenant.id, userId: "admin-a", role: "trader", caller: caller("admin-b") }),
      change.execute({ tenantId: tenant.id, userId: "admin-b", role: "trader", caller: caller("admin-a") }),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected");
    expect(rejected).toMatchObject({ reason: expect.objectContaining({ code: "last_admin" }) });
    const admins = await pool.query("SELECT 1 FROM shared.memberships WHERE role = 'tenant-admin'");
    expect(admins.rowCount).toBe(1);
  });

  it("answers the second of two simultaneous identical demotions as an unchanged role, with one event", async () => {
    const deps = depsOver(store);
    const { tenant, adminInvite } = await new CreateTenant(deps, 168).execute({ name: "Acme", slug: "acme", caller: caller("platform-1") });
    const accept = new AcceptInvite(deps);
    await accept.execute({ code: adminInvite.code, caller: caller("admin-a") });
    const second = await new CreateInvite(deps).execute({ tenantId: tenant.id, role: "tenant-admin", maxUses: 2, expiresInHours: 1, caller: caller("admin-a") });
    await accept.execute({ code: second.code, caller: caller("admin-b") });
    await accept.execute({ code: second.code, caller: caller("admin-c") });
    await pool.query("TRUNCATE shared.identity_sync, shared.outbox RESTART IDENTITY");

    const change = new ChangeMemberRole(deps);
    const results = await Promise.all([
      change.execute({ tenantId: tenant.id, userId: "admin-c", role: "trader", caller: caller("admin-a", 1) }),
      change.execute({ tenantId: tenant.id, userId: "admin-c", role: "trader", caller: caller("admin-b", 2) }),
    ]);

    expect(results.map((membership) => membership.role)).toEqual(["trader", "trader"]);
    const events = await pool.query<{ payload: { data: { oldRole: string; newRole: string } } }>("SELECT payload FROM shared.outbox");
    expect(events.rows.map((row) => row.payload.data)).toEqual([expect.objectContaining({ oldRole: "tenant-admin", newRole: "trader" })]);
    // One enqueue only: the unchanged role did not queue anything again (the sequence was restarted above).
    expect((await pool.query("SELECT version FROM shared.identity_sync WHERE key = 'member/admin-c'")).rows).toEqual([{ version: "1" }]);
  });

  it("answers a role change for an unknown tenant or member with 404 and takes no lock that outlives the request", async () => {
    const deps = depsOver(store);
    const { tenant } = await new CreateTenant(deps, 168).execute({ name: "Acme", slug: "acme", caller: caller("platform-1") });
    const change = new ChangeMemberRole(deps);

    await expect(change.execute({ tenantId: tenant.id, userId: "nobody", role: "trader", caller: caller("admin-a") })).rejects.toMatchObject({ kind: "not_found" });
    await expect(change.execute({ tenantId: T2, userId: "nobody", role: "trader", caller: caller("admin-a") })).rejects.toMatchObject({ kind: "not_found" });
    // The tenant row is free again: a second transaction can lock it at once.
    await expect(store.transaction((r) => r.tenants.findById(tenant.id, { lock: true }))).resolves.toMatchObject({ id: tenant.id });
  });

  it("lets a single-use invite be used once when two users race for it", async () => {
    const deps = depsOver(store);
    const { adminInvite } = await new CreateTenant(deps, 168).execute({ name: "Acme", slug: "acme", caller: caller("platform-1") });
    const accept = new AcceptInvite(deps);

    const results = await Promise.allSettled([
      accept.execute({ code: adminInvite.code, caller: caller("user-1") }),
      accept.execute({ code: adminInvite.code, caller: caller("user-2") }),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({ reason: expect.objectContaining({ code: "invite_used_up" }) });
    expect((await pool.query("SELECT uses FROM shared.invite_codes")).rows).toEqual([{ uses: 1 }]);
    // Only the winner has a membership, an event and a sync item.
    expect((await pool.query("SELECT 1 FROM shared.memberships")).rowCount).toBe(1);
    expect((await pool.query("SELECT 1 FROM shared.identity_sync WHERE kind = 'member'")).rowCount).toBe(1);
  });

  it("answers the same user's two simultaneous requests for one invite with one membership", async () => {
    const deps = depsOver(store);
    const { tenant, adminInvite } = await new CreateTenant(deps, 168).execute({ name: "Acme", slug: "acme", caller: caller("platform-1") });
    const accept = new AcceptInvite(deps);

    const results = await Promise.all([
      accept.execute({ code: adminInvite.code, caller: caller("user-1", 1) }),
      accept.execute({ code: adminInvite.code, caller: caller("user-1", 2) }),
    ]);

    expect(results).toEqual([
      { tenantId: tenant.id, role: "tenant-admin" },
      { tenantId: tenant.id, role: "tenant-admin" },
    ]);
    expect((await pool.query("SELECT 1 FROM shared.memberships")).rowCount).toBe(1);
    expect((await pool.query("SELECT 1 FROM shared.outbox WHERE type LIKE '%MemberJoined%'")).rowCount).toBe(1);
  });

  it("lets a user join two tenants at the same moment: two memberships, both invites used, one sync item for the user", async () => {
    const deps = depsOver(store);
    const create = new CreateTenant(deps, 168);
    const one = await create.execute({ name: "One", slug: "one", caller: caller("platform-1") });
    const two = await create.execute({ name: "Two", slug: "two", caller: caller("platform-1") });
    const accept = new AcceptInvite(deps);

    const results = await Promise.all([
      accept.execute({ code: one.adminInvite.code, caller: caller("user-1", 1) }),
      accept.execute({ code: two.adminInvite.code, caller: caller("user-1", 2) }),
    ]);

    expect(results.map((result) => result.tenantId).sort()).toEqual([one.tenant.id, two.tenant.id].sort());
    expect((await pool.query("SELECT 1 FROM shared.memberships")).rowCount).toBe(2);
    expect((await pool.query("SELECT sum(uses)::int AS used FROM shared.invite_codes")).rows).toEqual([{ used: 2 }]);
    expect((await pool.query("SELECT 1 FROM shared.identity_sync WHERE kind = 'member'")).rowCount).toBe(1);
  });

  it("lists the organizations of a user in the order of joining and pages through them with a keyset cursor", async () => {
    const deps = depsOver(store);
    const create = new CreateTenant(deps, 168);
    const accept = new AcceptInvite(deps);
    const joined: string[] = [];
    for (const slug of ["one", "two", "three"]) {
      const created = await create.execute({ name: slug, slug, caller: caller("platform-1") });
      await accept.execute({ code: created.adminInvite.code, caller: caller("user-1") });
      joined.push(created.tenant.id);
    }
    const list = new ListMyOrganizations(store);

    const first = await list.execute({ userId: "user-1", limit: 2 });
    const second = await list.execute({ userId: "user-1", limit: 2, cursor: first.nextCursor ?? undefined });

    expect([...first.items, ...second.items].map((item) => item.tenantId)).toEqual(joined);
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(second.nextCursor).toBeNull();
    expect(first.items.every((item) => item.role === "tenant-admin")).toBe(true);
    expect(first.identityPending).toBe(true);
    expect((await list.execute({ userId: "nobody" })).items).toEqual([]);
  });

  it("answers a share join and an invite of the same user for the same tenant at the same moment with one membership", async () => {
    const deps = depsOver(store);
    const created = await new CreateTenant(deps, 168).execute({ name: "One", slug: "one", caller: caller("platform-1") });
    await new AcceptInvite(deps).execute({ code: created.adminInvite.code, caller: caller("owner-1") });
    const invite = await new CreateInvite(deps).execute({ tenantId: created.tenant.id, role: "tenant-admin", maxUses: 3, expiresInHours: 24, caller: caller("owner-1") });
    const markets = new FakeMarkets();
    markets.links.set(shareToken(1), { linkType: "everyone", tenantId: created.tenant.id, marketId: "018f3c1e-7a00-7000-8000-0000000000bb" });

    const results = await Promise.all([
      new ShareJoin(deps, markets).execute({ token: shareToken(1), email: null, emailVerified: false, caller: caller("visitor-1", 1) }),
      new AcceptInvite(deps).execute({ code: invite.code, caller: caller("visitor-1", 2) }),
    ]);

    // Whoever wins decides the role; the other answers with that membership.
    expect(results[0].role).toBe(results[1].role);
    expect((await pool.query("SELECT 1 FROM shared.memberships WHERE user_id = 'visitor-1'")).rowCount).toBe(1);
    expect((await pool.query("SELECT 1 FROM shared.outbox WHERE type LIKE '%MemberJoined%' AND aggregate_id = 'visitor-1'")).rowCount).toBe(1);
  });

  it("answers crafted cursors with a validation error, not with a database error, on both lists", async () => {
    const deps = depsOver(store);
    const { tenant } = await new CreateTenant(deps, 168).execute({ name: "Acme", slug: "acme", caller: caller("platform-1") });
    const craft = (content: unknown) => Buffer.from(JSON.stringify(content), "utf8").toString("base64url");
    const at = "2026-11-01T10:00:00.000Z";
    const tenants = new ListTenants(store);
    const members = new ListMembers(store);

    for (const content of [{ a: at, k: "not-a-uuid" }, { a: "+275760-09-13T00:00:00.000Z", k: T1 }, { a: "-000001-01-01T00:00:00.000Z", k: T1 }, { a: at, k: `${T1}\u0000` }]) {
      await expect(tenants.execute({ cursor: craft(content) }), JSON.stringify(content)).rejects.toMatchObject({ kind: "validation", fields: [{ field: "cursor" }] });
    }
    for (const content of [{ a: at, k: "a\u0000b" }, { a: at, k: "" }, { a: at, k: "x".repeat(256) }, { a: "+275760-09-13T00:00:00.000Z", k: "user-1" }]) {
      await expect(members.execute({ tenantId: tenant.id, cursor: craft(content) }), JSON.stringify(content)).rejects.toMatchObject({ kind: "validation", fields: [{ field: "cursor" }] });
    }
    // Cursors of the right shape reach the database and work.
    await expect(tenants.execute({ cursor: craft({ a: "2026-11-01T09:00:00.000Z", k: T1 }) })).resolves.toMatchObject({
      items: [expect.objectContaining({ slug: "acme" })],
    });
    await expect(tenants.execute({ cursor: craft({ a: at, k: T1 }) })).resolves.toMatchObject({ items: [] });
    await expect(members.execute({ tenantId: tenant.id, cursor: craft({ a: at, k: "a.user@example.com" }) })).resolves.toMatchObject({ items: [] });
  });

  it("refuses a tenant name with a control character before the database sees it", async () => {
    const deps = depsOver(store);

    await expect(new CreateTenant(deps, 168).execute({ name: "Acme\u0000Ltd", slug: "acme", caller: caller("platform-1") })).rejects.toMatchObject({
      kind: "validation",
      fields: [{ field: "name" }],
    });

    expect((await pool.query("SELECT 1 FROM shared.tenants")).rowCount).toBe(0);
    expect((await pool.query("SELECT 1 FROM shared.identity_sync")).rowCount).toBe(0);
  });

  it("pages through tenants with a keyset cursor", async () => {
    const deps = depsOver(store);
    const create = new CreateTenant(deps, 168);
    for (const slug of ["alpha", "bravo", "charlie", "delta", "echo"]) {
      (deps.clock as TestClock).tick();
      await create.execute({ name: slug, slug, caller: caller("platform-1") });
    }
    const list = new ListTenants(store);
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await list.execute({ limit: 2, cursor });
      seen.push(...page.items.map((tenant) => tenant.slug));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toEqual(["alpha", "bravo", "charlie", "delta", "echo"]);
  });
});
