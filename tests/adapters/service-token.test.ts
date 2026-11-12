import { describe, expect, it } from "vitest";
import { HttpStatusError } from "../../src/adapters/markets/markets-client.js";
import { ClientCredentialsTokenSource, unconfiguredShareAdmission } from "../../src/adapters/markets/service-token.js";

const SECRET = "client-secret-value";

function setup(options: { status?: number; body?: unknown } = {}) {
  const calls: Array<{ url: string; method: string | undefined; headers: unknown; body: string }> = [];
  let now = 1_000_000;
  let counter = 0;
  const fetchStub = (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    counter += 1;
    calls.push({ url: url as string, method: init?.method, headers: init?.headers, body: init?.body as string });
    const body = options.body ?? { access_token: `access-${counter}`, expires_in: 300 };
    return Promise.resolve(new Response(JSON.stringify(body), { status: options.status ?? 200, headers: { "content-type": "application/json" } }));
  };
  const source = new ClientCredentialsTokenSource({
    keycloakUrl: "http://keycloak:8080/",
    realm: "chance realm",
    clientId: "tenants",
    clientSecret: SECRET,
    fetch: fetchStub,
    nowMs: () => now,
  });
  return { source, calls, advance: (ms: number) => (now += ms) };
}

describe("ClientCredentialsTokenSource", () => {
  it("asks the token endpoint of the realm with the client credentials, in a form body", async () => {
    const { source, calls } = setup();

    expect(await source.getToken()).toBe("access-1");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://keycloak:8080/realms/chance%20realm/protocol/openid-connect/token");
    expect(calls[0]?.method).toBe("POST");
    expect(Object.fromEntries(new URLSearchParams(calls[0]?.body))).toEqual({ grant_type: "client_credentials", client_id: "tenants", client_secret: SECRET });
    expect(calls[0]?.url).not.toContain(SECRET);
  });

  it("keeps the token until 30 seconds before it expires, then renews it", async () => {
    const { source, calls, advance } = setup();
    await source.getToken();

    advance(269_000);
    expect(await source.getToken()).toBe("access-1");
    expect(calls).toHaveLength(1);

    advance(1000);
    expect(await source.getToken()).toBe("access-2");
    expect(calls).toHaveLength(2);
  });

  it("makes one request for callers that wait at the same time", async () => {
    const { source, calls } = setup();
    const tokens = await Promise.all([source.getToken(), source.getToken(), source.getToken()]);
    expect(tokens).toEqual(["access-1", "access-1", "access-1"]);
    expect(calls).toHaveLength(1);
  });

  it("fetches a new token after invalidate()", async () => {
    const { source } = setup();
    await source.getToken();
    source.invalidate();
    expect(await source.getToken()).toBe("access-2");
  });

  it("assumes a lifetime of 60 seconds when the answer has none, so the token is renewed after 30", async () => {
    const { source, calls, advance } = setup({ body: { access_token: "short-lived" } });
    await source.getToken();
    advance(29_000);
    await source.getToken();
    expect(calls).toHaveLength(1);
    advance(2000);
    await source.getToken();
    expect(calls).toHaveLength(2);
  });

  it("throws the status of a refusal, without the secret, and asks again the next time", async () => {
    const { source, calls } = setup({ status: 401, body: { error: "unauthorized_client" } });

    const failure = await source.getToken().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(HttpStatusError);
    expect((failure as HttpStatusError).status).toBe(401);
    expect(String((failure as Error).message)).not.toContain(SECRET);
    await source.getToken().catch(() => undefined);
    expect(calls).toHaveLength(2);
  });

  it.each([["no access_token", { expires_in: 300 }], ["an access_token that is not text", { access_token: 5 }], ["no JSON object", "text"]])(
    "throws for an answer with %s",
    async (_name, body) => {
      const { source } = setup({ body });
      await expect(source.getToken()).rejects.toThrow("access_token");
    },
  );
});

describe("unconfiguredShareAdmission", () => {
  it("answers unavailable for every link", async () => {
    await expect(unconfiguredShareAdmission.admit()).resolves.toEqual({ kind: "unavailable", reason: "MARKETS_BASE_URL is not set" });
  });
});
