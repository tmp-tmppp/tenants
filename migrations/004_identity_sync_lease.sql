-- The lease of an identity-sync item gets its own column (ADR-054). In 002 a claim leased an item by moving due_at to the
-- end of the lease, and an enqueue of the same key set due_at back to "now". A change that arrived while an item was
-- being processed therefore made the leased row claimable at once, and a second instance could reconcile the same key
-- while the first one still did: both read the database, the one that read the older row could write to the identity
-- provider last, and the user ended with the wrong role.
--
-- Now due_at only says when the item may be tried (the enqueue time, or the retry time after a failure) and lease_until
-- says that an instance works on it until then. A claim takes rows with due_at <= now AND (lease_until IS NULL OR
-- lease_until <= now) and sets lease_until; it does not move due_at. An enqueue never touches lease_until. Finishing or
-- failing an item clears the lease; when a newer version arrived meanwhile, the lease is cleared as well so that the
-- newer version is picked up at the next poll instead of after the rest of the lease.
--
-- NULL means "not leased", which is what every existing row is: a row that an older instance had leased through due_at
-- is simply due when that time has passed.

ALTER TABLE shared.identity_sync ADD COLUMN lease_until timestamptz;
