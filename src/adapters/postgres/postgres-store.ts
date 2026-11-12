import pg from "pg";
import type { InviteCode } from "../../domain/invite.js";
import type { Membership } from "../../domain/membership.js";
import type { Role } from "../../domain/role.js";
import type { Tenant, TenantStatus } from "../../domain/tenant.js";
import { Conflict, NotFound } from "../../usecases/errors.js";
import type { CloudEvent } from "../../domain/events.js";
import type { IdentitySyncItem, IdentitySyncKind, OutboxRow, Repositories, Store } from "../../usecases/ports.js";
import { alreadyMember, identitySyncKey } from "../../usecases/support.js";

type Queryable = Pick<pg.Pool, "query">;

const UNIQUE_VIOLATION = "23505";

// Key of the advisory lock that lets one outbox relay claim at a time. Advisory locks of a database share one key
// space; the migration lock (migrate.ts) is 726001, so this one is the next number.
export const OUTBOX_RELAY_LOCK_KEY = 726_002;

function isUniqueViolation(error: unknown, constraint?: string): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { code, constraint: name } = error as { code?: string; constraint?: string };
  return code === UNIQUE_VIOLATION && (constraint === undefined || name === constraint);
}

interface TenantRow {
  id: string;
  name: string;
  slug: string;
  status: TenantStatus;
  created_by: string;
  created_at: Date;
}

interface MembershipRow {
  tenant_id: string;
  user_id: string;
  role: Role;
  joined_at: Date;
  updated_at: Date;
}

interface InviteRow {
  code_hash: string;
  tenant_id: string;
  role: Role;
  max_uses: number;
  uses: number;
  expires_at: Date;
  created_by: string;
  created_at: Date;
}

interface OutboxDbRow {
  id: string;
  aggregate_id: string;
  subject: string;
  type: string;
  payload: CloudEvent<unknown>;
  created_at: Date;
  published_at: Date | null;
  attempts: number;
  last_error: string | null;
}

interface IdentitySyncRow {
  key: string;
  kind: IdentitySyncKind;
  target: string;
  /** bigint: the driver returns it as a string. */
  version: string;
  attempts: number;
}

const toIdentitySyncItem = (row: IdentitySyncRow): IdentitySyncItem => ({
  key: row.key,
  kind: row.kind,
  target: row.target,
  version: Number(row.version),
  attempts: row.attempts,
});

const toTenant = (row: TenantRow): Tenant => ({
  id: row.id,
  name: row.name,
  slug: row.slug,
  status: row.status,
  createdBy: row.created_by,
  createdAt: row.created_at,
});

const toMembership = (row: MembershipRow): Membership => ({
  tenantId: row.tenant_id,
  userId: row.user_id,
  role: row.role,
  joinedAt: row.joined_at,
  updatedAt: row.updated_at,
});

const toInvite = (row: InviteRow): InviteCode => ({
  codeHash: row.code_hash,
  tenantId: row.tenant_id,
  role: row.role,
  maxUses: row.max_uses,
  uses: row.uses,
  expiresAt: row.expires_at,
  createdBy: row.created_by,
  createdAt: row.created_at,
});

const toOutboxRow = (row: OutboxDbRow): OutboxRow => ({
  id: row.id,
  aggregateId: row.aggregate_id,
  subject: row.subject,
  type: row.type,
  payload: row.payload,
  createdAt: row.created_at,
  publishedAt: row.published_at,
  attempts: row.attempts,
  lastError: row.last_error,
});

