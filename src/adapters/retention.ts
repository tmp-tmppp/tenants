export const DAY_MS = 24 * 3_600_000;

/**
 * The default of STREAM_MAX_AGE_DAYS: how long a message of the TENANTS stream is kept (its max age) and how long the
 * outbox relay keeps a row after it was published. The two agree, because a row that was published longer ago than the
 * stream keeps its messages is of no use any more. 30 days, not 7, so that a service started later still reads the
 * older events (TenantCreated) from the stream (decision of 2026-11-11); every service of the platform sets the same value.
 */
export const DEFAULT_STREAM_MAX_AGE_DAYS = 30;

/** The default max age and relay retention in milliseconds, for the NATS adapter and the relay, which do not import each other. */
export const PUBLISHED_RETENTION_MS = DEFAULT_STREAM_MAX_AGE_DAYS * DAY_MS;
