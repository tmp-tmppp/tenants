import type { Role } from "./role.js";

// Integration events as CloudEvents 1.0 (structured JSON). The shape is the contract in contracts/asyncapi.yaml.
export const EVENT_SOURCE = "/chance/tenants";
export const SUBJECT_PREFIX = "chance.tenants";

export type EventName = "TenantCreated" | "MemberJoined" | "MemberRoleChanged";

export interface CloudEvent<TData> {
  specversion: "1.0";
  id: string;
  source: typeof EVENT_SOURCE;
  type: string;
  subject: string;
  time: string;
  datacontenttype: "application/json";
  tenantid: string;
  correlationid: string;
  causationid: string;
  data: TData;
}

/** What the use case knows about the event it is writing. */
export interface EventContext {
  eventId: string;
  now: Date;
  correlationId: string;
  causationId: string;
}

export interface TenantCreatedData {
  tenantId: string;
  name: string;
  slug: string;
  createdAt: string;
}

/** How a user joined a tenant. */
export type JoinedVia = "invite" | "share_link";

export interface MemberJoinedData {
  tenantId: string;
  userId: string;
  role: Role;
  joinedAt: string;
  /** Optional in the contract: absent in older events. */
  via?: JoinedVia;
  /** The market whose share link was used; only with via "share_link". */
  marketId?: string;
}

export interface MemberRoleChangedData {
  tenantId: string;
  userId: string;
  oldRole: Role;
  newRole: Role;
  changedBy: string;
  changedAt: string;
}

export function eventType(name: EventName): string {
  return `si.chance.tenants.${name}.v1`;
}

/** NATS subject of an event: chance.tenants.<Event>.<tenantId>. */
export function natsSubject(name: EventName, tenantId: string): string {
  return `${SUBJECT_PREFIX}.${name}.${tenantId}`;
}

function envelope<TData>(
  name: EventName,
  subject: string,
  tenantId: string,
  ctx: EventContext,
  data: TData,
): CloudEvent<TData> {
  return {
    specversion: "1.0",
    id: ctx.eventId,
    source: EVENT_SOURCE,
    type: eventType(name),
    subject,
    time: ctx.now.toISOString(),
    datacontenttype: "application/json",
    tenantid: tenantId,
    correlationid: ctx.correlationId,
    causationid: ctx.causationId,
    data,
  };
}

export function tenantCreatedEvent(
  tenant: { id: string; name: string; slug: string; createdAt: Date },
  ctx: EventContext,
): CloudEvent<TenantCreatedData> {
  return envelope("TenantCreated", `tenant/${tenant.id}`, tenant.id, ctx, {
    tenantId: tenant.id,
    name: tenant.name,
    slug: tenant.slug,
    createdAt: tenant.createdAt.toISOString(),
  });
}

export function memberJoinedEvent(
  membership: { tenantId: string; userId: string; role: Role; joinedAt: Date },
  ctx: EventContext,
  how: { via: JoinedVia; marketId?: string } | null = null,
): CloudEvent<MemberJoinedData> {
  return envelope("MemberJoined", `member/${membership.userId}`, membership.tenantId, ctx, {
    tenantId: membership.tenantId,
    userId: membership.userId,
    role: membership.role,
    joinedAt: membership.joinedAt.toISOString(),
    ...(how ? { via: how.via } : {}),
    ...(how?.marketId !== undefined ? { marketId: how.marketId } : {}),
  });
}

export function memberRoleChangedEvent(
  change: { tenantId: string; userId: string; oldRole: Role; newRole: Role; changedBy: string; changedAt: Date },
  ctx: EventContext,
): CloudEvent<MemberRoleChangedData> {
  return envelope("MemberRoleChanged", `member/${change.userId}`, change.tenantId, ctx, {
    tenantId: change.tenantId,
    userId: change.userId,
    oldRole: change.oldRole,
    newRole: change.newRole,
    changedBy: change.changedBy,
    changedAt: change.changedAt.toISOString(),
  });
}
