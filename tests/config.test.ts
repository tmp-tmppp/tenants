import { describe, expect, it } from "vitest";
import { ConfigError, MAX_SHUTDOWN_DELAY_MS, loadConfig } from "../src/config.js";

const production = {
  DATABASE_URL: "postgres://app:pw@db:5432/tenants",
  NATS_URL: "nats://nats:4222",
  KEYCLOAK_URL: "http://keycloak:8080",
  KEYCLOAK_REALM: "chance",
  KEYCLOAK_CLIENT_ID: "tenants",
  KEYCLOAK_CLIENT_SECRET: "client-pw",
  MARKETS_BASE_URL: "http://markets:8080",
  MARKETS_ADMISSION_CLIENT_ID: "tenants-markets",
  MARKETS_ADMISSION_CLIENT_SECRET: "markets-client-pw",
  AUTH_JWKS_URL: "http://keycloak:8080/realms/chance/protocol/openid-connect/certs",
  AUTH_ISSUER: "http://keycloak:8080/realms/chance",
  AUTH_AUDIENCE: "chance",
};

const problemsOf = (env: NodeJS.ProcessEnv): string[] => {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return [...error.problems];
    throw error;
  }
  return [];
};

describe("loadConfig", () => {
  it("reads a complete production configuration and applies the defaults", () => {
    const config = loadConfig(production);
    expect(config).toMatchObject({
      appEnv: "production",
      isLocal: false,
      port: 8080,
      logLevel: "info",
      databaseUrl: production.DATABASE_URL,
      databasePoolMax: 5,
      natsUrl: production.NATS_URL,
      keycloak: { url: "http://keycloak:8080", realm: "chance", clientId: "tenants", clientSecret: "client-pw" },
      marketsUrl: "http://markets:8080",
      adminInviteTtlHours: 168,
      outboxPollMs: 300,
      streamMaxAgeDays: 30,
      identitySyncPollMs: 500,
      shutdownDelayMs: 5000,
      metricsPort: 9464,
      auth: { rolesClaim: "realm_access.roles", tenantClaim: "organization", audience: "chance" },
    });
  });

  it("reads overrides", () => {
    const config = loadConfig({
      ...production,
      APP_ENV: "dev",
      PORT: "9000",
      LOG_LEVEL: "debug",
      DATABASE_POOL_MAX: "3",
      INVITE_ADMIN_TTL_HOURS: "24",
      OUTBOX_POLL_MS: "1000",
      STREAM_MAX_AGE_DAYS: "45",
      IDENTITY_SYNC_POLL_MS: "2000",
      SHUTDOWN_DELAY_MS: "8000",
      AUTH_ROLES_CLAIM: "roles",
      AUTH_TENANT_CLAIM: "tenant",
    });
    expect(config).toMatchObject({
      appEnv: "dev",
      isLocal: false,
      port: 9000,
      logLevel: "debug",
      databasePoolMax: 3,
      adminInviteTtlHours: 24,
      outboxPollMs: 1000,
      streamMaxAgeDays: 45,
      identitySyncPollMs: 2000,
      shutdownDelayMs: 8000,
      auth: { rolesClaim: "roles", tenantClaim: "tenant" },
    });
  });

  describe("METRICS_PORT (the listener that serves GET /metrics)", () => {
    it("defaults to 9464, also in local mode", () => {
      expect(loadConfig(production).metricsPort).toBe(9464);
      expect(loadConfig({ APP_ENV: "local" }).metricsPort).toBe(9464);
    });

    it("takes a port from 1 to 65535", () => {
      expect(loadConfig({ ...production, METRICS_PORT: "9100" }).metricsPort).toBe(9100);
      expect(loadConfig({ ...production, METRICS_PORT: "1" }).metricsPort).toBe(1);
      expect(loadConfig({ ...production, METRICS_PORT: "65535" }).metricsPort).toBe(65_535);
    });

    it.each(["0", "65536", "-1", "9464.5", "abc"])("rejects %s", (value) => {
      expect(problemsOf({ ...production, METRICS_PORT: value })).toEqual(["METRICS_PORT must be an integer from 1 to 65535"]);
    });

    it("must differ from PORT: the API port never serves /metrics", () => {
      const problem = "METRICS_PORT must differ from PORT (the API port never serves /metrics)";
      expect(problemsOf({ ...production, PORT: "9000", METRICS_PORT: "9000" })).toEqual([problem]);
      expect(problemsOf({ ...production, PORT: "9464" })).toEqual([problem]);
      expect(loadConfig({ ...production, PORT: "9464", METRICS_PORT: "9465" })).toMatchObject({ port: 9464, metricsPort: 9465 });
    });
  });

  describe("SHUTDOWN_DELAY_MS (the drain between SIGTERM and closing the server)", () => {
    it("is 5 seconds by default and 0 in a local run, where nobody routes traffic", () => {
      expect(loadConfig(production).shutdownDelayMs).toBe(5000);
      expect(loadConfig({ APP_ENV: "local" }).shutdownDelayMs).toBe(0);
    });

    it("allows 0 outside local mode, and an explicit value in local mode", () => {
      expect(loadConfig({ ...production, SHUTDOWN_DELAY_MS: "0" }).shutdownDelayMs).toBe(0);
      expect(loadConfig({ APP_ENV: "local", SHUTDOWN_DELAY_MS: "2000" }).shutdownDelayMs).toBe(2000);
      expect(loadConfig({ ...production, SHUTDOWN_DELAY_MS: "15000" }).shutdownDelayMs).toBe(15_000);
    });

    it.each(["-1", "15001", "5.5", "five", "1e3x", "NaN"])("rejects %j like the other integers", (value) => {
      expect(problemsOf({ ...production, SHUTDOWN_DELAY_MS: value })).toEqual(["SHUTDOWN_DELAY_MS must be an integer from 0 to 15000"]);
    });

    it("leaves the drain and the shutdown inside the 30 seconds the chart gives a pod", () => {
      expect(MAX_SHUTDOWN_DELAY_MS + 10_000).toBeLessThanOrEqual(30_000);
    });
  });

  it("stops with one clear message per missing setting outside local mode", () => {
    const problems = problemsOf({});
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining("DATABASE_URL is required"),
        expect.stringContaining("NATS_URL is required"),
        expect.stringContaining("KEYCLOAK_URL is required"),
        expect.stringContaining("MARKETS_BASE_URL is required"),
        expect.stringContaining("AUTH_JWKS_URL is required"),
        expect.stringContaining("AUTH_ISSUER is required"),
        expect.stringContaining("AUTH_AUDIENCE is required"),
      ]),
    );
    expect(() => loadConfig({})).toThrowError(/Invalid configuration/);
  });

  it("allows a bare APP_ENV=local run with in-memory adapters, but still verifies tokens", () => {
    const config = loadConfig({ APP_ENV: "local" });
    expect(config).toMatchObject({ isLocal: true, databaseUrl: null, natsUrl: null, keycloak: null });
    expect(config.auth.jwksUrl).toMatch(/^http:\/\/localhost:/);
    expect(config.auth.issuer).toBeTruthy();
  });

  it("needs MARKETS_BASE_URL outside local mode, where it may stay unset (share joins then answer 503)", () => {
    const { MARKETS_BASE_URL: _unset, ...withoutMarkets } = production;
    expect(problemsOf(withoutMarkets)).toEqual([expect.stringContaining("MARKETS_BASE_URL is required")]);
    expect(loadConfig({ ...withoutMarkets, APP_ENV: "local" }).marketsUrl).toBeNull();
    expect(loadConfig({ APP_ENV: "local", MARKETS_BASE_URL: "http://localhost:8082" }).marketsUrl).toBe("http://localhost:8082");
    expect(problemsOf({ ...production, MARKETS_BASE_URL: "ftp://markets" })).toEqual([expect.stringContaining("MARKETS_BASE_URL must be a URL")]);
  });

  it("needs a client of its own for the calls to markets, and never the admin client", () => {
    expect(loadConfig(production).marketsClient).toEqual({ clientId: "tenants-markets", clientSecret: "markets-client-pw" });
    const { MARKETS_ADMISSION_CLIENT_ID: _id, MARKETS_ADMISSION_CLIENT_SECRET: _secret, ...without } = production;
    expect(problemsOf(without)).toEqual([
      "MARKETS_ADMISSION_CLIENT_ID is required when KEYCLOAK_URL and MARKETS_BASE_URL are set",
      "MARKETS_ADMISSION_CLIENT_SECRET is required when KEYCLOAK_URL and MARKETS_BASE_URL are set",
    ]);
    expect(problemsOf({ ...production, MARKETS_ADMISSION_CLIENT_ID: "tenants" })).toEqual([expect.stringContaining("must be another client than KEYCLOAK_CLIENT_ID")]);
    // Without Keycloak (local mode) there is no token to ask for, so the client is not asked for either.
    const { KEYCLOAK_URL: _url, KEYCLOAK_REALM: _realm, KEYCLOAK_CLIENT_ID: _cid, KEYCLOAK_CLIENT_SECRET: _csecret, ...noKeycloak } = without;
    expect(loadConfig({ ...noKeycloak, APP_ENV: "local" }).marketsClient).toBeNull();
  });

  it("requires the other Keycloak settings once KEYCLOAK_URL is set, also in local mode", () => {
    expect(problemsOf({ APP_ENV: "local", KEYCLOAK_URL: "http://localhost:8081" })).toEqual([
      "KEYCLOAK_REALM is required when KEYCLOAK_URL is set",
      "KEYCLOAK_CLIENT_ID is required when KEYCLOAK_URL is set",
      "KEYCLOAK_CLIENT_SECRET is required when KEYCLOAK_URL is set",
    ]);
  });

  it("rejects bad values without printing them", () => {
    const secretUrl = "mysql://user:hunter2@db/x";
    const problems = problemsOf({ ...production, DATABASE_URL: secretUrl, PORT: "99999", LOG_LEVEL: "loud", OUTBOX_POLL_MS: "fast", STREAM_MAX_AGE_DAYS: "0", IDENTITY_SYNC_POLL_MS: "10", NATS_URL: "http://nats" });
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining("DATABASE_URL must be a URL"),
        expect.stringContaining("PORT must be an integer"),
        expect.stringContaining("LOG_LEVEL must be one of"),
        expect.stringContaining("OUTBOX_POLL_MS must be an integer"),
        expect.stringContaining("STREAM_MAX_AGE_DAYS must be an integer from 1 to 365"),
        expect.stringContaining("IDENTITY_SYNC_POLL_MS must be an integer from 50 to 60000"),
        expect.stringContaining("NATS_URL must be a URL"),
      ]),
    );
    expect(problems.join("\n")).not.toContain("hunter2");
  });

  it("treats an empty value as missing and rejects a bad APP_ENV", () => {
    expect(problemsOf({ ...production, DATABASE_URL: "  " })).toEqual([expect.stringContaining("DATABASE_URL is required")]);
    expect(problemsOf({ ...production, APP_ENV: "Prod Env" })).toEqual([expect.stringContaining("APP_ENV")]);
  });
});
