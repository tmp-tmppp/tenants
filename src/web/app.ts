import Fastify from "fastify";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type { Logger as PinoLogger } from "pino";
import { v7 as uuidv7 } from "uuid";
import { USER_ID_MAX_LENGTH } from "../usecases/support.js";
import { authenticate } from "./auth.js";
import type { AuthOptions } from "./auth.js";
import type { UseCases } from "./context.js";
import { frameworkErrorHandler, registerProblemHandlers } from "./problems.js";
import { registerHealthRoutes } from "./routes/health.js";
import type { HealthChecks } from "./routes/health.js";
import { registerInviteRoutes } from "./routes/invites.js";
import { registerMeRoutes } from "./routes/me.js";
import { registerShareJoinRoutes } from "./routes/share-joins.js";
import { registerTenantRoutes } from "./routes/tenants.js";

export interface WebDeps {
  logger: PinoLogger;
  useCases: UseCases;
  auth: AuthOptions;
  health: HealthChecks;
  /** Records the request metrics (src/adapters/metrics/metrics.ts); optional, most tests leave it out. */
  metrics?: { attach(app: FastifyInstance): void };
}

export interface RegisteredRoute {
  method: string;
  url: string;
}

declare module "fastify" {
  interface FastifyInstance {
    /** Every route that was registered, for the contract tests. */
    registeredRoutes: RegisteredRoute[];
  }
}

// Letters, digits and a few separators, so a client cannot inject anything odd into logs and headers.
const CORRELATION_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * The longest path parameter the router accepts, measured on the raw text of the URL. Fastify's default is 100, which
 * would answer a user id of 101 characters or more with a 414 before the schema looks at it. A user id may have
 * USER_ID_MAX_LENGTH code points, and a code point outside the first plane is written as up to 12 characters
 * (four percent-encoded UTF-8 bytes), so longer ids still get the 400 of the schema.
 */
const MAX_PARAM_LENGTH = 12 * USER_ID_MAX_LENGTH;

/** Builds the Fastify application (not started): tests call it with app.inject. */
export function buildApp(deps: WebDeps): FastifyInstance {
  const logger: FastifyBaseLogger = deps.logger;
  const app: FastifyInstance = Fastify({
    loggerInstance: logger,
    genReqId: () => uuidv7(),
    exposeHeadRoutes: false,
    bodyLimit: 16 * 1024,
    routerOptions: { maxParamLength: MAX_PARAM_LENGTH },
    frameworkErrors: frameworkErrorHandler,
    ajv: { customOptions: { allErrors: true, removeAdditional: false, coerceTypes: "array" } },
  });

  const registeredRoutes: RegisteredRoute[] = [];
  app.decorate("registeredRoutes", registeredRoutes);
  app.addHook("onRoute", (route) => {
    for (const method of [route.method].flat()) registeredRoutes.push({ method, url: route.url });
  });

  app.decorateRequest("auth", null);
  app.decorateRequest("correlationId", "");

  // Correlation: take X-Correlation-Id from the caller or make one, return it and bind it to the request logger.
  app.addHook("onRequest", (request, reply, done) => {
    const sent = request.headers["x-correlation-id"];
    request.correlationId = typeof sent === "string" && CORRELATION_ID.test(sent) ? sent : uuidv7();
    reply.header("x-correlation-id", request.correlationId);
    request.log = reply.log = request.log.child({ correlationId: request.correlationId });
    done();
  });

  // Before the routes, so that every response is counted, also the 404 of a path that matches no route.
  deps.metrics?.attach(app);

  registerProblemHandlers(app);

  const authHook = authenticate(deps.auth);
  registerHealthRoutes(app, deps.health);
  registerMeRoutes(app, deps.useCases, authHook);
  registerTenantRoutes(app, deps.useCases, authHook);
  registerInviteRoutes(app, deps.useCases, authHook);
  registerShareJoinRoutes(app, deps.useCases, authHook);

  return app;
}
