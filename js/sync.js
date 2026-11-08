/**
 * Client synchronization engine for Spendly.
 *
 * Connects the account-scoped IndexedDB outbox with Supabase PostgreSQL,
 * supporting bidirectional sync, transaction-safe cursor persistence,
 * exponential backoff retry, conflict handling, and online/offline detection.
 */

import { OUTBOX_STATUS, SYNC_STATUS } from './core.js';

export { SYNC_STATUS };

export class AuthRequiredSyncError extends Error {
  constructor(originalError) {
    super(originalError?.message || 'Authentication required for synchronization');
    this.name = 'AuthRequiredSyncError';
    this.originalError = originalError;
  }
}

export class PermanentSyncError extends Error {
  constructor(originalError, operation = null) {
    super(originalError?.message || 'Permanent sync error');
    this.name = 'PermanentSyncError';
    this.originalError = originalError;
    this.operation = operation;
  }
}

export class RetryableSyncError extends Error {
  constructor(originalError) {
    super(originalError?.message || 'Transient network or server error');
    this.name = 'RetryableSyncError';
    this.originalError = originalError;
  }
}

/**
 * Determine whether an error is caused by missing or expired authentication.
 */
export function isAuthError(error) {
  if (!error) return false;
  const status = error.status || error.code || error.statusCode;
  const msg = (error.message || String(error)).toLowerCase();

  if (status === 401 || status === '42501') return true;
  if (/jwt expired|invalid token|token expired|not authenticated|auth.*session.*missing|unauthorized/i.test(msg)) {
    return true;
  }
  return false;
}

/**
 * Determine whether a sync failure is permanent (non-retryable business/schema rule failure).
 */
export function isPermanentError(error) {
  if (!error) return false;
  const status = error.status || error.statusCode;
  const code = error.code ? String(error.code) : '';
  const msg = (error.message || String(error)).toLowerCase();

  // PostgreSQL permanent error codes
  if (['23514', '23505', '23503', '22023', 'P0001', 'P0002'].includes(code) || ['23514', '23505', '23503', '22023', 'P0001', 'P0002'].includes(String(status))) {
    return true;
  }

  // HTTP 4xx (except 401 which is auth, and 429 which is rate limit)
  const numStatus = Number(status);
  if (!isNaN(numStatus) && numStatus >= 400 && numStatus < 500 && numStatus !== 401 && numStatus !== 429) {
    return true;
  }

  if (/check_violation|overdraft|unique_violation|foreign key|already processed with different payload|record not found|invalid financial operation schema/i.test(msg)) {
    return true;
  }

  return false;
}

/**
 * Compute exponential backoff delay with jitter.
 */
export function computeBackoffDelay(attempt, baseDelay = 2000, maxDelay = 60000) {
  const clampedAttempt = Math.min(Math.max(0, attempt), 10);
  const exponential = Math.min(baseDelay * Math.pow(2, clampedAttempt), maxDelay);
  const jitter = Math.random() * 1000;
  return Math.floor(exponential + jitter);
}

/**
 * Account-scoped synchronization engine.
 */
export class SyncEngine {
  #supabase;
  #ledgerRepo;
  #userId;
  #onStatusChange;
  #onRemoteChange;
  #options;

  #status = SYNC_STATUS.IDLE;
  #statusMeta = {};
  #isSyncing = false;
  #pendingSyncRequested = false;
  #currentSyncPromise = null;
  #retryAttempt = 0;
  #retryTimeoutId = null;
  #lastSyncAt = null;
  #lastError = null;
  #disposed = false;

  #onlineHandler = null;
  #offlineHandler = null;
  #visibilityHandler = null;

  constructor({
    supabase,
    ledgerRepo,
    userId,
    onStatusChange = () => {},
    onRemoteChange = () => {},
    options = {}
  }) {
    if (!ledgerRepo) throw new Error('ledgerRepo is required for SyncEngine');
    if (!userId) throw new Error('userId is required for SyncEngine');

    this.#supabase = supabase;
    this.#ledgerRepo = ledgerRepo;
    this.#userId = userId;
    this.#onStatusChange = onStatusChange;
    this.#onRemoteChange = onRemoteChange;
    this.#options = {
      baseRetryDelay: options.baseRetryDelay ?? 2000,
      maxRetryDelay: options.maxRetryDelay ?? 60000,
      batchLimit: options.batchLimit ?? 100,
      now: options.now ?? (() => new Date()),
      ...options
    };

