import type { InviteCode } from "../../domain/invite.js";
import type { Membership } from "../../domain/membership.js";
import type { Role } from "../../domain/role.js";
import type { Tenant } from "../../domain/tenant.js";
import { Conflict, NotFound } from "../../usecases/errors.js";
import type { IdentitySyncItem, IdentitySyncKind, Keyset, OutboxRow, Repositories, Store } from "../../usecases/ports.js";
import { alreadyMember, identitySyncKey } from "../../usecases/support.js";

/** A row of the identity-sync queue, as the PostgreSQL table shared.identity_sync holds it. */
export interface IdentitySyncRow {
  key: string;
  kind: IdentitySyncKind;
  target: string;
  version: number;
  /** The item may be tried from this time on (the enqueue time, or the retry time after a failure). */
  dueAt: Date;
  /** An instance works on the item until this time; null when nobody does. An enqueue leaves it alone. */
  leaseUntil: Date | null;
  attempts: number;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface State {
  tenants: Tenant[];
  memberships: Membership[];
  invites: InviteCode[];
  outbox: OutboxRow[];
  identitySync: IdentitySyncRow[];
}

const emptyState = (): State => ({ tenants: [], memberships: [], invites: [], outbox: [], identitySync: [] });

function after(at: Date, key: string, position: Keyset | null): boolean {
  if (!position) return true;
  return at.getTime() > position.at.getTime() || (at.getTime() === position.at.getTime() && key > position.key);
}

function byPosition<T>(rows: T[], positionOf: (row: T) => Keyset): T[] {
  return [...rows].sort((a, b) => {
    const left = positionOf(a);
    const right = positionOf(b);
    return left.at.getTime() - right.at.getTime() || (left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
  });
}

/**
 * `nextVersion` is the counter of all identity-sync versions: like the database sequence it lives outside the data of
 * a transaction, so a rolled-back enqueue also uses up a number and a number is never issued twice.
 */
function repositoriesOver(state: () => State, nextVersion: () => number): Repositories {
  return {
    tenants: {
      insert(tenant) {
        if (state().tenants.some((existing) => existing.slug === tenant.slug)) {
          return Promise.reject(new Conflict("slug_taken", `The slug "${tenant.slug}" is already taken`));
        }
        state().tenants.push(tenant);
        return Promise.resolve();
      },
      // Transactions run one by one, so a lock needs no extra work.
      findById: (id) => Promise.resolve(state().tenants.find((tenant) => tenant.id === id) ?? null),
      findBySlug: (slug) => Promise.resolve(state().tenants.find((tenant) => tenant.slug === slug) ?? null),
      list: (limit, position) =>
        Promise.resolve(
          byPosition(state().tenants, (tenant) => ({ at: tenant.createdAt, key: tenant.id }))
            .filter((tenant) => after(tenant.createdAt, tenant.id, position))
            .slice(0, limit),
        ),
    },
    memberships: {
      find: (tenantId, userId) =>
        Promise.resolve(state().memberships.find((m) => m.tenantId === tenantId && m.userId === userId) ?? null),
      listByUser: (userId, limit, position) =>
        Promise.resolve(
          byPosition(
            state()
              .memberships.filter((m) => m.userId === userId)
              .flatMap((membership) => {
                const tenant = state().tenants.find((candidate) => candidate.id === membership.tenantId);
                return tenant ? [{ membership, tenant }] : [];
              }),
            (row) => ({ at: row.membership.joinedAt, key: row.tenant.id }),
          )
            .filter((row) => after(row.membership.joinedAt, row.tenant.id, position))
            .slice(0, limit),
        ),
      insert(membership) {
        // One membership per user and tenant, like the primary key of the table; a user may belong to several tenants.
        if (state().memberships.some((m) => m.tenantId === membership.tenantId && m.userId === membership.userId)) {
          return Promise.reject(alreadyMember());
        }
        state().memberships.push(membership);
        return Promise.resolve();
      },
      updateRole(tenantId, userId, role: Role, at) {
        const rows = state().memberships;
        const index = rows.findIndex((m) => m.tenantId === tenantId && m.userId === userId);
        const current = rows[index];
        if (!current) return Promise.reject(new NotFound("member_not_found", "Member not found"));
        const updated: Membership = { ...current, role, updatedAt: at };
        rows[index] = updated;
        return Promise.resolve(updated);
      },
      list: (tenantId, limit, position) =>
        Promise.resolve(
          byPosition(
            state().memberships.filter((m) => m.tenantId === tenantId),
            (m) => ({ at: m.joinedAt, key: m.userId }),
          )
            .filter((m) => after(m.joinedAt, m.userId, position))
            .slice(0, limit),
        ),
      countAdmins: (tenantId) =>
        Promise.resolve(state().memberships.filter((m) => m.tenantId === tenantId && m.role === "tenant-admin").length),
    },
    invites: {
      insert(invite) {
        if (state().invites.some((existing) => existing.codeHash === invite.codeHash)) {
          return Promise.reject(new Conflict("invite_exists", "The invite code already exists"));
        }
        state().invites.push(invite);
        return Promise.resolve();
      },
      findByHash: (codeHash) => Promise.resolve(state().invites.find((invite) => invite.codeHash === codeHash) ?? null),
      incrementUses(codeHash) {
        const rows = state().invites;
        const index = rows.findIndex((invite) => invite.codeHash === codeHash);
        const current = rows[index];
        if (!current) return Promise.reject(new NotFound("invite_not_found", "Invite not found"));
        // A check constraint (uses <= max_uses) is the last guard in the database; the memory store mirrors it.
        if (current.uses >= current.maxUses) return Promise.reject(new Error("invite uses would exceed max_uses"));
        rows[index] = { ...current, uses: current.uses + 1 };
        return Promise.resolve();
      },
    },
    identitySync: {
      enqueue(kind, target, now) {
        const key = identitySyncKey(kind, target);
        const rows = state().identitySync;
        const index = rows.findIndex((row) => row.key === key);
        const current = rows[index];
        rows[index === -1 ? rows.length : index] = current
          ? { ...current, version: nextVersion(), dueAt: now, attempts: 0, lastError: null, updatedAt: now }
          : { key, kind, target, version: nextVersion(), dueAt: now, leaseUntil: null, attempts: 0, lastError: null, createdAt: now, updatedAt: now };
        return Promise.resolve();
      },
    },
    outbox: {
      add(message) {
        state().outbox.push({ ...message, publishedAt: null, attempts: 0, lastError: null });
        return Promise.resolve();
      },
      claimBatch: (limit) =>
        Promise.resolve(
          state()
            .outbox.filter((row) => row.publishedAt === null)
            .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
            .slice(0, limit)
            .map((row) => ({ ...row })),
        ),
      markPublished(id, at) {
        const row = state().outbox.find((candidate) => candidate.id === id);
        if (row) row.publishedAt = at;
        return Promise.resolve();
      },
      markFailed(id, error) {
        const row = state().outbox.find((candidate) => candidate.id === id);
        if (row) {
          row.attempts += 1;
          row.lastError = error;
        }
        return Promise.resolve();
      },
      purgePublished(olderThan) {
        const rows = state().outbox;
        const kept = rows.filter((row) => row.publishedAt === null || row.publishedAt.getTime() >= olderThan.getTime());
        const purged = rows.length - kept.length;
        rows.splice(0, rows.length, ...kept);
        return Promise.resolve(purged);
      },
    },
  };
}

/**
 * In-memory store for unit tests and for local runs without a database. A transaction works on a copy of the
 * data and replaces it on success, so a failed transaction leaves nothing behind; transactions run one by one.
 */
export class MemoryStore implements Store {
  private state: State = emptyState();
  private queue: Promise<unknown> = Promise.resolve();
  private versions = 0;
  private readonly nextVersion = (): number => (this.versions += 1);
  readonly repositories: Repositories = repositoriesOver(() => this.state, this.nextVersion);

  transaction<T>(work: (repositories: Repositories) => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const draft = structuredClone(this.state);
      const result = await work(repositoriesOver(() => draft, this.nextVersion));
      this.state = draft;
      return result;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  ping(): Promise<void> {
    return Promise.resolve();
  }

  // The queue methods run on the same line as the transactions, so they never see a half-written draft and a
  // transaction never overwrites their changes.

  claimIdentitySync(limit: number, leaseUntil: Date, now: Date): Promise<IdentitySyncItem[]> {
    return this.exclusive(() => {
      const due = this.state.identitySync
        .filter((row) => row.dueAt.getTime() <= now.getTime() && (row.leaseUntil === null || row.leaseUntil.getTime() <= now.getTime()))
        .sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime() || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
        .slice(0, limit);
      for (const row of due) row.leaseUntil = leaseUntil;
      return due.map((row) => ({ key: row.key, kind: row.kind, target: row.target, version: row.version, attempts: row.attempts }));
    });
  }

  completeIdentitySync(key: string, version: number): Promise<void> {
    return this.exclusive(() => {
      const row = this.state.identitySync.find((candidate) => candidate.key === key);
      if (!row) return;
      // A newer version keeps the row, and its lease ends, so that the next poll takes the newer version up.
      if (row.version === version) this.state.identitySync = this.state.identitySync.filter((candidate) => candidate !== row);
      else row.leaseUntil = null;
    });
  }

  failIdentitySync(key: string, version: number, error: string, retryAt: Date): Promise<void> {
    return this.exclusive(() => {
      const row = this.state.identitySync.find((candidate) => candidate.key === key);
      if (!row) return;
      // Only the claimed version counts the failure; a row of another version just loses its lease.
      if (row.version === version) {
        row.attempts += 1;
        row.lastError = error;
        row.dueAt = retryAt;
      }
      row.leaseUntil = null;
    });
  }

  isIdentitySyncPending(key: string): Promise<boolean> {
    return this.exclusive(() => this.state.identitySync.some((row) => row.key === key));
  }

  private exclusive<T>(work: () => T): Promise<T> {
    const run = this.queue.then(work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** A deep copy of everything stored, for assertions in tests. */
  snapshot(): State {
    return structuredClone(this.state);
  }
}