/** The repositories over one connection (inside a transaction) or over the pool (each call on its own). */
export function repositoriesOver(db: Queryable): Repositories {
  return {
    tenants: {
      async insert(tenant) {
        try {
          await db.query(
            "INSERT INTO shared.tenants (id, name, slug, status, created_by, created_at) VALUES ($1, $2, $3, $4, $5, $6)",
            [tenant.id, tenant.name, tenant.slug, tenant.status, tenant.createdBy, tenant.createdAt],
          );
        } catch (error) {
          if (isUniqueViolation(error, "tenants_slug_key")) {
            throw new Conflict("slug_taken", `The slug "${tenant.slug}" is already taken`);
          }
          throw error;
        }
      },
      async findById(id, options) {
        // FOR UPDATE makes the row a mutex: another transaction that locks it waits until this one ends.
        const result = await db.query<TenantRow>(
          `SELECT * FROM shared.tenants WHERE id = $1${options?.lock ? " FOR UPDATE" : ""}`,
          [id],
        );
        return result.rows[0] ? toTenant(result.rows[0]) : null;
      },
      async findBySlug(slug) {
        const result = await db.query<TenantRow>("SELECT * FROM shared.tenants WHERE slug = $1", [slug]);
        return result.rows[0] ? toTenant(result.rows[0]) : null;
      },
      async list(limit, after) {
        const result = await db.query<TenantRow>(
          `SELECT * FROM shared.tenants
            WHERE ($1::timestamptz IS NULL OR (created_at, id) > ($1::timestamptz, $2::uuid))
            ORDER BY created_at, id
            LIMIT $3`,
          [after?.at ?? null, after?.key ?? null, limit],
        );
        return result.rows.map(toTenant);
      },
    },
    memberships: {
      async find(tenantId, userId) {
        const result = await db.query<MembershipRow>(
          "SELECT * FROM shared.memberships WHERE tenant_id = $1 AND user_id = $2",
          [tenantId, userId],
        );
        return result.rows[0] ? toMembership(result.rows[0]) : null;
      },
      async listByUser(userId, limit, after) {
        // The join gives the tenant of each membership; the order and the cursor are (joined_at, tenant_id).
        const result = await db.query<MembershipRow & { t_id: string; t_name: string; t_slug: string; t_status: TenantStatus; t_created_by: string; t_created_at: Date }>(
          `SELECT m.tenant_id, m.user_id, m.role, m.joined_at, m.updated_at,
                  t.id AS t_id, t.name AS t_name, t.slug AS t_slug, t.status AS t_status, t.created_by AS t_created_by, t.created_at AS t_created_at
             FROM shared.memberships m
             JOIN shared.tenants t ON t.id = m.tenant_id
            WHERE m.user_id = $1 AND ($2::timestamptz IS NULL OR (m.joined_at, m.tenant_id) > ($2::timestamptz, $3::uuid))
            ORDER BY m.joined_at, m.tenant_id
            LIMIT $4`,
          [userId, after?.at ?? null, after?.key ?? null, limit],
        );
        return result.rows.map((row) => ({
          membership: toMembership(row),
          tenant: toTenant({ id: row.t_id, name: row.t_name, slug: row.t_slug, status: row.t_status, created_by: row.t_created_by, created_at: row.t_created_at }),
        }));
      },
      async insert(membership) {
        try {
          await db.query(
            "INSERT INTO shared.memberships (tenant_id, user_id, role, joined_at, updated_at) VALUES ($1, $2, $3, $4, $5)",
            [membership.tenantId, membership.userId, membership.role, membership.joinedAt, membership.updatedAt],
          );
        } catch (error) {
          // The primary key (tenant_id, user_id): one membership per user and tenant.
          if (isUniqueViolation(error)) throw alreadyMember();
          throw error;
        }
      },
      async updateRole(tenantId, userId, role, at) {
        const result = await db.query<MembershipRow>(
          "UPDATE shared.memberships SET role = $3, updated_at = $4 WHERE tenant_id = $1 AND user_id = $2 RETURNING *",
          [tenantId, userId, role, at],
        );
        if (!result.rows[0]) throw new NotFound("member_not_found", "Member not found");
        return toMembership(result.rows[0]);
      },
      async list(tenantId, limit, after) {
        const result = await db.query<MembershipRow>(
          `SELECT * FROM shared.memberships
            WHERE tenant_id = $1 AND ($2::timestamptz IS NULL OR (joined_at, user_id) > ($2::timestamptz, $3::text))
            ORDER BY joined_at, user_id
            LIMIT $4`,
          [tenantId, after?.at ?? null, after?.key ?? null, limit],
        );
        return result.rows.map(toMembership);
      },
      async countAdmins(tenantId) {
        const result = await db.query<{ admins: string }>(
          "SELECT count(*) AS admins FROM shared.memberships WHERE tenant_id = $1 AND role = 'tenant-admin'",
          [tenantId],
        );
        return Number(result.rows[0]?.admins ?? 0);
      },
    },
    invites: {
      async insert(invite) {
        await db.query(
          `INSERT INTO shared.invite_codes (code_hash, tenant_id, role, max_uses, uses, expires_at, created_by, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [invite.codeHash, invite.tenantId, invite.role, invite.maxUses, invite.uses, invite.expiresAt, invite.createdBy, invite.createdAt],
        );
      },
      async findByHash(codeHash, options) {
        const result = await db.query<InviteRow>(
          `SELECT * FROM shared.invite_codes WHERE code_hash = $1${options?.lock ? " FOR UPDATE" : ""}`,
          [codeHash],
        );
        return result.rows[0] ? toInvite(result.rows[0]) : null;
      },
      async incrementUses(codeHash) {
        await db.query("UPDATE shared.invite_codes SET uses = uses + 1 WHERE code_hash = $1", [codeHash]);
      },
    },
    outbox: {
      async add(message) {
        await db.query(
          `INSERT INTO shared.outbox (id, aggregate_id, subject, type, payload, created_at)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
          [message.id, message.aggregateId, message.subject, message.type, JSON.stringify(message.payload), message.createdAt],
        );
      },
      async claimBatch(limit) {
        // One relay at a time: the batches of the instances must not be published in parallel, or the events of a
        // tenant could arrive out of order. The lock belongs to the transaction (it ends with COMMIT or ROLLBACK,
        // also when the connection breaks), so a relay that crashes cannot keep it. Outside a transaction it would
        // be released at once; the relay always claims inside one.
        const lock = await db.query<{ locked: boolean }>("SELECT pg_try_advisory_xact_lock($1) AS locked", [OUTBOX_RELAY_LOCK_KEY]);
        if (lock.rows[0]?.locked !== true) return [];
        const result = await db.query<OutboxDbRow>(
          `SELECT * FROM shared.outbox
            WHERE published_at IS NULL
            ORDER BY created_at, id
            LIMIT $1
            FOR UPDATE SKIP LOCKED`,
          [limit],
        );
        return result.rows.map(toOutboxRow);
      },
      async markPublished(id, at) {
        await db.query("UPDATE shared.outbox SET published_at = $2 WHERE id = $1", [id, at]);
      },
      async markFailed(id, error) {
        await db.query("UPDATE shared.outbox SET attempts = attempts + 1, last_error = $2 WHERE id = $1", [id, error]);
      },
      async purgePublished(olderThan) {
        const result = await db.query("DELETE FROM shared.outbox WHERE published_at IS NOT NULL AND published_at < $1", [olderThan]);
        return result.rowCount ?? 0;
      },
    },
    identitySync: {
      async enqueue(kind, target, now) {
        // Every enqueue takes a new version from one sequence for all keys. A repeated enqueue of a queued key
        // therefore changes the version, so an item that is being processed is not finished by mistake (see
        // completeIdentitySync), and makes the item due at once with a clean slate. A lease on the row stays as it is:
        // the reconciler reads the rows and then writes the provider, and two of those at once for one key can leave
        // the wrong role, so the new version is claimed only after the lease was released or has ended. Because the
        // numbers are never reused, this also holds when the row was deleted meanwhile: a late completion of an old
        // claim finds no row with its version. The update takes its own nextval, after it has waited for a concurrent
        // enqueue of the same key, so the version of a row only grows.
        await db.query(
          `INSERT INTO shared.identity_sync (key, kind, target, version, due_at, attempts, last_error, created_at, updated_at)
           VALUES ($1, $2, $3, nextval('shared.identity_sync_version_seq'), $4, 0, NULL, $4, $4)
           ON CONFLICT (key) DO UPDATE
             SET version = nextval('shared.identity_sync_version_seq'),
                 due_at = EXCLUDED.due_at,
                 attempts = 0,
                 last_error = NULL,
                 updated_at = EXCLUDED.updated_at`,
          [identitySyncKey(kind, target), kind, target, now],
        );
      },
    },
  };
}

