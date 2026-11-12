import { describe, expect, it } from "vitest";
import { buildShareAdmission } from "../../src/adapters/markets/wiring.js";
import { loadConfig } from "../../src/config.js";

const ADMIN_CLIENT = "tenants";
const ADMIN_SECRET = "admin-secret-for-the-admin-api";
const MARKETS_CLIENT = "tenants-markets";
const MARKETS_SECRET = "secret-of-the-markets-client";

const environment = {
  DATABASE_URL: "postgres://app:pw@db:5432/tenants",
  NATS_URL: "nats://nats:4222",
  KEYCLOAK_URL: "http://keycloak:8080",
  KEYCLOAK_REALM: "chance",
  KEYCLOAK_CLIENT_ID: ADMIN_CLIENT,
  KEYCLOAK_CLIENT_SECRET: ADMIN_SECRET,
  MARKETS_BASE_URL: "http://markets:8080",
  MARKETS_ADMISSION_CLIENT_ID: MARKETS_CLIENT,
  MARKETS_ADMISSION_CLIENT_SECRET: MARKETS_SECRET,
  AUTH_JWKS_URL: "http://keycloak:8080/realms/chance/protocol/openid-connect/certs",
  AUTH_ISSUER: "http://keycloak:8080/realms/chance",
  AUTH_AUDIENCE: "chance",
};

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: string;
}

/** A fetch that plays Keycloak's token endpoint and markets' admission endpoint, and records what was sent. */
function recordingFetch(): { fetch: typeof fetch; sent: Sent[] } {
  const sent: Sent[] = [];
  const fakeFetch = (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const body = typeof init?.body === "string" ? init.body : "";
    sent.push({ url, headers: { ...(init?.headers as Record<string, string> | undefined) }, body });
    if (url.endsWith("/protocol/openid-connect/token")) {
      return Promise.resolve(Response.json({ access_token: "service-token", expires_in: 300 }));
    }
    return Promise.resolve(
      Response.json({ decision: "join", linkType: "everyone", tenantId: "00000000-0000-7000-8000-000000000001", marketId: "00000000-0000-7000-8000-000000000002" }),
    );
  };
  return { fetch: fakeFetch as typeof fetch, sent };
}

describe("buildShareAdmission", () => {
  it("logs in with the client of its own and never sends the credentials or the token of the admin client", async () => {
    const config = loadConfig(environment);
    const { fetch, sent } = recordingFetch();

    const outcome = await buildShareAdmission(config, { fetch })?.admit({ token: "t".repeat(43), userEmail: null, emailVerified: false });

    expect(outcome).toMatchObject({ kind: "answered", decision: "join" });
    const tokenRequest = sent.find((request) => request.url.endsWith("/protocol/openid-connect/token"));
    const form = new URLSearchParams(tokenRequest?.body);
    expect(form.get("client_id")).toBe(MARKETS_CLIENT);
    expect(form.get("client_secret")).toBe(MARKETS_SECRET);
    expect(form.get("grant_type")).toBe("client_credentials");
    // Nothing that was sent holds the admin client: not its id, not its secret.
    const everything = JSON.stringify(sent);
    expect(everything).not.toContain(ADMIN_SECRET);
    expect(everything).not.toContain(`client_id=${ADMIN_CLIENT}&`);
    // The call to markets carries the token of that login.
    const marketsRequest = sent.find((request) => request.url.startsWith("http://markets:8080/"));
    expect(marketsRequest?.headers["authorization"]).toBe("Bearer service-token");
  });

  it("is not configured without Keycloak, markets or the client of its own (local mode)", () => {
    const local = { APP_ENV: "local" };
    expect(buildShareAdmission(loadConfig(local))).toBeNull();
    expect(buildShareAdmission(loadConfig({ ...local, MARKETS_BASE_URL: "http://localhost:8082" }))).toBeNull();
    expect(buildShareAdmission(loadConfig({ ...local, KEYCLOAK_URL: "http://localhost:8081", KEYCLOAK_REALM: "chance", KEYCLOAK_CLIENT_ID: ADMIN_CLIENT, KEYCLOAK_CLIENT_SECRET: ADMIN_SECRET }))).toBeNull();
    // The admin client's settings alone never configure it: that would send the admin token to markets.
    const { keycloak, marketsUrl } = loadConfig(environment);
    expect(buildShareAdmission({ keycloak, marketsUrl, marketsClient: null })).toBeNull();
  });
});
