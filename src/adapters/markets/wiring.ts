import type { Config } from "../../config.js";
import type { ShareAdmission } from "../../usecases/ports.js";
import { MarketsClient } from "./markets-client.js";
import { ClientCredentialsTokenSource } from "./service-token.js";

/**
 * The share-admission client for markets, or null when it is not configured (APP_ENV=local only). It logs in to
 * Keycloak with the client of MARKETS_ADMISSION_CLIENT_ID: a client of its own with the audience "chance" and no Admin
 * API role. The credentials of the admin client (config.keycloak.clientId) are never used here: its service account
 * may manage users and organizations, so its token must not be sent to any other service, where every proxy and
 * every trace that records headers would see a bearer the Admin API accepts.
 */
export function buildShareAdmission(
  config: Pick<Config, "keycloak" | "marketsUrl" | "marketsClient">,
  options: { fetch?: typeof fetch } = {},
): ShareAdmission | null {
  if (!config.keycloak || !config.marketsUrl || !config.marketsClient) return null;
  const withFetch = options.fetch ? { fetch: options.fetch } : {};
  return new MarketsClient({
    baseUrl: config.marketsUrl,
    tokens: new ClientCredentialsTokenSource({
      keycloakUrl: config.keycloak.url,
      realm: config.keycloak.realm,
      clientId: config.marketsClient.clientId,
      clientSecret: config.marketsClient.clientSecret,
      ...withFetch,
    }),
    ...withFetch,
  });
}
