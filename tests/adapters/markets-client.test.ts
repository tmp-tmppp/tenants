import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { HttpStatusError, MarketsClient, StaleTokenError, isRetryable, parseAdmission } from "../../src/adapters/markets/markets-client.js";
import type { ServiceTokenSource } from "../../src/adapters/markets/markets-client.js";

const TENANT = "018f3c1e-7a00-7000-8000-0000000000aa";
const MARKET = "018f3c1e-7a00-7000-8000-0000000000bb";
const SHARE_TOKEN = "share-token-00000001".padEnd(43, "x");
const REQUEST = { token: SHARE_TOKEN, userEmail: "visitor@example.com", emailVerified: true };
const ANSWER = { decision: "join", linkType: "everyone", tenantId: TENANT, marketId: MARKET };

interface Seen {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingMessage["headers"];
  body: string;
}

let server: Server | null = null;
let held: ServerResponse[] = [];
const seen: Seen[] = [];

/** A local HTTP server in place of markets; `handler` decides the answer of each request, by its number. */
async function markets(handler: (request: Seen, number: number, response: ServerResponse) => void): Promise<string> {
  seen.length = 0;
  held = [];
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const entry = { method: request.method, url: request.url, headers: request.headers, body: Buffer.concat(chunks).toString("utf8") };
      seen.push(entry);
      handler(entry, seen.length, response);
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const json = (response: ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};

afterEach(async () => {
  for (const response of held) response.destroy();
  server?.closeAllConnections();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
});

/** A token source that hands out service-token-1, and a new one after every invalidate(). */
function tokenSource() {
  let generation = 1;
  const source: ServiceTokenSource & { invalidated: number; fetched: number } = {
    invalidated: 0,
    fetched: 0,
    getToken: () => {
      source.fetched += 1;
      return Promise.resolve(`service-token-${generation}`);
    },
    invalidate: () => {
      source.invalidated += 1;
      generation += 1;
    },
  };
  return source;
}

const fast = { retryInitialDelayMs: 1, retryMaxDelayMs: 2, timeoutMs: 1000 };

describe("MarketsClient", () => {
  it("posts the question to the internal admission endpoint with the service token, and the share token only in the body", async () => {
    const baseUrl = await markets((_request, _n, response) => json(response, 200, ANSWER));
    const tokens = tokenSource();

    const outcome = await new MarketsClient({ baseUrl: `${baseUrl}///`, tokens, ...fast }).admit(REQUEST);

    expect(outcome).toEqual({ kind: "answered", decision: "join", linkType: "everyone", tenantId: TENANT, marketId: MARKET });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: "POST", url: "/v1/internal/share-links/admission" });
    expect(seen[0]?.headers["authorization"]).toBe("Bearer service-token-1");
    expect(seen[0]?.headers["content-type"]).toContain("application/json");
    expect(JSON.parse(seen[0]?.body ?? "")).toEqual({ token: SHARE_TOKEN, userEmail: "visitor@example.com", emailVerified: true });
    expect(JSON.stringify([seen[0]?.url, seen[0]?.headers])).not.toContain(SHARE_TOKEN);
  });

  it("answers not_found for 404 without retrying", async () => {
    const baseUrl = await markets((_request, _n, response) => json(response, 404, { title: "not found" }));
    expect(await new MarketsClient({ baseUrl, tokens: tokenSource(), ...fast }).admit(REQUEST)).toEqual({ kind: "not_found" });
    expect(seen).toHaveLength(1);
  });

  it("retries a 503 and a 429 (safe failures) and answers what the next attempt gives", async () => {
    const baseUrl = await markets((_request, n, response) => (n === 1 ? json(response, 503, {}) : n === 2 ? json(response, 429, {}) : json(response, 200, ANSWER)));
    const outcome = await new MarketsClient({ baseUrl, tokens: tokenSource(), ...fast }).admit(REQUEST);
    expect(outcome).toMatchObject({ kind: "answered", decision: "join" });
    expect(seen).toHaveLength(3);
  });

  it("gives up after the attempts it is allowed, with a reason that holds the status and no token", async () => {
    const baseUrl = await markets((_request, _n, response) => json(response, 503, {}));
    const outcome = await new MarketsClient({ baseUrl, tokens: tokenSource(), maxAttempts: 3, ...fast }).admit(REQUEST);
    expect(outcome).toEqual({ kind: "unavailable", reason: "HttpStatusError (markets answered 503)" });
    expect(seen).toHaveLength(3);
  });

  it.each([400, 403, 422])("does not retry a %i: the question itself was refused", async (status) => {
    const baseUrl = await markets((_request, _n, response) => json(response, status, {}));
    const outcome = await new MarketsClient({ baseUrl, tokens: tokenSource(), ...fast }).admit(REQUEST);
    expect(outcome).toEqual({ kind: "unavailable", reason: `HttpStatusError (markets answered ${status})` });
    expect(seen).toHaveLength(1);
  });

  it("fetches a new service token once when markets rejects the cached one, then asks again with it", async () => {
    const baseUrl = await markets((request, _n, response) =>
      request.headers["authorization"] === "Bearer service-token-2" ? json(response, 200, ANSWER) : json(response, 401, {}),
    );
    const tokens = tokenSource();

    const outcome = await new MarketsClient({ baseUrl, tokens, ...fast }).admit(REQUEST);

    expect(outcome).toMatchObject({ kind: "answered" });
    expect(tokens.invalidated).toBe(1);
    expect(seen.map((request) => request.headers["authorization"])).toEqual(["Bearer service-token-1", "Bearer service-token-2"]);
  });

  it("does not keep trying when the new service token is rejected too", async () => {
    const baseUrl = await markets((_request, _n, response) => json(response, 401, {}));
    const tokens = tokenSource();

    const outcome = await new MarketsClient({ baseUrl, tokens, ...fast }).admit(REQUEST);

    expect(outcome).toEqual({ kind: "unavailable", reason: "HttpStatusError (markets answered 401)" });
    expect(seen).toHaveLength(2);
    expect(tokens.invalidated).toBe(1);
  });

  it.each([
    ["JSON that is not an answer", "[]"],
    ["an unknown decision", JSON.stringify({ ...ANSWER, decision: "maybe" })],
    ["an identifier that is no UUID", JSON.stringify({ ...ANSWER, marketId: "market-1" })],
    ["text", "not json at all"],
  ])("answers unavailable for %s", async (_name, text) => {
    const baseUrl = await markets((_request, _n, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(text);
    });
    const outcome = await new MarketsClient({ baseUrl, tokens: tokenSource(), ...fast }).admit(REQUEST);
    expect(outcome).toEqual({ kind: "unavailable", reason: "the answer of markets is not the agreed admission answer" });
    expect(seen).toHaveLength(1);
  });

  it("opens the circuit after consecutive failures and then asks markets no more", async () => {
    const baseUrl = await markets((_request, _n, response) => json(response, 503, {}));
    const client = new MarketsClient({ baseUrl, tokens: tokenSource(), maxAttempts: 1, breakerThreshold: 2, halfOpenAfterMs: 60_000, ...fast });

    await client.admit(REQUEST);
    await client.admit(REQUEST);
    const third = await client.admit(REQUEST);

    expect(third).toEqual({ kind: "unavailable", reason: "the circuit to markets is open" });
    expect(seen).toHaveLength(2);
  });

  it("gives up on an attempt that takes longer than the timeout", async () => {
    const baseUrl = await markets((_request, _n, response) => {
      held.push(response); // never answered
    });
    const outcome = await new MarketsClient({ baseUrl, tokens: tokenSource(), maxAttempts: 1, retryInitialDelayMs: 1, retryMaxDelayMs: 2, timeoutMs: 60 }).admit(REQUEST);
    expect(outcome.kind).toBe("unavailable");
    expect(seen).toHaveLength(1);
  });

  it("retries a network error, and never puts the text of an error into the reason", async () => {
    let calls = 0;
    const failing = (): Promise<Response> => {
      calls += 1;
      return Promise.reject(new TypeError(`fetch failed for ${SHARE_TOKEN}`));
    };
    const outcome = await new MarketsClient({ baseUrl: "http://markets.example", tokens: tokenSource(), fetch: failing, maxAttempts: 3, ...fast }).admit(REQUEST);
    expect(outcome).toEqual({ kind: "unavailable", reason: "TypeError" });
    expect(calls).toBe(3);
  });

  it("answers unavailable when the service token cannot be fetched, with the status and not the token", async () => {
    const tokens: ServiceTokenSource = { getToken: () => Promise.reject(new HttpStatusError(503)), invalidate: () => undefined };
    const outcome = await new MarketsClient({ baseUrl: "http://markets.example", tokens, maxAttempts: 2, ...fast }).admit(REQUEST);
    expect(outcome).toEqual({ kind: "unavailable", reason: "HttpStatusError (markets answered 503)" });
  });

  it("answers unavailable for an error of a kind nobody expected, and does not retry it", async () => {
    let calls = 0;
    const failing = (): Promise<Response> => {
      calls += 1;
      // Something that is no Error, as a misbehaving fetch could reject with.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      return Promise.reject("a string, not an Error");
    };
    const outcome = await new MarketsClient({ baseUrl: "http://markets.example", tokens: tokenSource(), fetch: failing, ...fast }).admit(REQUEST);
    expect(outcome).toEqual({ kind: "unavailable", reason: "unknown error" });
    expect(calls).toBe(1);
  });
});