export class PostgresStore implements Store {
  readonly repositories: Repositories;

  constructor(private readonly pool: pg.Pool) {
    this.repositories = repositoriesOver(pool);
  }

  async transaction<T>(work: (repositories: Repositories) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(repositoriesOver(client));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async ping(): Promise<void> {
    await this.pool.query("SELECT 1");
  }

  async claimIdentitySync(limit: number, leaseUntil: Date, now: Date): Promise<IdentitySyncItem[]> {
    // One statement: the inner SELECT locks the rows that are due and not leased and skips rows another worker has
    // locked in the same moment, the UPDATE sets their lease. Two workers therefore never get the same item. The due
    // time is not moved, and an enqueue leaves the lease alone, so a leased row stays unclaimable until its lease ends
    // or the worker releases it (complete, fail).
    const result = await this.pool.query<IdentitySyncRow>(
      `UPDATE shared.identity_sync
          SET lease_until = $3
        WHERE key IN (SELECT key FROM shared.identity_sync
                       WHERE due_at <= $2 AND (lease_until IS NULL OR lease_until <= $2)
                       ORDER BY due_at, key
                       LIMIT $1
                       FOR UPDATE SKIP LOCKED)
       RETURNING key, kind, target, version, attempts`,
      [limit, now, leaseUntil],
    );
    return result.rows.map(toIdentitySyncItem);
  }

  async completeIdentitySync(key: string, version: number): Promise<void> {
    // Only the processed version is deleted: an enqueue that came meanwhile raised the version and keeps the row.
    // That row loses its lease in the same statement, so the next poll takes the newer version up at once instead of
    // after the rest of the lease. (A data-modifying CTE always runs; the UPDATE sees the table as before the DELETE,
    // which is why it selects the rows of the other versions.)
    await this.pool.query(
      `WITH removed AS (DELETE FROM shared.identity_sync WHERE key = $1 AND version = $2 RETURNING 1)
       UPDATE shared.identity_sync SET lease_until = NULL WHERE key = $1 AND version <> $2`,
      [key, version],
    );
  }

  async failIdentitySync(key: string, version: number, error: string, retryAt: Date): Promise<void> {
    // The claimed version counts the failure and waits for the retry time; a row of another version (a change came in
    // meanwhile) keeps its data and only loses the lease. Either way the lease ends.
    await this.pool.query(
      `UPDATE shared.identity_sync
          SET attempts = CASE WHEN version = $2 THEN attempts + 1 ELSE attempts END,
              last_error = CASE WHEN version = $2 THEN $3::text ELSE last_error END,
              due_at = CASE WHEN version = $2 THEN $4::timestamptz ELSE due_at END,
              lease_until = NULL
        WHERE key = $1`,
      [key, version, error, retryAt],
    );
  }

  async isIdentitySyncPending(key: string): Promise<boolean> {
    const result = await this.pool.query("SELECT 1 FROM shared.identity_sync WHERE key = $1", [key]);
    return (result.rowCount ?? 0) > 0;
  }
}

export function createPool(connectionString: string, max: number): pg.Pool {
  return new pg.Pool({ connectionString, max, connectionTimeoutMillis: 3000, idleTimeoutMillis: 30_000 });
}
