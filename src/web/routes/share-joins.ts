import type { FastifyInstance } from "fastify";
import { requireAuth } from "../auth.js";
import type { RequestHook } from "../auth.js";
import { callerOf } from "../context.js";
import type { UseCases } from "../context.js";
import { schemas } from "../schemas.js";

/**
 * Joining the organization of a shared market. Any valid token, with or without an organization: the organization
 * comes from the share link (asked of markets), not from the token. The share-link token is in the body and is never
 * written to a log: the request logger of the service logs the method and the path only, and nothing here adds it.
 */
export function registerShareJoinRoutes(app: FastifyInstance, useCases: UseCases, authenticate: RequestHook): void {
  app.post<{ Body: { token: string } }>(
    "/v1/share-joins",
    { schema: schemas.shareJoin, onRequest: authenticate },
    async (request) => {
      const auth = requireAuth(request);
      return useCases.shareJoin.execute({
        token: request.body.token,
        email: auth.email,
        emailVerified: auth.emailVerified,
        caller: callerOf(request),
      });
    },
  );
}
