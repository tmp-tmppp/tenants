import {
  BrokenCircuitError,
  ConsecutiveBreaker,
  ExponentialBackoff,
  TaskCancelledError,
  TimeoutStrategy,
  circuitBreaker,
  handleWhen,
  retry,
  timeout,
  wrap,
} from "cockatiel";
import { isRole } from "../../domain/role.js";
import type { Role } from "../../domain/role.js";
import { IdentityProviderRejected, IdentityProviderUnavailable } from "../../usecases/errors.js";
import type { IdentityProvider } from "../../usecases/ports.js";

export interface KeycloakOptions {
  /** Base URL of Keycloak, for example http://keycloak:8080. */
  baseUrl: string;
  realm: string;
  /** A confidential client with a service account that may manage organizations, their groups and members. */
  clientId: string;
  clientSecret: string;
  /** Per call. Default 3000. */
  timeoutMs?: number;
  /** Attempts per call, the first one included. Default 3. */
  maxAttempts?: number;
  /** First and largest wait between attempts (exponential backoff with jitter). Defaults 250 and 2000. */
  retryInitialDelayMs?: number;
  retryMaxDelayMs?: number;
  /** Consecutive failures that open the circuit, and the wait before one trial call. Defaults 5 and 10000. */
  breakerThreshold?: number;
  halfOpenAfterMs?: number;
  fetch?: typeof fetch;
  /** Milliseconds since the epoch; replaced in tests. */
  nowMs?: () => number;
}

class HttpStatusError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
    this.name = "HttpStatusError";
  }
}

/** The cached access token was rejected: a new one is fetched and the call is repeated. */
class StaleTokenError extends HttpStatusError {}

