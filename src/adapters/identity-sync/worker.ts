import { IdentityProviderRejected, IdentityProviderUnavailable } from "../../usecases/errors.js";
import type { Clock, IdentitySyncItem, Logger, Store } from "../../usecases/ports.js";

/** What the worker needs from the reconciler (ReconcileIdentity implements it). */
export interface ItemReconciler {
  execute(item: IdentitySyncItem): Promise<void>;
}

/** Items claimed per poll. Each takes a few calls with a timeout, so five fit well inside the lease. */
export const DEFAULT_BATCH_SIZE = 5;

/** How long a claimed item belongs to this worker unless the options say otherwise. */
export const DEFAULT_LEASE_MS = 120_000;

export interface IdentitySyncWorkerOptions {
  store: Store;
  reconcile: ItemReconciler;
  clock: Clock;
  logger: Logger;
  /** Wait between polls when the queue is empty. */
  pollMs: number;
  /** Items claimed per poll. Default 5, so that a batch fits well inside the lease. */
  batchSize?: number;
  /** How long a claimed item belongs to this worker. Default 120 seconds (DEFAULT_LEASE_MS). */
  leaseMs?: number;
  /** Wait after the first failure of an item; it doubles with every further failure. Default 1 second. */
  retryInitialMs?: number;
  /** Upper bound of that wait. Default 5 minutes. */
  retryMaxMs?: number;
  /** Wait after the identity provider refused an item (retrying does not help until someone fixes the cause). Default 5 minutes. */
  rejectedRetryMs?: number;
}

export interface RunResult {
  /** Items reconciled and removed from the queue. */
  done: number;
  /** Items that failed and were scheduled for a later attempt. */
  failed: number;
  /** Items taken from the queue in this poll. */
  claimed: number;
}

/**
 * Background loop that makes the identity provider match the database (ADR-054). Every poll claims the due items of
 * the queue, runs ReconcileIdentity for each and deletes it, but only if no newer change for the same key arrived
 * meanwhile (the store compares the version). A failure schedules the item again with a backoff: exponential for an
 * unavailable provider (warning), fixed and long for a provider that refused (error with the status), so a missing
 * permission cannot keep the provider busy. The claim leases the item, so several instances never work on the same
 * one, and an item of a crashed instance becomes claimable again when its lease ends. A change that arrives while an
 * item is leased does not release the lease, so the newer version waits until the worker is done with the old one
 * (it is then picked up at the next poll) and two instances never reconcile the same key at the same time: that
 * could leave the identity provider with the wrong role, because each run reads the rows first and writes the provider
 * afterwards. The lease must outlast the work on a batch (5 items, each a handful of calls with a timeout, a few
 * seconds when the provider is slow); the worker also stops starting items of a batch once the lease has passed, so
 * a stalled batch does not overlap with the instance that takes the items over. Repeating an item is harmless
 * because every call is idempotent. A late completion of an old claim cannot hurt a newer change either: versions
 * come from one sequence and are never reused, so the completion matches no row once the key was deleted and queued
 * again.
 */
export class IdentitySyncWorker {
  private readonly batchSize: number;
  private readonly leaseMs: number;
  private readonly retryInitialMs: number;
  private readonly retryMaxMs: number;
  private readonly rejectedRetryMs: number;
  private running: Promise<void> | null = null;
  private stopping = false;
  private wake: (() => void) | null = null;

  constructor(private readonly options: IdentitySyncWorkerOptions) {
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.retryInitialMs = options.retryInitialMs ?? 1000;
    this.retryMaxMs = options.retryMaxMs ?? 300_000;
    this.rejectedRetryMs = options.rejectedRetryMs ?? 300_000;
  }

  /** One poll: claims a batch and reconciles it item by item. */
  async runOnce(): Promise<RunResult> {
    const { store, reconcile, clock } = this.options;
    const now = clock.now();
    const leaseEnd = new Date(now.getTime() + this.leaseMs);
    const items = await store.claimIdentitySync(this.batchSize, leaseEnd, now);
    let done = 0;
    let failed = 0;
    for (const item of items) {
      // A shutdown does not wait for the rest of the batch: the lease of those items ends, then they are due again.
      if (this.stopping) break;
      // Once the lease has passed, another instance may already have the rest of the batch. They are claimed again.
      if (clock.now().getTime() >= leaseEnd.getTime()) {
        this.options.logger.warn({ skipped: items.length - done - failed }, "The lease of the batch ran out; the remaining items are left for the next claim");
        break;
      }
      try {
        await reconcile.execute(item);
        await store.completeIdentitySync(item.key, item.version);
        done += 1;
      } catch (error) {
        failed += 1;
        await this.scheduleRetry(item, error);
      }
    }
    return { done, failed, claimed: items.length };
  }

  private async scheduleRetry(item: IdentitySyncItem, error: unknown): Promise<void> {
    const { store, clock, logger } = this.options;
    const message = error instanceof Error ? error.message : String(error);
    const unavailable = error instanceof IdentityProviderUnavailable;
    const delayMs = unavailable ? this.backoffMs(item.attempts) : this.rejectedRetryMs;
    const fields = { key: item.key, attempts: item.attempts + 1, retryInMs: delayMs, err: error };
    if (unavailable) {
      logger.warn(fields, "The identity provider is unavailable; the item is tried again later");
    } else if (error instanceof IdentityProviderRejected) {
      logger.error({ ...fields, status: error.status }, "The identity provider refused the item; it is tried again slowly until the cause is fixed");
    } else {
      logger.error(fields, "Reconciling the item failed; it is tried again slowly");
    }
    await store.failIdentitySync(item.key, item.version, message, new Date(clock.now().getTime() + delayMs));
  }

  /** 1 s, 2 s, 4 s ... up to the maximum, by the number of failed attempts so far. */
  private backoffMs(attempts: number): number {
    return Math.min(this.retryMaxMs, this.retryInitialMs * 2 ** Math.min(attempts, 20));
  }

  /** Starts the polling loop; it runs until stop() is called. */
  start(): void {
    if (this.running) return;
    this.stopping = false;
    this.running = this.loop();
  }

  /** Stops the loop and waits until the poll in progress has finished its current item. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.wake?.();
    await this.running;
    this.running = null;
    this.stopping = false;
  }

  private async loop(): Promise<void> {
    let storeFailures = 0;
    while (!this.stopping) {
      let delay = this.options.pollMs;
      try {
        const result = await this.runOnce();
        storeFailures = 0;
        // A full batch means there is probably more: go on at once.
        if (result.claimed >= this.batchSize) delay = 0;
      } catch (error) {
        storeFailures += 1;
        delay = Math.min(30_000, this.options.pollMs * 2 ** Math.min(storeFailures, 16));
        this.options.logger.error({ err: error }, "The identity-sync worker could not read or update the queue");
      }
      if (delay > 0 && !this.stopping) await this.sleep(delay);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const finish = (): void => {
        clearTimeout(timer);
        this.wake = null;
        resolve();
      };
      const timer = setTimeout(finish, ms);
      this.wake = finish;
    });
  }
}
