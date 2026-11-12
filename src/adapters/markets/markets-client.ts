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
import type { ShareAdmission, ShareAdmissionOutcome, ShareAdmissionRequest, ShareLinkType } from "../../usecases/ports.js";

/** Where the access token for a call to markets comes from: the client-credentials token of this service. */
export interface ServiceTokenSource {
  getToken(signal?: AbortSignal): Promise<string>;
  /** Forgets the cached token: markets rejected it. */
  invalidate(): void;
}

export interface MarketsClientOptions {
  /** Base URL of markets, for example http://markets:8080. */
  baseUrl: string;
  tokens: ServiceTokenSource;
  /** Per attempt. Default 3000. */
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
}

/** Markets answered with a status the call does not accept. */
export class HttpStatusError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
    this.name = "HttpStatusError";
  }
}

/** The cached service token was rejected: a new one is fetched and the call is repeated. */
export class StaleTokenError extends HttpStatusError {}

/** Worth another attempt right now: the call only asks a question, so repeating it is always safe. */
export function isRetryable(error: unknown): boolean {
  if (error instanceof StaleTokenError) return true;
  if (error instanceof HttpStatusError) return error.status === 429 || error.status >= 500;
  if (error instanceof TaskCancelledError) return true;
  // fetch rejects with a TypeError when the network fails and with an AbortError when it is aborted.
  return error instanceof TypeError || (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"));
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DECISIONS = ["join", "members_only", "denied"] as const;
const LINK_TYPES: readonly ShareLinkType[] = ["members", "profiles", "everyone"];

/** The answer of markets as contracts/markets-admission.openapi.yaml describes it, or null when it is something else. */
export function parseAdmission(body: unknown): Extract<ShareAdmissionOutcome, { kind: "answered" }> | null {
  if (!isRecord(body)) return null;
  const { decision, linkType, tenantId, marketId } = body;
  const knownDecision = DECISIONS.find((candidate) => candidate === decision);
  const knownType = LINK_TYPES.find((candidate) => candidate === linkType);
  if (!knownDecision || !knownType) return null;
  if (typeof tenantId !== "string" || !UUID.test(tenantId) || typeof marketId !== "string" || !UUID.test(marketId)) return null;
  return { kind: "answered", decision: knownDecision, linkType: knownType, tenantId: tenantId.toLowerCase(), marketId: marketId.toLowerCase() };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Markets' admission check for share links (contracts/markets-admission.openapi.yaml), called with the client-credentials
 * token of this service. The share-link token is a secret: it is sent in the request body only, and no error, reason or
 * log line of this class ever holds it (reasons are built from error names and HTTP statuses).
 *
 * The call only asks, so it has the full resilience of an outgoing call (REL-04): a timeout per attempt, a retry with
 * exponential backoff and jitter on safe failures only (network errors, timeouts, 429, 5xx, one stale service token),
 * and a circuit breaker shared by all calls. It never throws: not_found (404) and the answer of markets are outcomes,
 * and everything else (an unreachable markets, 400, 401 twice, 403, an answer that is not the agreed one) is
 * "unavailable", because nothing is known and nothing was changed.
 */
export class MarketsClient implements ShareAdmission {
  private readonly base: string;
  private readonly http: typeof fetch;
  private readonly policy;

  constructor(private readonly options: MarketsClientOptions) {
    this.base = options.baseUrl.replace(/\/+$/, "");
    this.http = options.fetch ?? fetch;
    const maxAttempts = options.maxAttempts ?? 3;
    // Outermost first: retry, then the circuit breaker, then the timeout of one attempt.
    this.policy = wrap(
      retry(handleWhen(isRetryable), {
        maxAttempts: Math.max(0, maxAttempts - 1),
        backoff: new ExponentialBackoff({ initialDelay: options.retryInitialDelayMs ?? 250, maxDelay: options.retryMaxDelayMs ?? 2000 }),
      }),
      circuitBreaker(handleWhen(isRetryable), {
        halfOpenAfter: options.halfOpenAfterMs ?? 10_000,
        breaker: new ConsecutiveBreaker(options.breakerThreshold ?? 5),
      }),
      timeout(options.timeoutMs ?? 3000, TimeoutStrategy.Aggressive),
    );
  }

  async admit(request: ShareAdmissionRequest): Promise<ShareAdmissionOutcome> {
    let refreshed = false;
    try {
      return await this.policy.execute(async ({ signal }): Promise<ShareAdmissionOutcome> => {
        const accessToken = await this.options.tokens.getToken(signal);
        const response = await this.http(`${this.base}/v1/internal/share-links/admission`, {
          method: "POST",
          headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ token: request.token, userEmail: request.userEmail, emailVerified: request.emailVerified }),
          signal,
        });
        if (response.status === 401 && !refreshed) {
          // The cached service token may have been revoked: fetch a new one and repeat once.
          refreshed = true;
          this.options.tokens.invalidate();
          await response.body?.cancel();
          throw new StaleTokenError(401);
        }
        if (response.status === 404) {
          await response.body?.cancel();
          return { kind: "not_found" };
        }
        if (!response.ok) {
          await response.body?.cancel();
          throw new HttpStatusError(response.status);
        }
        const answer = parseAdmission(safeJson(await response.text()));
        return answer ?? { kind: "unavailable", reason: "the answer of markets is not the agreed admission answer" };
      });
    } catch (error) {
      if (error instanceof BrokenCircuitError) return { kind: "unavailable", reason: "the circuit to markets is open" };
      const name = error instanceof Error ? error.name : "unknown error";
      const status = error instanceof HttpStatusError ? ` (markets answered ${error.status})` : "";
      return { kind: "unavailable", reason: `${name}${status}` };
    }
  }
}
