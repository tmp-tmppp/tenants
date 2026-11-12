-- A user may belong to several tenants (organizations): one membership per (user, tenant), each with its own role.
--
-- In 001 the table had a second unique constraint on user_id alone ("a user belongs to one tenant only"). It goes away.
-- The primary key (tenant_id, user_id) stays and is what makes a membership unique per (user, tenant): joining the
-- same tenant twice is still refused by the database. The new index serves "the organizations of a user" (ordered by
-- joined_at, tenant_id, the order of GET /v1/me/organizations) and the reconciler's read of all memberships of a user.

ALTER TABLE shared.memberships DROP CONSTRAINT memberships_user_id_key;

CREATE INDEX memberships_user_idx ON shared.memberships (user_id, joined_at, tenant_id);

-- Roles are now the groups "tenant-admin" and "trader" of the user's organization in the identity provider, no longer
-- realm roles. Whatever exists in the provider was made for the old design, so every tenant and every member is queued
-- once more: the reconciler creates the two groups of each organization and puts each member in the group of the role
-- (ADR-054). The realm roles that members still hold are ignored by the services and are not touched.
--
-- Key shapes as in 002: "tenant/<tenantId>" and "member/<userId>" (one item per user, which reconciles all of the user's
-- memberships). A key that is queued already keeps its row and gets a new version, as an enqueue does.

INSERT INTO shared.identity_sync (key, kind, target, version, due_at, attempts, last_error, created_at, updated_at)
SELECT 'tenant/' || id::text, 'tenant', id::text, nextval('shared.identity_sync_version_seq'), now(), 0, NULL, now(), now()
  FROM shared.tenants
ON CONFLICT (key) DO UPDATE
  SET version = nextval('shared.identity_sync_version_seq'), due_at = EXCLUDED.due_at, attempts = 0, last_error = NULL, updated_at = EXCLUDED.updated_at;

INSERT INTO shared.identity_sync (key, kind, target, version, due_at, attempts, last_error, created_at, updated_at)
SELECT 'member/' || user_id, 'member', user_id, nextval('shared.identity_sync_version_seq'), now(), 0, NULL, now(), now()
  FROM (SELECT DISTINCT user_id FROM shared.memberships) AS users
ON CONFLICT (key) DO UPDATE
  SET version = nextval('shared.identity_sync_version_seq'), due_at = EXCLUDED.due_at, attempts = 0, last_error = NULL, updated_at = EXCLUDED.updated_at;
