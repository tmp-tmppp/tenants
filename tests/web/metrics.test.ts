import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMetrics } from "../../src/adapters/metrics/metrics.js";
import type { Metrics } from "../../src/adapters/metrics/metrics.js";
import { createHarness } from "../support/harness.js";
import { tenantOfRequest } from "../../src/web/auth.js";

// The metrics wired into the real application the way src/main.ts wires them: the tenant label is the tenant of the
// token that the service verified. The convention itself is tested in tests/adapters/metrics.test.ts.

type Harness = Awaited<ReturnType<typeof createHarness>>;

// The tenant id of the platform is a UUID: the alias of the token's organization.
const ACME = "00000000-0000-7000-8000-0000000000a1";

let metrics: Metrics;
let h: Harness;
beforeAll(async () => {
  metrics = createMetrics({ tenantOf: tenantOfRequest });
  h = await createHarness({ metrics });
});
afterAll(async () => {
  await h.app.close();
});

async function counter(labels: Record<string, string>): Promise<number> {
  const metric = metrics.registry.getSingleMetric("http_requests_total");
  const values = metric ? (await metric.get()).values : [];
  return values.filter((sample) => Object.entries(labels).every(([key, value]) => sample.labels[key] === value)).reduce((sum, sample) => sum + sample.value, 0);
}

describe("the metrics of the real application", () => {
  it("counts a request of a tenant under the template of its route and the tenant of its token", async () => {
    const headers = await h.bearer({ sub: "user-7", organization: [ACME], roles: ["tenant-admin"] });
    const response = await h.app.inject({ method: "GET", url: `/v1/tenants/${ACME}/members`, headers });
    expect(await counter({ method: "GET", route: "/v1/tenants/:id/members", status_code: String(response.statusCode), tenant: ACME })).toBe(1);
  });

  it("uses the template for a route with two path parameters, never the user id", async () => {
    const headers = await h.bearer({ sub: "user-7", organization: [ACME], roles: ["tenant-admin"] });
    const response = await h.app.inject({ method: "PUT", url: `/v1/tenants/${ACME}/members/user-from-the-url/role`, headers, payload: { role: "trader" } });
    expect(await counter({ method: "PUT", route: "/v1/tenants/:id/members/:userId/role", status_code: String(response.statusCode), tenant: ACME })).toBe(1);
    expect(await metrics.registry.metrics()).not.toContain("user-from-the-url");
  });

  it("counts a refused request under the tenant of the token that was verified", async () => {
    const headers = await h.bearer({ sub: "user-8", organization: [ACME], roles: ["trader"] });
    const response = await h.app.inject({ method: "POST", url: "/v1/tenants", headers, payload: { name: "Other", slug: "other" } });
    expect(response.statusCode).toBe(403);
    expect(await counter({ method: "POST", route: "/v1/tenants", status_code: "403", tenant: ACME })).toBe(1);
  });

  it('counts a request without a token as 401 for the tenant "none"', async () => {
    const response = await h.app.inject({ method: "GET", url: "/v1/me" });
    expect(response.statusCode).toBe(401);
    expect(await counter({ method: "GET", route: "/v1/me", status_code: "401", tenant: "none" })).toBe(1);
  });

  it("counts the probes under their own routes", async () => {
    expect((await h.app.inject({ method: "GET", url: "/health/live" })).statusCode).toBe(200);
    expect(await counter({ method: "GET", route: "/health/live", status_code: "200", tenant: "none" })).toBe(1);
  });

  it('does not serve /metrics on the API port: the answer is a 404 counted as "unmatched"', async () => {
    const response = await h.app.inject({ method: "GET", url: "/metrics" });
    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain("http_requests_total");
    expect(await counter({ method: "GET", route: "unmatched", status_code: "404", tenant: "none" })).toBe(1);
  });

  it("answers the same without the metrics: the hook is optional", async () => {
    const plain = await createHarness();
    expect((await plain.app.inject({ method: "GET", url: "/health/live" })).statusCode).toBe(200);
    await plain.app.close();
  });
});