/** Worth another attempt right now: the same call may succeed a moment later. */
function isRetryable(error: unknown): boolean {
  if (error instanceof StaleTokenError) return true;
  if (error instanceof HttpStatusError) return error.status === 429 || error.status >= 500;
  if (error instanceof TaskCancelledError) return true;
  // fetch rejects with a TypeError when the network fails and with an AbortError when it is aborted.
  return error instanceof TypeError || (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"));
}

/** The provider cannot be used at the moment, whatever the call: not reached, too slow, overloaded or cut off. */
function isUnavailable(error: unknown): boolean {
  // An open circuit (also a held one, which extends it) is cockatiel's answer to "do not even try".
  return isRetryable(error) || error instanceof BrokenCircuitError;
}

interface Reply {
  status: number;
  json: unknown;
}

interface CallOptions {
  query?: Record<string, string>;
  body?: unknown;
  /** Statuses outside 2xx that are a normal answer, for example 409 "already exists". */
  accept?: readonly number[];
}

const TOKEN_SKEW_MS = 30_000;
/** The two role groups of every organization (token contract v2). */
const ROLES: readonly Role[] = ["trader", "tenant-admin"];

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/**
 * IdentityProvider for Keycloak 26.8 with Organizations (ADR-033), through its admin REST API. The organization
 * has the tenant id as name and as alias: Keycloak finds organizations by exact name, and the alias is what the
 * "organization" claim of a token carries. The tenant's own name is kept in the description. The role of a member is
 * the organization group "tenant-admin" or "trader" (organization groups exist since Keycloak 26.6; the endpoints are
 * under /organizations/{id}/groups in the admin REST API documentation of 26.8); a member is in exactly one of them.
 *
 * Every HTTP call has a timeout, a retry with exponential backoff and jitter (network errors, timeouts, 429 and
 * 5xx only) and one circuit breaker shared by all calls (REL-04). Every operation is idempotent.
 *
 * A failure that is left after the retries is named by what it means for the caller (see guard): the provider is
 * unavailable (network errors, timeouts, an open circuit, 429, 5xx: IdentityProviderUnavailable) or it answered and
 * refused (any other HTTP status: IdentityProviderRejected with that status). Only the identity-sync worker calls
 * this class; it retries soon after the first and slowly, with an error log, after the second.
 */
export class KeycloakIdentityProvider implements IdentityProvider {
  private readonly base: string;
  private readonly http: typeof fetch;
  private readonly nowMs: () => number;
  private readonly policy;
  private token: { value: string; expiresAtMs: number } | null = null;
  private tokenRequest: Promise<string> | null = null;

  constructor(private readonly options: KeycloakOptions) {
    this.base = options.baseUrl.replace(/\/+$/, "");
    this.http = options.fetch ?? fetch;
    this.nowMs = options.nowMs ?? Date.now;
    const maxAttempts = options.maxAttempts ?? 3;
    // Outermost first: retry, then the circuit breaker, then the timeout of one attempt.
    this.policy = wrap(
      retry(handleWhen(isRetryable), {
        maxAttempts: Math.max(0, maxAttempts - 1),
        backoff: new ExponentialBackoff({
          initialDelay: options.retryInitialDelayMs ?? 250,
          maxDelay: options.retryMaxDelayMs ?? 2000,
        }),
      }),
      circuitBreaker(handleWhen(isRetryable), {
        halfOpenAfter: options.halfOpenAfterMs ?? 10_000,
        breaker: new ConsecutiveBreaker(options.breakerThreshold ?? 5),
      }),
      timeout(options.timeoutMs ?? 3000, TimeoutStrategy.Aggressive),
    );
  }

  async ensureOrganization(tenantId: string, name: string): Promise<void> {
    await this.guard("ensureOrganization", async () => {
      let organizationId = await this.findOrganizationId(tenantId);
      if (!organizationId) {
        await this.call("POST", "/organizations", {
          body: { name: tenantId, alias: tenantId, description: name, enabled: true },
          accept: [409],
        });
        // The create answers 201 without a body we rely on (and 409 when another instance was first): read it back.
        organizationId = await this.requireOrganizationId(tenantId);
      }
      // Also for an organization that exists already: one made before roles were groups, or whose group was deleted.
      await this.ensureRoleGroups(organizationId);
    });
  }

  async addMember(tenantId: string, userId: string): Promise<void> {
    await this.guard("addMember", async () => {
      const organizationId = await this.requireOrganizationId(tenantId);
      // The body is the user id as a JSON string; 409 means the user already is a member.
      await this.call("POST", `/organizations/${encodeURIComponent(organizationId)}/members`, {
        body: userId,
        accept: [409],
      });
    });
  }

  async setRole(tenantId: string, userId: string, role: Role): Promise<void> {
    await this.guard("setRole", async () => {
      const organizationId = await this.requireOrganizationId(tenantId);
      const groups = await this.ensureRoleGroups(organizationId);
      const base = `/organizations/${encodeURIComponent(organizationId)}`;
      const membershipPath = (groupId: string): string => `${base}/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(userId)}`;
      // Keycloak's group calls are not idempotent (OrganizationGroupResource, 26.8.2): joining a group the user is in
      // answers 409 "User is already a member of the group", leaving one the user is not in answers 400 "User not a
      // member". The reconciler repeats every membership of the user on each item, so the groups of the user are read
      // first and only the missing change is made; a 409 on the join (another run was first) is a success.
      // The user has to be a member of the organization (addMember ran before).
      const current = await this.groupIdsOfMember(organizationId, userId);
      // Add the group of the new role first, then take the other one away, so the user never has no role in between.
      for (const [name, groupId] of groups) {
        if (name === role && !current.has(groupId)) await this.call("PUT", membershipPath(groupId), { accept: [409] });
      }
      for (const [name, groupId] of groups) {
        if (name !== role && current.has(groupId)) await this.call("DELETE", membershipPath(groupId));
      }
    });
  }

  /**
   * The ids of the groups of this organization that the user is in (GET /organizations/{id}/members/{userId}/groups,
   * 404 for a user that is not a member). Only the role groups matter here; an organization has no others by design.
   */
  private async groupIdsOfMember(organizationId: string, userId: string): Promise<Set<string>> {
    const path = `/organizations/${encodeURIComponent(organizationId)}/members/${encodeURIComponent(userId)}/groups`;
    const { json } = await this.call("GET", path, { query: { max: "100", briefRepresentation: "true" } });
    const ids = new Set<string>();
    for (const item of Array.isArray(json) ? (json as unknown[]) : []) {
      if (isRecord(item) && typeof item["id"] === "string") ids.add(item["id"]);
    }
    return ids;
  }

  /**
   * The ids of the two role groups of an organization, by role; a group that does not exist is created first
   * (POST /organizations/{id}/groups, 409 when another instance created it a moment ago). The groups are top-level
   * groups of the organization, so their paths in the token are "/tenant-admin" and "/trader". No role mapping is
   * ever put on them: Keycloak copies the roles of an organization group into realm_access for every organization.
   */
  private async ensureRoleGroups(organizationId: string): Promise<Map<Role, string>> {
    const path = `/organizations/${encodeURIComponent(organizationId)}/groups`;
    const found = async (): Promise<Map<Role, string>> => {
      // Without a search the answer holds the top-level groups of the organization.
      const { json } = await this.call("GET", path, { query: { max: "100", briefRepresentation: "true" } });
      const byName = new Map<Role, string>();
      for (const item of Array.isArray(json) ? (json as unknown[]) : []) {
        if (isRecord(item) && typeof item["id"] === "string" && typeof item["name"] === "string" && isRole(item["name"])) {
          byName.set(item["name"], item["id"]);
        }
      }
      return byName;
    };
    let groups = await found();
    const missing = ROLES.filter((role) => !groups.has(role));
    if (missing.length === 0) return groups;
    for (const role of missing) await this.call("POST", path, { body: { name: role }, accept: [409] });
    groups = await found();
    const still = ROLES.filter((role) => !groups.has(role));
    if (still.length > 0) throw new Error(`The organization groups ${still.join(", ")} do not exist after they were created`);
    return groups;
  }

  /**
   * Runs one operation and names its failure: unavailable (retry soon) or rejected with the HTTP status (retry
   * slowly, someone has to fix the cause). An error that is neither, such as a response that is not what the admin
   * API documents, is thrown as it is.
   */
  private async guard(operation: string, work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (error) {
      const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      if (isUnavailable(error)) {
        throw new IdentityProviderUnavailable(`The identity provider is unavailable in ${operation} (${reason})`, { cause: error });
      }
      if (error instanceof HttpStatusError) {
        throw new IdentityProviderRejected(error.status, `The identity provider rejected ${operation} (${reason})`, { cause: error });
      }
      throw error;
    }
  }

  private async findOrganizationId(alias: string): Promise<string | null> {
    const { json } = await this.call("GET", "/organizations", { query: { search: alias, exact: "true", max: "5" } });
    const found: unknown = Array.isArray(json) ? (json as unknown[]).find((item) => isRecord(item) && item["alias"] === alias) : undefined;
    return isRecord(found) && typeof found["id"] === "string" ? found["id"] : null;
  }

  private async requireOrganizationId(alias: string): Promise<string> {
    const id = await this.findOrganizationId(alias);
    if (!id) throw new Error(`The organization ${alias} does not exist`);
    return id;
  }

  /** One admin API call under the resilience policy. */
  private call(method: string, path: string, options: CallOptions = {}): Promise<Reply> {
    return this.policy.execute(async ({ signal }) => {
      const usedCachedToken = this.token !== null && this.nowMs() < this.token.expiresAtMs - TOKEN_SKEW_MS;
      const accessToken = await this.accessToken(signal);
      const query = options.query ? `?${new URLSearchParams(options.query).toString()}` : "";
      const response = await this.http(`${this.base}/admin/realms/${encodeURIComponent(this.options.realm)}${path}${query}`, {
        method,
        headers: {
          authorization: `Bearer ${accessToken}`,
          accept: "application/json",
          ...(options.body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        signal,
      });
      if (response.status === 401) {
        this.token = null;
        throw usedCachedToken ? new StaleTokenError(401) : new HttpStatusError(401);
      }
      if (!response.ok && !(options.accept ?? []).includes(response.status)) {
        await response.body?.cancel();
        throw new HttpStatusError(response.status);
      }
      const text = await response.text();
      return { status: response.status, json: text.length > 0 ? safeJson(text) : null };
    });
  }

  /** Client-credentials token of the service account, cached until shortly before it expires. */
  private accessToken(signal: AbortSignal): Promise<string> {
    if (this.token && this.nowMs() < this.token.expiresAtMs - TOKEN_SKEW_MS) return Promise.resolve(this.token.value);
    this.tokenRequest ??= this.requestToken(signal).finally(() => {
      this.tokenRequest = null;
    });
    return this.tokenRequest;
  }

  private async requestToken(signal: AbortSignal): Promise<string> {
    const response = await this.http(
      `${this.base}/realms/${encodeURIComponent(this.options.realm)}/protocol/openid-connect/token`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: this.options.clientId,
          client_secret: this.options.clientSecret,
        }).toString(),
        signal,
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new HttpStatusError(response.status);
    }
    const body: unknown = await response.json();
    if (!isRecord(body) || typeof body["access_token"] !== "string") throw new Error("The token response has no access_token");
    const lifetimeSeconds = typeof body["expires_in"] === "number" ? body["expires_in"] : 60;
    this.token = { value: body["access_token"], expiresAtMs: this.nowMs() + lifetimeSeconds * 1000 };
    return this.token.value;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
