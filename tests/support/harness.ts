import { Writable } from "node:stream";
import type { JWTVerifyGetKey } from "jose";
import { IdentitySyncWorker } from "../../src/adapters/identity-sync/worker.js";
import { FakeIdentityProvider } from "../../src/adapters/memory/fake-identity-provider.js";
import { MemoryEventPublisher } from "../../src/adapters/memory/memory-publisher.js";
import { MemoryStore } from "../../src/adapters/memory/memory-store.js";
import { createLogger } from "../../src/logger.js";
import { AcceptInvite } from "../../src/usecases/accept-invite.js";
import { ChangeMemberRole } from "../../src/usecases/change-member-role.js";
import { CreateInvite } from "../../src/usecases/create-invite.js";
import { CreateTenant } from "../../src/usecases/create-tenant.js";
import { GetMe } from "../../src/usecases/get-me.js";
import { ListMembers } from "../../src/usecases/list-members.js";
import { ListMyOrganizations } from "../../src/usecases/list-my-organizations.js";
import { ListTenants } from "../../src/usecases/list-tenants.js";
import { ShareJoin } from "../../src/usecases/share-join.js";
import { FakeMarkets } from "./fake-markets.js";
import type { Caller, Clock, IdGenerator, Logger, Store, UseCaseDeps } from "../../src/usecases/ports.js";
import { ReconcileIdentity } from "../../src/usecases/reconcile-identity.js";
import { buildApp } from "../../src/web/app.js";
import type { WebDeps } from "../../src/web/app.js";
import { AUDIENCE, ISSUER, createTestKeys } from "./tokens.js";

export class TestClock implements Clock {
  constructor(private current = new Date("2026-11-01T10:00:00.000Z")) {}
  now(): Date {
    return new Date(this.current);
  }
  advanceHours(hours: number): void {
    this.advanceMs(hours * 3_600_000);
  }
  advanceMs(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
  /** Moves forward by a millisecond so that rows written one after another sort in a known order. */
  tick(): void {
    this.current = new Date(this.current.getTime() + 1);
  }
}

/** Ids that are valid UUIDs and predictable: ...0001, ...0002 */
export class SequentialIds implements IdGenerator {
  private counter = 0;
  private codes = 0;
  newId(): string {
    this.counter += 1;
    return `00000000-0000-7000-8000-${String(this.counter).padStart(12, "0")}`;
  }
  newInviteCode(): string {
    this.codes += 1;
    return `invite-code-${String(this.codes).padStart(8, "0")}`;
  }
}

export class RecordingLogger implements Logger {
  readonly lines: Array<{ level: string; fields: object; message: string | undefined }> = [];
  info(fields: object, message?: string): void {
    this.lines.push({ level: "info", fields, message });
  }
  warn(fields: object, message?: string): void {
    this.lines.push({ level: "warn", fields, message });
  }
  error(fields: object, message?: string): void {
    this.lines.push({ level: "error", fields, message });
  }
}

/** A store whose transactions do all their work and then fail, so the real rollback of the store is exercised. */
export function storeFailingAtCommit(store: MemoryStore, message = "database is down"): Store {
  return {
    repositories: store.repositories,
    transaction: (work) =>
      store.transaction(async (repositories) => {
        await work(repositories);
        throw new Error(message);
      }),
    ping: () => store.ping(),
    claimIdentitySync: (limit, leaseUntil, now) => store.claimIdentitySync(limit, leaseUntil, now),
    completeIdentitySync: (key, version) => store.completeIdentitySync(key, version),
    failIdentitySync: (key, version, error, retryAt) => store.failIdentitySync(key, version, error, retryAt),
    isIdentitySyncPending: (key) => store.isIdentitySyncPending(key),
  };
}

/**
 * A store whose transactions start only after `until` has resolved, like a request that waits for its turn behind
 * another transaction (a row lock). What the use case reads from the clock before and after that wait differs.
 */
export function storeWaitingBeforeTransactions(store: MemoryStore, until: Promise<void>): Store {
  return {
    repositories: store.repositories,
    transaction: async (work) => {
      await until;
      return store.transaction(work);
    },
    ping: () => store.ping(),
    claimIdentitySync: (limit, leaseUntil, now) => store.claimIdentitySync(limit, leaseUntil, now),
    completeIdentitySync: (key, version) => store.completeIdentitySync(key, version),
    failIdentitySync: (key, version, error, retryAt) => store.failIdentitySync(key, version, error, retryAt),
    isIdentitySyncPending: (key) => store.isIdentitySyncPending(key),
  };
}

export const caller = (userId = "admin-1", n = 1): Caller => ({
  userId,
  correlationId: `corr-${n}`,
  causationId: `req-${n}`,
});

/** Use cases over in-memory adapters; the fake identity provider belongs to the reconciler and its worker only. */
export function createCore() {
  const store = new MemoryStore();
  const identity = new FakeIdentityProvider();
  const clock = new TestClock();
  const ids = new SequentialIds();
  const logger = new RecordingLogger();
  const deps: UseCaseDeps = { store, clock, ids, logger };
  const markets = new FakeMarkets();
  const useCases = {
    createTenant: new CreateTenant(deps, 168),
    listTenants: new ListTenants(store),
    getMe: new GetMe(store),
    listMyOrganizations: new ListMyOrganizations(store),
    shareJoin: new ShareJoin(deps, markets),
    createInvite: new CreateInvite(deps),
    listMembers: new ListMembers(store),
    changeMemberRole: new ChangeMemberRole(deps),
    acceptInvite: new AcceptInvite(deps),
  };
  const reconcile = new ReconcileIdentity({ store, identity });
  // Tests run the worker poll by poll (runOnce); its loop is only started where a test is about the loop.
  const identitySync = new IdentitySyncWorker({ store, reconcile, clock, logger, pollMs: 5 });
  return { store, identity, clock, ids, logger, deps, useCases, reconcile, identitySync, markets };
}

/** The whole web application over the core above, with real JWT verification against a local key. */
export async function createHarness(options: { metrics?: WebDeps["metrics"] } = {}) {
  const core = createCore();
  const keys = await createTestKeys();
  const logLines: string[] = [];
  // The key resolver can be made to fail like a JWKS download that does not work (see failKeys).
  let keyFailure: unknown = null;
  const getKey: JWTVerifyGetKey = async (header, token) => {
    // Tests also reject with things that are no Error (a string), as a misbehaving key resolver could.
    if (keyFailure !== null) throw keyFailure as Error;
    return await keys.getKey(header, token);
  };
  let draining = false;
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      logLines.push(chunk.toString("utf8"));
      callback();
    },
  });
  const app = buildApp({
    logger: createLogger("info", sink),
    useCases: core.useCases,
    auth: { issuer: ISSUER, audience: AUDIENCE, getKey, rolesClaim: "realm_access.roles", tenantClaim: "organization" },
    health: { ping: () => core.store.ping(), isDraining: () => draining },
    metrics: options.metrics,
  });
  await app.ready();

  /** Authorization header for a token with the given claims. */
  async function bearer(options?: Parameters<typeof keys.sign>[0]) {
    return { authorization: `Bearer ${await keys.sign(options)}` };
  }

  /** From now on the key resolver rejects with this error; null makes it work again. */
  const failKeys = (error: unknown): void => {
    keyFailure = error;
  };
  /** Pretends the process got SIGTERM and is in the drain delay (or is running again). */
  const setDraining = (value: boolean): void => {
    draining = value;
  };

  const publisher = new MemoryEventPublisher();
  return { ...core, app, keys, bearer, logLines, publisher, failKeys, setDraining };
}
