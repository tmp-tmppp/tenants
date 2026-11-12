import { errors, jwtVerify } from "jose";
import type { JWTPayload, JWTVerifyGetKey } from "jose";
import type { FastifyReply, FastifyRequest } from "fastify";
import { HttpError } from "./problems.js";

export interface AuthOptions {
  issuer: string;
  audience: string;
  /** Resolves the signing key of a token: the identity provider's JWKS in production, a local key in tests. */
  getKey: JWTVerifyGetKey;
  /** Dot path of the realm roles in the token, for example "realm_access.roles". Read for "platform-admin" only. */
  rolesClaim: string;
  /** Dot path of the organization claim, for example "organization"; its one entry holds the groups "/trader" or "/tenant-admin". */
  tenantClaim: string;
}

export interface AuthContext {
  userId: string;
  /**
   * The effective roles: "platform-admin" (and any other realm role) from the realm roles of the token, and "tenant-admin"
   * or "trader" only from the group of the token's organization, never from the realm roles (token contract v2).
   */
  roles: readonly string[];
  /** The tenant of the token: the single organization alias, or null when the token has none. */
  tenantId: string | null;
  /** The `email` claim, or null. Only share-link joins read it, together with emailVerified. */
  email: string | null;
  /** The `email_verified` claim: true only when it is the boolean true; an absent or any other value is false. */
  emailVerified: boolean;
}

declare module "fastify" {
  interface FastifyRequest {
    auth: AuthContext | null;
    correlationId: string;
  }
}

// Only asymmetric algorithms: a token can never be accepted with a shared secret or without a signature.
const ALGORITHMS = ["RS256", "RS384", "RS512", "ES256", "ES384", "PS256", "PS384", "PS512", "EdDSA"];

function unauthorized(detail: string, challenge: string): HttpError {
  return new HttpError(401, "unauthorized", detail, { "www-authenticate": challenge });
}

/** Seconds a client is told to wait when the signing keys cannot be fetched; the key fetch has its own timeout. */
export const KEYS_RETRY_AFTER_SECONDS = 5;

/** The tokens cannot be checked because the identity provider's signing keys are not available: 503, not 401. */
function keysUnavailable(): HttpError {
  return new HttpError(
    503,
    "identity_provider_unavailable",
    "The signing keys of the identity provider cannot be fetched; try again shortly",
    { "retry-after": String(KEYS_RETRY_AFTER_SECONDS) },
  );
}

/** A failure to fetch the signing keys, as opposed to a token that is wrong. Thrown by the key resolver only. */
class SigningKeysUnavailable extends Error {
  constructor(cause: unknown) {
    super("The signing keys cannot be fetched", { cause });
    this.name = "SigningKeysUnavailable";
  }
}

/**
 * Whether an error of the key resolver means the key set could not be fetched or read: a timeout, a key set that
 * is malformed, a bad HTTP status or body (jose throws its base class JOSEError, with no subclass, only for these
 * two), or anything that is not a jose error at all (a network error is a TypeError). Errors about the token
 * itself (an unknown or ambiguous key id) are JOSEError subclasses and stay 401.
 */
function isKeyFetchFailure(error: unknown): boolean {
  if (error instanceof errors.JWKSTimeout || error instanceof errors.JWKSInvalid) return true;
  if (!(error instanceof errors.JOSEError)) return true;
  return error.code === errors.JOSEError.code;
}

/** Marks the failures of the key resolver, so that they are told apart from the errors about the token. */
function marked(getKey: JWTVerifyGetKey): JWTVerifyGetKey {
  return async (protectedHeader, token) => {
    try {
      return await getKey(protectedHeader, token);
    } catch (error) {
      throw isKeyFetchFailure(error) ? new SigningKeysUnavailable(error) : error;
    }
  };
}

