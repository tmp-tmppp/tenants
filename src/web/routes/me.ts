import type { FastifyInstance } from "fastify";
import type { RequestHook } from "../auth.js";
import { requireAuth } from "../auth.js";
import type { UseCases } from "../context.js";
import { schemas } from "../schemas.js";

export function registerMeRoutes(app: FastifyInstance, useCases: UseCases, authenticate: RequestHook): void {
  app.get("/v1/me", { schema: schemas.getMe, onRequest: authenticate }, async (request) => {
    const auth = requireAuth(request);
    return useCases.getMe.execute({ userId: auth.userId, tokenTenantId: auth.tenantId, tokenRoles: auth.roles });
  });

  // Any valid token, with or without an organization: a user finds the organizations to sign in to here.
  app.get<{ Querystring: { limit?: number; cursor?: string } }>(
    "/v1/me/organizations",
    { schema: schemas.listMyOrganizations, onRequest: authenticate },
    async (request) => {
      const page = await useCases.listMyOrganizations.execute({
        userId: requireAuth(request).userId,
        limit: request.query.limit,
        cursor: request.query.cursor,
      });
      return {
        items: page.items.map((item) => ({ ...item, joinedAt: item.joinedAt.toISOString() })),
        nextCursor: page.nextCursor,
        identityPending: page.identityPending,
      };
    },
  );
}
