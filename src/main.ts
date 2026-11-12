import { createRemoteJWKSet } from "jose";
import type pg from "pg";
import { FakeIdentityProvider } from "./adapters/memory/fake-identity-provider.js";
import { MemoryEventPublisher } from "./adapters/memory/memory-publisher.js";
import { MemoryStore } from "./adapters/memory/memory-store.js";
import { IdentitySyncWorker } from "./adapters/identity-sync/worker.js";
import { KeycloakIdentityProvider } from "./adapters/keycloak/keycloak-identity-provider.js";
import { unconfiguredShareAdmission } from "./adapters/markets/service-token.js";
import { buildShareAdmission } from "./adapters/markets/wiring.js";
import { createMetrics, startMetricsServer } from "./adapters/metrics/metrics.js";
import { tenantOfRequest } from "./web/auth.js";
import { NatsEventPublisher } from "./adapters/nats/nats-event-publisher.js";
import { OutboxRelay } from "./adapters/outbox/relay.js";
import { runMigrations } from "./adapters/postgres/migrate.js";
import { PostgresStore, createPool } from "./adapters/postgres/postgres-store.js";
import { DAY_MS } from "./adapters/retention.js";
import { randomIds, systemClock } from "./adapters/system.js";
import { ConfigError, loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { createShutdown } from "./shutdown.js";
import { AcceptInvite } from "./usecases/accept-invite.js";
import { ChangeMemberRole } from "./usecases/change-member-role.js";
import { CreateInvite } from "./usecases/create-invite.js";
import { CreateTenant } from "./usecases/create-tenant.js";
import { GetMe } from "./usecases/get-me.js";
import { ListMembers } from "./usecases/list-members.js";
import { ListMyOrganizations } from "./usecases/list-my-organizations.js";
import { ListTenants } from "./usecases/list-tenants.js";
import type { EventPublisher, IdentityProvider, ShareAdmission, Store } from "./usecases/ports.js";
import { ReconcileIdentity } from "./usecases/reconcile-identity.js";
import { ShareJoin } from "./usecases/share-join.js";
import { buildApp } from "./web/app.js";

// Composition root: configuration -> adapters -> use cases -> web application. Nothing else wires things together.

const MIGRATION_ATTEMPTS = 10;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
  const logger = createLogger(config.logLevel);
  logger.info({ appEnv: config.appEnv }, "Starting tenants");

  // Adapters. Without a setting, only APP_ENV=local falls back to memory; loadConfig has refused anything else.
  let store: Store;
  let pool: pg.Pool | null = null;
  if (config.databaseUrl) {
    pool = createPool(config.databaseUrl, config.databasePoolMax);
    pool.on("error", (error) => logger.error({ err: error }, "An idle database connection failed"));
    for (let attempt = 1; ; attempt += 1) {
      try {
        await runMigrations(pool, logger);
        break;
      } catch (error) {
        if (attempt >= MIGRATION_ATTEMPTS) throw error;
        logger.warn({ attempt, err: error }, "The database is not ready for migrations, trying again");
        await sleep(3000);
      }
    }
    store = new PostgresStore(pool);
  } else {
    logger.warn({}, "DATABASE_URL is not set: keeping all data in memory (APP_ENV=local)");
    store = new MemoryStore();
  }

  let publisher: EventPublisher;
  let nats: NatsEventPublisher | null = null;
  if (config.natsUrl) {
    nats = new NatsEventPublisher(config.natsUrl, logger, config.streamMaxAgeDays * DAY_MS);
    publisher = nats;
    // The service starts without the broker; events wait in the outbox until it answers.
    nats.ready().catch((error: unknown) => logger.warn({ err: error }, "NATS is not reachable yet; events wait in the outbox"));
  } else {
    logger.warn({}, "NATS_URL is not set: events are only logged (APP_ENV=local)");
    publisher = new MemoryEventPublisher(logger);
  }

  let identity: IdentityProvider;
  if (config.keycloak) {
    identity = new KeycloakIdentityProvider({
      baseUrl: config.keycloak.url,
      realm: config.keycloak.realm,
      clientId: config.keycloak.clientId,
      clientSecret: config.keycloak.clientSecret,
    });
  } else {
    logger.warn({}, "KEYCLOAK_URL is not set: using a fake identity provider (APP_ENV=local)");
    identity = new FakeIdentityProvider();
  }

  // Markets answers the admission question of share links. Its internal call logs in with the client of
  // MARKETS_ADMISSION_CLIENT_ID, never with the admin client above; without the settings (APP_ENV=local only) every
  // share link is answered "unavailable".
  const marketsAdmission = buildShareAdmission(config);
  if (!marketsAdmission) {
    logger.warn({}, "MARKETS_BASE_URL, KEYCLOAK_URL or MARKETS_ADMISSION_CLIENT_ID is not set: share links cannot be checked (APP_ENV=local)");
  }
  const shareAdmission: ShareAdmission = marketsAdmission ?? unconfiguredShareAdmission;

  // Use cases.
  const deps = { store, clock: systemClock, ids: randomIds, logger };
  const useCases = {
    createTenant: new CreateTenant(deps, config.adminInviteTtlHours),
    listTenants: new ListTenants(store),
    getMe: new GetMe(store),
    listMyOrganizations: new ListMyOrganizations(store),
    shareJoin: new ShareJoin(deps, shareAdmission),
    createInvite: new CreateInvite(deps),
    listMembers: new ListMembers(store),
    changeMemberRole: new ChangeMemberRole(deps),
    acceptInvite: new AcceptInvite(deps),
  };

  // True from the first SIGTERM on; the readiness probe reads it.
  let shuttingDown = false;

  // Request metrics; the tenant label is the tenant of the verified token (request.auth is set only after the check).
  const metrics = createMetrics({ tenantOf: tenantOfRequest });

  const app = buildApp({
    logger,
    metrics,
    useCases,
    auth: {
      issuer: config.auth.issuer,
      audience: config.auth.audience,
      getKey: createRemoteJWKSet(new URL(config.auth.jwksUrl), { timeoutDuration: 3000 }),
      rolesClaim: config.auth.rolesClaim,
      tenantClaim: config.auth.tenantClaim,
    },
    health: { ping: () => store.ping(), isDraining: () => shuttingDown },
  });
  // Background loops: the relay publishes the outbox, the identity-sync worker makes the identity provider match the
  // database (ADR-054). Requests never call the identity provider.
  const relay = new OutboxRelay({ store, publisher, clock: systemClock, logger, pollMs: config.outboxPollMs, retentionMs: config.streamMaxAgeDays * DAY_MS });
  const identitySync = new IdentitySyncWorker({
    store,
    reconcile: new ReconcileIdentity({ store, identity }),
    clock: systemClock,
    logger,
    pollMs: config.identitySyncPollMs,
  });

  // GET /metrics has a listener of its own: the API port never serves it, so the gateway can never route it.
  const metricsServer = await startMetricsServer(metrics.registry, { port: config.metricsPort });
  logger.info({ port: metricsServer.port }, "Serving metrics");
  await app.listen({ host: "0.0.0.0", port: config.port });
  relay.start();
  identitySync.start();

  // Graceful shutdown (SIGTERM from Kubernetes, SIGINT from a terminal): src/shutdown.ts has the order and the timing.
  const shutdown = createShutdown(
    {
      drain: () => {
        shuttingDown = true;
      },
      closeServer: async () => {
        await app.close();
        await metricsServer.close();
      },
      stopRelay: () => relay.stop(),
      stopIdentitySync: () => identitySync.stop(),
      closeEvents: async () => {
        await nats?.close();
      },
      closeDatabase: async () => {
        await pool?.end();
      },
    },
    { logger, delayMs: config.shutdownDelayMs, exit: (code) => process.exit(code) },
  );
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((error: unknown) => {
  console.error("tenants failed to start:", error instanceof Error ? error.message : error);
  process.exit(1);
});