function readPath(source: unknown, path: string): unknown {
  let current: unknown = source;
  for (const part of path.split(".")) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Token contract v2: the tenant role is the group of the token's one organization, "/tenant-admin" or "/trader" in
 * `organization.<alias>.groups`. Keycloak copies the roles of an organization group into the realm roles of every
 * organization, so no role is ever mapped on those groups and the realm roles carry no tenant role.
 */
const TENANT_GROUPS: ReadonlyMap<string, string> = new Map([
  ["/tenant-admin", "tenant-admin"],
  ["/trader", "trader"],
]);
const TENANT_ROLES: ReadonlySet<string> = new Set(TENANT_GROUPS.values());

/** The realm roles of the token. A tenant role found here is ignored: it counts only as a group of the organization. */
function realmRolesOf(payload: JWTPayload, claim: string): string[] {
  const value = readPath(payload, claim);
  return Array.isArray(value)
    ? value.filter((role): role is string => typeof role === "string" && !TENANT_ROLES.has(role))
    : [];
}

interface TokenOrganization {
  alias: string;
  groups: string[];
}

function groupsOf(entry: unknown): string[] {
  const groups = readPath(entry, "groups");
  return Array.isArray(groups) ? groups.filter((group): group is string => typeof group === "string") : [];
}

/**
 * The organization claim is an object keyed by alias (each value holds the organization's groups); an array of
 * aliases or one alias as text is accepted too, without groups. Exactly one organization is allowed.
 */
function organizationOf(payload: JWTPayload, claim: string): TokenOrganization | null {
  const value = readPath(payload, claim);
  const found: TokenOrganization[] = [];
  if (typeof value === "string") {
    found.push({ alias: value, groups: [] });
  } else if (Array.isArray(value)) {
    for (const alias of value) if (typeof alias === "string") found.push({ alias, groups: [] });
  } else if (typeof value === "object" && value !== null) {
    for (const [alias, entry] of Object.entries(value)) found.push({ alias, groups: groupsOf(entry) });
  }
  if (found.length > 1) {
    throw unauthorized("The token belongs to more than one organization", 'Bearer error="invalid_token"');
  }
  return found[0] ?? null;
}

/** The tenant role of a list of groups: only when exactly one tenant role is among them, otherwise none. */
function tenantRolesOf(groups: readonly string[]): string[] {
  const roles = new Set<string>();
  for (const group of groups) {
    const role = TENANT_GROUPS.get(group);
    if (role !== undefined) roles.add(role);
  }
  return roles.size === 1 ? [...roles] : [];
}

/** onRequest hook: verifies the bearer token and puts the caller on the request. */
export function authenticate(options: AuthOptions) {
  const getKey = marked(options.getKey);
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const header = request.headers.authorization;
    if (!header) throw unauthorized("A bearer token is required", "Bearer");
    const [scheme, token, ...rest] = header.split(" ");
    if (scheme?.toLowerCase() !== "bearer" || !token || rest.length > 0) {
      throw unauthorized("The Authorization header must be: Bearer <token>", "Bearer");
    }

    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, getKey, {
        issuer: options.issuer,
        audience: options.audience,
        algorithms: ALGORITHMS,
      }));
    } catch (error) {
      if (error instanceof SigningKeysUnavailable) {
        request.log.warn({ err: error.cause }, "The signing keys of the identity provider cannot be fetched");
        throw keysUnavailable();
      }
      request.log.info({ reason: error instanceof Error ? error.name : "unknown" }, "A token was rejected");
      throw unauthorized("The token is not valid", 'Bearer error="invalid_token"');
    }
    if (!payload.sub) throw unauthorized("The token has no subject", 'Bearer error="invalid_token"');

    const organization = organizationOf(payload, options.tenantClaim);
    const auth: AuthContext = {
      userId: payload.sub,
      roles: [...realmRolesOf(payload, options.rolesClaim), ...tenantRolesOf(organization?.groups ?? [])],
      tenantId: organization?.alias ?? null,
      email: typeof payload["email"] === "string" && payload["email"].length > 0 ? payload["email"] : null,
      emailVerified: payload["email_verified"] === true,
    };
    request.auth = auth;
    request.log = reply.log = request.log.child({ userId: auth.userId, tenantId: auth.tenantId });
  };
}

/**
 * The tenant label of the request metrics: the tenant id of the token this service verified, or null. `request.auth` is
 * set only after the token check succeeded, so a request without a valid token is "none"; a header or the body is
 * never read. src/main.ts and the tests use this one function.
 */
export function tenantOfRequest(request: FastifyRequest): string | null {
  return request.auth?.tenantId ?? null;
}

export function requireAuth(request: FastifyRequest): AuthContext {
  if (!request.auth) throw unauthorized("A bearer token is required", "Bearer");
  return request.auth;
}

/** Guard for the platform-admin endpoints. */
export function requirePlatformAdmin(request: FastifyRequest): void {
  if (!requireAuth(request).roles.includes("platform-admin")) {
    throw new HttpError(403, "forbidden", "The platform-admin role is required");
  }
}

/**
 * Guard for the endpoints of one tenant. A path id that is not the token's tenant is answered 404, so the
 * existence of another tenant is not revealed (plan section 9); then the tenant-admin role is checked.
 * Returns the tenant id, always taken from the token.
 */
export function requireTenantAdmin(request: FastifyRequest<{ Params: { id: string } }>): string {
  const auth = requireAuth(request);
  if (auth.tenantId === null || auth.tenantId.toLowerCase() !== request.params.id.toLowerCase()) {
    throw new HttpError(404, "not_found", "No such resource");
  }
  if (!auth.roles.includes("tenant-admin")) {
    throw new HttpError(403, "forbidden", "The tenant-admin role is required");
  }
  return auth.tenantId;
}

/** The checks above as async hooks: Fastify waits for the returned promise, and a thrown error becomes the answer. */
export type RequestHook = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export const platformAdminHook = (request: FastifyRequest): Promise<void> =>
  Promise.resolve().then(() => {
    requirePlatformAdmin(request);
  });

export const tenantAdminHook = (request: FastifyRequest<{ Params: { id: string } }>): Promise<void> =>
  Promise.resolve().then(() => {
    requireTenantAdmin(request);
  });
