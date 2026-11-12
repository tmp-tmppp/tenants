import type { Membership } from "../domain/membership.js";
import { NotFound } from "./errors.js";
import type { Store } from "./ports.js";
import { memberCursorKey, readPage } from "./support.js";
import type { PageInput, PageOf } from "./support.js";

export class ListMembers {
  constructor(private readonly store: Store) {}

  async execute(input: PageInput & { tenantId: string }): Promise<PageOf<Membership>> {
    const { repositories } = this.store;
    if (!(await repositories.tenants.findById(input.tenantId))) throw new NotFound("tenant_not_found", "Tenant not found");
    return readPage(
      input,
      (limit, after) => repositories.memberships.list(input.tenantId, limit, after),
      (member) => ({ at: member.joinedAt, key: member.userId }),
      memberCursorKey,
    );
  }
}
