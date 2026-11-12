import type { CloudEvent } from "../domain/events.js";
import type { InviteCode } from "../domain/invite.js";
import type { Membership } from "../domain/membership.js";
import type { Role } from "../domain/role.js";
import type { Tenant } from "../domain/tenant.js";

// Ports: everything a use case needs from the outside world. Adapters implement them (ADR-001).

/** Who is acting and which request it is, for the events a use case writes. */
export interface Caller {
  userId: string;
  correlationId: string;
  /** The id of the request that caused the work; it becomes "causationid" of the events. */
  causationId: string;
}

/** A position in a list ordered by (at, key); the list continues after it. */
export interface Keyset {
  at: Date;
  key: string;
}

export interface TenantRepository {
  /** Throws Conflict("slug_taken") when the slug exists. */
  insert(tenant: Tenant): Promise<void>;
  /** With lock, the row stays locked until the end of the transaction (SELECT ... FOR UPDATE): a mutex per tenant. */
  findById(id: string, options?: { lock: boolean }): Promise<Tenant | null>;
  findBySlug(slug: string): Promise<Tenant | null>;
  /** Oldest first, ordered by (createdAt, id). */
  list(limit: number, after: Keyset | null): Promise<Tenant[]>;
}

/** A membership of a user together with the tenant it belongs to. */
export interface UserOrganization {
  membership: Membership;
  tenant: Tenant;
}

export interface MembershipRepository {
  find(tenantId: string, userId: string): Promise<Membership | null>;
  /**
   * The memberships of a user with their tenants, oldest first, ordered by (joinedAt, tenantId): a user may belong to
   * several tenants, one membership each.
   */
  listByUser(userId: string, limit: number, after: Keyset | null): Promise<UserOrganization[]>;
  /** Throws Conflict("already_member") when the user already belongs to this tenant (one membership per user and tenant). */
  insert(membership: Membership): Promise<void>;
  updateRole(tenantId: string, userId: string, role: Role, at: Date): Promise<Membership>;
  /** Ordered by (joinedAt, userId). */
  list(tenantId: string, limit: number, after: Keyset | null): Promise<Membership[]>;
  countAdmins(tenantId: string): Promise<number>;
}

export interface InviteRepository {
  insert(invite: InviteCode): Promise<void>;
  /** With lock, the row stays locked until the end of the transaction (SELECT ... FOR UPDATE). */
  findByHash(codeHash: string, options?: { lock: boolean }): Promise<InviteCode | null>;
  incrementUses(codeHash: string): Promise<void>;
}

export interface OutboxMessage {
  /** Equals the id of the event; it is also the deduplication id on the broker. */
  id: string;
  aggregateId: string;
  /** NATS subject. */
  subject: string;
  type: string;
  /** The whole CloudEvent. */
  payload: CloudEvent<unknown>;
  createdAt: Date;
}

export interface OutboxRow extends OutboxMessage {
  publishedAt: Date | null;
  attempts: number;
  lastError: string | null;
}

export interface OutboxRepository {
  add(message: OutboxMessage): Promise<void>;
  /**
   * Unpublished rows, oldest first, locked for this transaction. Only one instance publishes at a time, so that the
   * events of a tenant keep their order with several replicas: the claim takes a lock that is held until the end of
   * the transaction, and returns no rows when another transaction holds it. Call it inside a transaction.
   */
  claimBatch(limit: number): Promise<OutboxRow[]>;
  markPublished(id: string, at: Date): Promise<void>;
  markFailed(id: string, error: string): Promise<void>;
  /** Deletes the rows published before `olderThan`; unpublished rows stay however old they are. Returns how many went. */
  purgePublished(olderThan: Date): Promise<number>;
}

export type IdentitySyncKind = "tenant" | "member";

/** A thing the identity provider has to be made to match: an organization, or a user's memberships and roles. */
export interface IdentitySyncItem {
  /** "tenant/<tenantId>" or "member/<userId>" (one item per user: it reconciles all of the user's memberships). */
  key: string;
  kind: IdentitySyncKind;
  /** The tenant id or the user id that the key names. */
  target: string;
  /**
   * Issued by one counter shared by all keys (a database sequence), so a version is never issued twice, also not
   * after the row was deleted and the key was queued again. Finishing or failing an item touches only the version
   * that was processed, so a late call of an old claim cannot hit a newer row.
   */
  version: number;
  /** Failed attempts so far; the backoff of the worker grows with it. */
  attempts: number;
}

export interface IdentitySyncRepository {
  /**
   * Queues the key for reconciliation, due at once, under a new version (higher than every version issued before).
   * A key that is already queued keeps its row but gets the new version, no failed attempts and no error, so a
   * change made while the previous version is being processed is never lost. A lease on the row stays as it is: the
   * new version is claimed only after the lease was released or has ended, never by a second instance at the same time.
   */
  enqueue(kind: IdentitySyncKind, target: string, now: Date): Promise<void>;
}

