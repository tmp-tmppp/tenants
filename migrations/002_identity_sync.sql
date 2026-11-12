-- Queue of identity-sync items (ADR-054). The database is the source of truth; a background reconciler inside the
-- service makes the identity provider match it. A request writes its change, its event and one item here in
-- one transaction; the reconciler claims due items, reads the current rows and repairs the provider with
-- idempotent calls.
--
-- One row per thing to reconcile: key "tenant/<tenantId>" (the organization exists) or "member/<userId>" (the user
-- is a member of the organization of its row and holds exactly the role of its row). Enqueuing a key that is
-- already queued bumps its version and makes it due at once. A finished item is deleted only if its version is
-- the one that was processed, so a change that arrived meanwhile keeps its row.

CREATE TABLE shared.identity_sync (
    key        text        PRIMARY KEY,
    kind       text        NOT NULL CONSTRAINT identity_sync_kind_values CHECK (kind IN ('tenant', 'member')),
    -- The tenant id or the user id that the key names.
    target     text        NOT NULL,
    version    bigint      NOT NULL DEFAULT 1,
    -- Due when this time has passed. A claim moves it forward to the end of the lease, a failure to the retry time.
    due_at     timestamptz NOT NULL,
    attempts   integer     NOT NULL DEFAULT 0,
    last_error text,
    created_at timestamptz NOT NULL,
    -- The last enqueue, that is the last change of the desired state.
    updated_at timestamptz NOT NULL
);

CREATE INDEX identity_sync_due_idx ON shared.identity_sync (due_at);
