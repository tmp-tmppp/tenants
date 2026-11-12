import { HttpStatusError } from "./markets-client.js";
import type { ServiceTokenSource } from "./markets-client.js";

export interface ServiceTokenOptions {
  /** Base URL of Keycloak, for example http://identity:8080. */
  keycloakUrl: string;
  realm: string;
  /** The client for the calls to markets: never the admin client, whose token the Admin API accepts (see wiring.ts). */
  clientId: string;
  clientSecret: string;
  fetch?: typeof fetch;
  /** Milliseconds since the epoch; replaced in tests. */
  nowMs?: () => number;
}

/** The token is renewed this long before it expires, so that a call never starts with a token about to run out. */
const TOKEN_SKEW_MS = 30_000;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/**
 * Client-credentials access token of this service for its calls to markets (the audience of the realm's service clients
 * is "chance"). Cached until shortly before it expires; one request at a time, however many callers wait for it. A
 * failure is thrown as it is (a network error, an HttpStatusError): the resilience policy of the caller decides.
 */
export class ClientCredentialsTokenSource implements ServiceTokenSource {
  private readonly http: typeof fetch;
  private readonly nowMs: () => number;
  private token: { value: string; expiresAtMs: number } | null = null;
  private request: Promise<string> | null = null;

  constructor(private readonly options: ServiceTokenOptions) {
    this.http = options.fetch ?? fetch;
    this.nowMs = options.nowMs ?? Date.now;
  }

  getToken(signal?: AbortSignal): Promise<string> {
    if (this.token && this.nowMs() < this.token.expiresAtMs - TOKEN_SKEW_MS) return Promise.resolve(this.token.value);
    this.request ??= this.fetchToken(signal).finally(() => {
      this.request = null;
    });
    return this.request;
  }

  invalidate(): void {
    this.token = null;
  }

  private async fetchToken(signal?: AbortSignal): Promise<string> {
    const url = `${this.options.keycloakUrl.replace(/\/+$/, "")}/realms/${encodeURIComponent(this.options.realm)}/protocol/openid-connect/token`;
    const response = await this.http(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: this.options.clientId,
        client_secret: this.options.clientSecret,
      }).toString(),
      ...(signal ? { signal } : {}),
    });
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

/**
 * Stands in for markets where it is not configured (APP_ENV=local without MARKETS_BASE_URL): every share link is answered
 * "unavailable", so the endpoint answers 503 instead of pretending to know the link.
 */
export const unconfiguredShareAdmission = {
  admit: () => Promise.resolve({ kind: "unavailable" as const, reason: "MARKETS_BASE_URL is not set" }),
};