    this.#setupNetworkListeners();
  }

  get userId() {
    return this.#userId;
  }

  get status() {
    return this.#status;
  }

  get statusMeta() {
    return { ...this.#statusMeta };
  }

  get isSyncing() {
    return this.#isSyncing;
  }

  #setStatus(status, meta = {}) {
    this.#status = status;
    this.#statusMeta = {
      ...meta,
      status,
      lastSyncAt: this.#lastSyncAt,
      lastError: this.#lastError
    };
    try {
      this.#onStatusChange(this.#statusMeta);
    } catch (err) {
      console.warn('SyncEngine: onStatusChange listener threw:', err);
    }
  }

  #setupNetworkListeners() {
    if (typeof window === 'undefined') return;

    this.#onlineHandler = () => {
      if (this.#disposed) return;
      this.triggerSync();
    };

    this.#offlineHandler = () => {
      if (this.#disposed) return;
      if (this.#retryTimeoutId) {
        clearTimeout(this.#retryTimeoutId);
        this.#retryTimeoutId = null;
      }
      this.#setStatus(SYNC_STATUS.OFFLINE);
    };

    this.#visibilityHandler = () => {
      if (this.#disposed) return;
      if (document.visibilityState === 'visible' && (typeof navigator === 'undefined' || navigator.onLine)) {
        const lastSyncTime = this.#lastSyncAt ? new Date(this.#lastSyncAt).getTime() : 0;
        const now = this.#options.now().getTime();
        // If visible and more than 15s since last sync, trigger a sync
        if (now - lastSyncTime > 15000) {
          this.sync();
        }
      }
    };

    window.addEventListener('online', this.#onlineHandler);
    window.addEventListener('offline', this.#offlineHandler);
    document.addEventListener('visibilitychange', this.#visibilityHandler);
  }

  #scheduleRetry() {
    if (this.#disposed) return;
    if (this.#retryTimeoutId) {
      clearTimeout(this.#retryTimeoutId);
      this.#retryTimeoutId = null;
    }

    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      this.#setStatus(SYNC_STATUS.OFFLINE);
      return;
    }

    const delay = computeBackoffDelay(
      this.#retryAttempt,
      this.#options.baseRetryDelay,
      this.#options.maxRetryDelay
    );
    this.#retryAttempt++;

    this.#retryTimeoutId = setTimeout(() => {
      this.#retryTimeoutId = null;
      if (!this.#disposed && (typeof navigator === 'undefined' || navigator.onLine)) {
        this.sync();
      }
    }, delay);
  }

  /**
   * Immediately trigger a synchronization pass, resetting retry backoff.
   */
  triggerSync() {
    this.#retryAttempt = 0;
    if (this.#retryTimeoutId) {
      clearTimeout(this.#retryTimeoutId);
      this.#retryTimeoutId = null;
    }
    return this.sync();
  }

  /**
   * Reset any permanently failed operations to pending status and trigger sync.
   */
  async retryBlockedOperations() {
    if (this.#disposed) return { resetCount: 0 };
    const resetCount = await this.#ledgerRepo.resetBlockedOperations();
    await this.triggerSync();
    return { resetCount };
  }

  /**
   * Execute a full synchronization pass (Upload outbox operations -> Download remote changes).
   */
  sync() {
    if (this.#disposed) return Promise.resolve({ ok: false, reason: 'disposed' });

    // Check connectivity
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      this.#setStatus(SYNC_STATUS.OFFLINE);
      return Promise.resolve({ ok: false, reason: 'offline' });
    }

    // Coalesce concurrent sync requests
    if (this.#isSyncing) {
      this.#pendingSyncRequested = true;
      return this.#currentSyncPromise;
    }

    this.#isSyncing = true;
    this.#pendingSyncRequested = false;
    if (this.#retryTimeoutId) {
      clearTimeout(this.#retryTimeoutId);
      this.#retryTimeoutId = null;
    }

    this.#setStatus(SYNC_STATUS.SYNCING);

    this.#currentSyncPromise = this.#runSyncPass()
      .catch(err => {
        return { ok: false, error: err };
      })
      .finally(() => {
        this.#isSyncing = false;
        this.#currentSyncPromise = null;

        if (this.#pendingSyncRequested && !this.#disposed) {
          this.#pendingSyncRequested = false;
          queueMicrotask(() => this.sync());
        }
      });

    return this.#currentSyncPromise;
  }

  async #runSyncPass() {
    let uploadedCount = 0;
    let downloadedCount = 0;

    try {
      // ----------------------------------------------------------------------
      // Step 1: Upload pending local operations
      // ----------------------------------------------------------------------
      const pendingOps = await this.#ledgerRepo.listPendingOperations();
      const userOps = pendingOps.filter(op => !op.ownerUserId || op.ownerUserId === this.#userId);

      for (const op of userOps) {
        if (this.#disposed) return { ok: false, reason: 'disposed' };

        const p_operation = {
          operationId: op.operationId,
          operationType: op.operationType,
          entityType: op.entityType,
          entityId: op.entityId,
          payload: op.payload
        };

        const { data, error } = await this.#supabase.rpc('apply_sync_operation', { p_operation });

        if (error) {
          if (isAuthError(error)) {
            await this.#ledgerRepo.recordOperationAttempt(op.operationId, error);
            throw new AuthRequiredSyncError(error);
          }

          if (isPermanentError(error)) {
            await this.#ledgerRepo.recordOperationAttempt(op.operationId, error, {
              status: OUTBOX_STATUS.BLOCKED
            });
            throw new PermanentSyncError(error, op);
          }

          // Transient retryable error
          await this.#ledgerRepo.recordOperationAttempt(op.operationId, error);
          throw new RetryableSyncError(error);
        }

        // Successfully applied or skipped (idempotent receipt)
        await this.#ledgerRepo.acknowledgeOperation(op.operationId, {
          acknowledgedAt: this.#options.now().toISOString(),
          remoteCursor: data?.cursor
        });
        uploadedCount++;
      }

      // ----------------------------------------------------------------------
      // Step 2: Download remote changes
      // ----------------------------------------------------------------------
      let cursor = await this.#ledgerRepo.getLastSyncedCursor();
      let hasMore = true;

      while (hasMore) {
        if (this.#disposed) return { ok: false, reason: 'disposed' };

        const { data, error } = await this.#supabase.rpc('get_sync_changes', {
          p_after_cursor: cursor,
          p_limit: this.#options.batchLimit
        });

        if (error) {
          if (isAuthError(error)) {
            throw new AuthRequiredSyncError(error);
          }
          throw new RetryableSyncError(error);
        }

        const changes = data?.changes || [];
        const nextCursor = data?.nextCursor != null ? Number(data.nextCursor) : cursor;
        hasMore = Boolean(data?.hasMore);

        if (changes.length > 0) {
          const applied = await this.#ledgerRepo.applyRemoteChanges(changes, nextCursor);
          downloadedCount += applied;
          cursor = nextCursor;
        } else {
          if (nextCursor > cursor) {
            await this.#ledgerRepo.setSyncMetadata({ lastSyncedCursor: nextCursor });
            cursor = nextCursor;
          }
        }
      }

      if (downloadedCount > 0) {
        try {
          this.#onRemoteChange({ count: downloadedCount });
        } catch (err) {
          console.warn('SyncEngine: onRemoteChange callback error:', err);
        }
      }

      // ----------------------------------------------------------------------
      // Step 3: Success state evaluation
      // ----------------------------------------------------------------------
      this.#retryAttempt = 0;
      this.#lastSyncAt = this.#options.now().toISOString();
      this.#lastError = null;

      const remainingPending = await this.#ledgerRepo.countPendingOperations();
      const blockedCount = await this.#ledgerRepo.countBlockedOperations();

      if (blockedCount > 0) {
        this.#setStatus(SYNC_STATUS.BLOCKED, {
          blockedCount,
          pendingCount: remainingPending,
          uploadedCount,
          downloadedCount
        });
      } else if (remainingPending > 0) {
        this.#setStatus(SYNC_STATUS.PENDING, {
          pendingCount: remainingPending,
          uploadedCount,
          downloadedCount
        });
      } else {
        this.#setStatus(SYNC_STATUS.SYNCED, {
          uploadedCount,
          downloadedCount
        });
      }

      await this.#ledgerRepo.setSyncMetadata({
        lastSyncAt: this.#lastSyncAt,
        lastSyncStatus: this.#status
      });

      return {
        ok: true,
        uploadedCount,
        downloadedCount
      };
    } catch (err) {
      this.#lastError = err.message || String(err);

      if (err instanceof AuthRequiredSyncError) {
        this.#setStatus(SYNC_STATUS.AUTH_REQUIRED, { error: this.#lastError });
      } else if (err instanceof PermanentSyncError) {
        const blockedCount = await this.#ledgerRepo.countBlockedOperations();
        this.#setStatus(SYNC_STATUS.BLOCKED, {
          error: this.#lastError,
          blockedCount,
          failedOperation: err.operation
        });
      } else {
        // Transient error
        const pendingCount = await this.#ledgerRepo.countPendingOperations();
        this.#setStatus(SYNC_STATUS.TEMPORARY_ERROR, {
          error: this.#lastError,
          pendingCount,
          attempt: this.#retryAttempt
        });
        this.#scheduleRetry();
      }

      throw err;
    }
  }

  /**
   * Tear down all listeners, abort pending sync timers, and prevent further actions.
   */
  dispose() {
    this.#disposed = true;
    if (this.#retryTimeoutId) {
      clearTimeout(this.#retryTimeoutId);
      this.#retryTimeoutId = null;
    }

    if (typeof window !== 'undefined') {
      if (this.#onlineHandler) window.removeEventListener('online', this.#onlineHandler);
      if (this.#offlineHandler) window.removeEventListener('offline', this.#offlineHandler);
      if (this.#visibilityHandler) document.removeEventListener('visibilitychange', this.#visibilityHandler);
    }

    this.#onlineHandler = null;
    this.#offlineHandler = null;
    this.#visibilityHandler = null;
  }
}
