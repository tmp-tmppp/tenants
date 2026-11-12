import type { Tenant } from "../domain/tenant.js";
import type { Store } from "./ports.js";
import { readPage, tenantCursorKey } from "./support.js";
import type { PageInput, PageOf } from "./support.js";

export class ListTenants {
  constructor(private readonly store: Store) {}

  execute(input: PageInput): Promise<PageOf<Tenant>> {
    return readPage(
      input,
      (limit, after) => this.store.repositories.tenants.list(limit, after),
      (tenant) => ({ at: tenant.createdAt, key: tenant.id }),
      tenantCursorKey,
    );
  }
}
