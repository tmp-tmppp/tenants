import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { KeycloakIdentityProvider } from "../../src/adapters/keycloak/keycloak-identity-provider.js";

// The Keycloak adapter against a real Keycloak with the realm of the identity repository. Opt-in, because it needs
// that server running: in identity/, "docker compose up -d --build", then
//   KEYCLOAK_TEST_URL=http://localhost:8081 KEYCLOAK_TEST_CLIENT_SECRET=<tenants client secret> \
//   KEYCLOAK_TEST_ADMIN_USERNAME=<bootstrap admin> KEYCLOAK_TEST_ADMIN_PASSWORD=<its password> npm run test:integration
const env = {
  url: process.env["KEYCLOAK_TEST_URL"],
  secret: process.env["KEYCLOAK_TEST_CLIENT_SECRET"],
  admin: process.env["KEYCLOAK_TEST_ADMIN_USERNAME"],
  adminPassword: process.env["KEYCLOAK_TEST_ADMIN_PASSWORD"],
};
const configured = Boolean(env.url && env.secret && env.admin && env.adminPassword);

type Json = Record<string, unknown>;

async function adminToken(): Promise<string> {
  const response = await fetch(`${env.url}/realms/master/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "password", client_id: "admin-cli", username: env.admin ?? "", password: env.adminPassword ?? "" }),
  });
  return ((await response.json()) as Json)["access_token"] as string;
}

async function admin(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown; location: string | null }> {
  const response = await fetch(`${env.url}/admin/realms/chance${path}`, {
    method,
    headers: { authorization: `Bearer ${await adminToken()}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, json: text ? (JSON.parse(text) as unknown) : null, location: response.headers.get("location") };
}

describe.runIf(configured)("KeycloakIdentityProvider against a real Keycloak", () => {
  const provider = new KeycloakIdentityProvider({
    baseUrl: env.url ?? "",
    realm: "chance",
    clientId: "tenants",
    clientSecret: env.secret ?? "",
  });

  // What the tests create, noted before it is created, so that the cleanup finds it also when a test failed half-way.
  const createdUsers: string[] = [];
  const createdOrganizations: string[] = [];

  // Removes the organizations (found by alias, which is the tenant id) and the users the tests created. A failure
  // does not stop the rest of the cleanup, but it fails the run, so a leftover is never silent.
  afterAll(async () => {
    const leftovers: string[] = [];
    for (const alias of createdOrganizations) {
      try {
        const found = await admin("GET", `/organizations?search=${alias}&exact=true`);
        const matching = (Array.isArray(found.json) ? (found.json as Json[]) : []).filter((organization) => organization["alias"] === alias);
        for (const organization of matching) {
          const removed = await admin("DELETE", `/organizations/${String(organization["id"])}`);
          if (removed.status !== 204) leftovers.push(`organization ${alias} (HTTP ${removed.status})`);
        }
      } catch (error) {
        leftovers.push(`organization ${alias} (${error instanceof Error ? error.message : "unknown error"})`);
      }
    }
    for (const userId of createdUsers) {
      try {
        const removed = await admin("DELETE", `/users/${userId}`);
        if (removed.status !== 204 && removed.status !== 404) leftovers.push(`user ${userId} (HTTP ${removed.status})`);
      } catch (error) {
        leftovers.push(`user ${userId} (${error instanceof Error ? error.message : "unknown error"})`);
      }
    }
    if (leftovers.length > 0) throw new Error(`The test left data in Keycloak: ${leftovers.join(", ")}`);
  });

  it("creates the organization once, adds the member once and switches the role", async () => {
    const tenantId = randomUUID();
    createdOrganizations.push(tenantId);
    const created = await admin("POST", "/users", {
      username: `adapter-${tenantId.slice(0, 8)}`,
      email: `adapter-${tenantId.slice(0, 8)}@example.com`,
      firstName: "Adapter",
      lastName: "Test",
      enabled: true,
    });
    expect(created.status).toBe(201);
    const userId = created.location?.split("/").pop() ?? "";
    if (userId) createdUsers.push(userId);

    await provider.ensureOrganization(tenantId, "Acme");
    await provider.ensureOrganization(tenantId, "Acme");
    const organizations = (await admin("GET", `/organizations?search=${tenantId}&exact=true`)).json as Json[];
    expect(organizations).toHaveLength(1);
    expect(organizations[0]?.["alias"]).toBe(tenantId);
    const organizationId = organizations[0]?.["id"] as string;

    await provider.addMember(tenantId, userId);
    await provider.addMember(tenantId, userId);
    expect((await admin("GET", `/organizations/${organizationId}/members/${userId}`)).status).toBe(200);

    // The organization has its two role groups; a role is the membership in exactly one of them.
    const groupNames = async () =>
      ((await admin("GET", `/organizations/${organizationId}/members/${userId}/groups`)).json as Json[]).map((group) => group["name"]).sort();
    await provider.setRole(tenantId, userId, "trader");
    expect(await groupNames()).toEqual(["trader"]);
    await provider.setRole(tenantId, userId, "tenant-admin");
    await provider.setRole(tenantId, userId, "tenant-admin");
    expect(await groupNames()).toEqual(["tenant-admin"]);
    // No realm role and no role mapping carries a tenant role any more.
    const roles = ((await admin("GET", `/users/${userId}/role-mappings/realm`)).json as Json[]).map((role) => role["name"]);
    expect(roles).not.toContain("tenant-admin");
    expect(roles).not.toContain("trader");
  });
});
