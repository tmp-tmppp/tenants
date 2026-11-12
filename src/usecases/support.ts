import { natsSubject } from "../domain/events.js";
import type { CloudEvent, EventContext, EventName } from "../domain/events.js";
import { Conflict, ValidationFailed } from "./errors.js";
import type { Caller, IdGenerator, IdentitySyncKind, Keyset, OutboxMessage } from "./ports.js";

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

export function eventContext(deps: { ids: IdGenerator }, caller: Caller, now: Date): EventContext {
  return { eventId: deps.ids.newId(), now, correlationId: caller.correlationId, causationId: caller.causationId };
}

export function outboxMessage(
  name: EventName,
  event: CloudEvent<unknown>,
  aggregateId: string,
  now: Date,
): OutboxMessage {
  return {
    id: event.id,
    aggregateId,
    subject: natsSubject(name, event.tenantid),
    type: event.type,
    payload: event,
    createdAt: now,
  };
}

/** The key of an identity-sync item: "tenant/<tenantId>" or "member/<userId>". */
export function identitySyncKey(kind: IdentitySyncKind, target: string): string {
  return `${kind}/${target}`;
}

/** One membership per user and tenant: the user is in this tenant already (a user may be in several tenants). */
export function alreadyMember(): Conflict {
  return new Conflict("already_member", "The user already is a member of this tenant");
}

// Cursors are opaque to clients: base64url of {"a": ISO time, "k": key}. A client can still craft one, and its parts
// end up as SQL parameters with casts (timestamptz, uuid, text), so they are checked completely: a bad cursor is a
// 400, never a database error.
export function encodeCursor(position: Keyset): string {
  return Buffer.from(JSON.stringify({ a: position.at.toISOString(), k: position.key }), "utf8").toString("base64url");
}

/** Decides whether the key part of a cursor fits the list it is used with. */
export type CursorKeyRule = (key: string) => boolean;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTROL_CHARACTER = /\p{Cc}/u;
export const USER_ID_MAX_LENGTH = 255;

/** The keys of the tenant list are tenant ids. */
export const tenantCursorKey: CursorKeyRule = (key) => UUID_PATTERN.test(key);

/** The keys of the member list are user ids: 1 to 255 characters, no control characters (NUL included). */
export const memberCursorKey: CursorKeyRule = (key) =>
  key.length >= 1 && key.length <= USER_ID_MAX_LENGTH && !CONTROL_CHARACTER.test(key);

/**
 * The time has to be exactly what encodeCursor writes (an ISO time with milliseconds and "Z", year 0000 to 9999),
 * not before 1970-01-01, and a real date: "2026-02-30T00:00:00.000Z" is read by Date as March 2, so it fails the
 * round trip.
 */
function validCursorTime(text: string): Date | null {
  const at = new Date(text);
  if (Number.isNaN(at.getTime()) || at.getTime() < 0 || at.toISOString() !== text || text.length !== 24) return null;
  return at;
}

export function decodeCursor(cursor: string | undefined, keyRule: CursorKeyRule): Keyset | null {
  if (cursor === undefined) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { a?: unknown; k?: unknown };
    if (typeof parsed.a === "string" && typeof parsed.k === "string") {
      const at = validCursorTime(parsed.a);
      if (at && keyRule(parsed.k)) return { at, key: parsed.k };
    }
  } catch {
    // Falls through to the validation error below.
  }
  throw new ValidationFailed([{ field: "cursor", message: "The cursor is not valid" }]);
}

export interface PageInput {
  limit?: number | undefined;
  cursor?: string | undefined;
}

export interface PageOf<T> {
  items: T[];
  nextCursor: string | null;
}

/** Reads one page by asking for one row more than the limit; that row tells whether another page follows. */
export async function readPage<T>(
  input: PageInput,
  fetchRows: (limit: number, after: Keyset | null) => Promise<T[]>,
  positionOf: (row: T) => Keyset,
  keyRule: CursorKeyRule,
): Promise<PageOf<T>> {
  const limit = input.limit ?? DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    throw new ValidationFailed([{ field: "limit", message: `limit must be an integer from 1 to ${MAX_PAGE_SIZE}` }]);
  }
  const rows = await fetchRows(limit + 1, decodeCursor(input.cursor, keyRule));
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  const nextCursor = rows.length > limit && last !== undefined ? encodeCursor(positionOf(last)) : null;
  return { items, nextCursor };
}
