-- Versions of identity-sync items come from one sequence (ADR-054). In 002 every key counted its own versions from 1,
-- so a key that was finished (row deleted) and queued again started at version 1 once more. A worker whose lease had
-- run out could then finish the old claim with version 1 and delete the new row, which had version 1 too, and the
-- change it carried was lost. With one shared sequence a version is never issued twice, so a late completion or
-- failure of an old claim matches no row of a newer enqueue.
--
-- The sequence is owned by the column: dropping the table drops it, and TRUNCATE ... RESTART IDENTITY (tests) resets it.
-- It starts above the highest version in the table, so no queued row can be hit by a version issued from now on.
-- Gaps are fine (a rolled-back enqueue still used a number); only "never reused" and "increasing" matter.

CREATE SEQUENCE shared.identity_sync_version_seq AS bigint OWNED BY shared.identity_sync.version;

SELECT setval('shared.identity_sync_version_seq', COALESCE((SELECT max(version) FROM shared.identity_sync), 0) + 1, false);

ALTER TABLE shared.identity_sync ALTER COLUMN version SET DEFAULT nextval('shared.identity_sync_version_seq');