export interface Repositories {
  tenants: TenantRepository;
  memberships: MembershipRepository;
  invites: InviteRepository;
  outbox: OutboxRepository;
  identitySync: IdentitySyncRepository;
}

export interface Store {
  /** Repositories outside a transaction: each call is on its own. */
  readonly repositories: Repositories;
  /** Everything the callback does through the given repositories commits together or not at all. */
  transaction<T>(work: (repositories: Repositories) => Promise<T>): Promise<T>;
  /** Cheap check that the store answers (readiness). */
  ping(): Promise<void>;

  // The queue as the identity-sync worker uses it. Each call is on its own, outside a transaction.

  /**
   * Takes up to `limit` items that are due at `now` or earlier and not leased at `now` (no lease, or a lease that has
   * ended), oldest first, and leases them by setting their lease to `leaseUntil`, all in one statement: several
   * instances never get the same item. The due time is not moved. An enqueue does not touch the lease, so a change
   * that arrives while an item is leased does not make it claimable by a second instance. An item that is neither
   * completed nor failed becomes claimable again when its lease ends.
   */
  claimIdentitySync(limit: number, leaseUntil: Date, now: Date): Promise<IdentitySyncItem[]>;
  /**
   * Deletes the item if its version is still `version`. If the row has a newer version (a change arrived while the
   * item was processed), the row stays and its lease is cleared, so that the next poll picks the newer version up.
   */
  completeIdentitySync(key: string, version: number): Promise<void>;
  /**
   * Counts a failed attempt, keeps the error and makes the item due at `retryAt`, if its version is still `version`;
   * the lease is cleared. For a row of another version only the lease is cleared.
   */
  failIdentitySync(key: string, version: number, error: string, retryAt: Date): Promise<void>;
  /** True while the key is queued: the identity provider may not match the database yet. */
  isIdentitySyncPending(key: string): Promise<boolean>;
}

/**
 * The identity provider holds the tenant claim and the roles of the tokens. Only the reconciler calls it, never a
 * request. Every method is idempotent, so a repeated call is safe. A failure is reported as
 * IdentityProviderUnavailable (worth retrying soon) or IdentityProviderRejected (the provider answered and
 * refused: retrying helps only after someone fixes the cause).
 */
export interface IdentityProvider {
  /** Makes sure the organization exists and holds its two groups "tenant-admin" and "trader". */
  ensureOrganization(tenantId: string, name: string): Promise<void>;
  addMember(tenantId: string, userId: string): Promise<void>;
  /**
   * Puts the user in exactly one of the two role groups of this organization (token contract v2: the tenant role is the
   * group in the token's organization claim); the user's groups in other organizations and the realm roles stay as they
   * are. The user has to be a member of the organization.
   */
  setRole(tenantId: string, userId: string, role: Role): Promise<void>;
}

/** What markets says about a share link and a caller (contracts/markets-admission.openapi.yaml). */
export type ShareLinkType = "members" | "profiles" | "everyone";

export interface ShareAdmissionRequest {
  /** The share-link token: a secret, never logged and never put in a URL. */
  token: string;
  userEmail: string | null;
  emailVerified: boolean;
}

export type ShareAdmissionOutcome =
  | {
      kind: "answered";
      decision: "join" | "members_only" | "denied";
      linkType: ShareLinkType;
      tenantId: string;
      marketId: string;
    }
  /** No valid link has this token. */
  | { kind: "not_found" }
  /** Markets could not be asked, or its answer is not the agreed one: nothing is known, nothing was changed. */
  | { kind: "unavailable"; reason: string };

/** Markets' admission check for share links. It never throws: failures are outcomes. */
export interface ShareAdmission {
  admit(request: ShareAdmissionRequest, signal?: AbortSignal): Promise<ShareAdmissionOutcome>;
}

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  /** A UUIDv7. */
  newId(): string;
  /** An invite code from at least 16 random bytes, base64url. */
  newInviteCode(): string;
}

/** Publishes one event to the broker; used by the outbox relay. */
export interface EventPublisher {
  publish(subject: string, event: CloudEvent<unknown>, messageId: string): Promise<void>;
}

export interface Logger {
  info(fields: object, message?: string): void;
  warn(fields: object, message?: string): void;
  error(fields: object, message?: string): void;
}

/** What the use cases of the requests need. The identity provider is not among them: requests never call it. */
export interface UseCaseDeps {
  store: Store;
  clock: Clock;
  ids: IdGenerator;
  logger: Logger;
}
