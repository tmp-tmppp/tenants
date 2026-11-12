import type { FastifyInstance } from "fastify";
import type { RequestHook } from "../auth.js";
import { callerOf } from "../context.js";
import type { UseCases } from "../context.js";
import { schemas } from "../schemas.js";

export function registerInviteRoutes(app: FastifyInstance, useCases: UseCases, authenticate: RequestHook): void {
  // Any valid token: the user has no tenant yet, so the tenant comes from the invite, not from the token.
  app.post<{ Params: { code: string } }>(
    "/v1/invites/:code/accept",
    { schema: schemas.acceptInvite, onRequest: authenticate },
    async (request) => {
      return useCases.acceptInvite.execute({ code: request.params.code, caller: callerOf(request) });
    },
  );
}