describe("isRetryable", () => {
  it("retries only what is safe to repeat", () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    const timeout = Object.assign(new Error("timed out"), { name: "TimeoutError" });
    expect([new StaleTokenError(401), new HttpStatusError(429), new HttpStatusError(500), new HttpStatusError(503), new TypeError("x"), abort, timeout].map(isRetryable)).toEqual(
      [true, true, true, true, true, true, true],
    );
    expect([new HttpStatusError(400), new HttpStatusError(401), new HttpStatusError(403), new HttpStatusError(404), new Error("x"), "text", null].map(isRetryable)).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
  });
});

describe("parseAdmission", () => {
  it("accepts the three decisions and the three link types, and lower-cases the identifiers", () => {
    for (const decision of ["join", "members_only", "denied"]) {
      for (const linkType of ["members", "profiles", "everyone"]) {
        expect(parseAdmission({ decision, linkType, tenantId: TENANT.toUpperCase(), marketId: MARKET })).toEqual({ kind: "answered", decision, linkType, tenantId: TENANT, marketId: MARKET });
      }
    }
  });

  it.each([
    ["null", null],
    ["a list", []],
    ["a missing decision", { linkType: "everyone", tenantId: TENANT, marketId: MARKET }],
    ["an unknown link type", { ...ANSWER, linkType: "friends" }],
    ["a tenant id that is not text", { ...ANSWER, tenantId: 5 }],
    ["a market id that is no UUID", { ...ANSWER, marketId: "x" }],
  ])("refuses %s", (_name, body) => {
    expect(parseAdmission(body)).toBeNull();
  });
});
