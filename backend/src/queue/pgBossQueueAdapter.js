'use strict';

const EventEmitter = require('events');
const PgBoss = require('pg-boss');

const DEFAULT_SCHEMA = process.env.PGBOSS_SCHEMA || 'pgboss';
const DEFAULT_QUEUE_NAME = process.env.PGBOSS_QUEUE_NAME || 'agent-jobs';
const DEFAULT_JOB_RETENTION_DAYS = Math.max(
  Number.parseInt(process.env.PGBOSS_JOB_RETENTION_DAYS || '7', 10) || 7,
  1,
);

function normalizeQueueBackend(value) {
  return String(value || '').trim().toLowerCase();
}

function shouldUsePgBossQueue() {
  return normalizeQueueBackend(process.env.QUEUE_BACKEND) === 'pgboss';
}

function resolveConnectionString() {
  return process.env.PGBOSS_DATABASE_URL
    || process.env.DATABASE_URL
    || process.env.POSTGRES_URL
    || process.env.POSTGRES_PRISMA_URL
    || null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(Number(ms) || 0, 0)));
}

function normalizeJobId(id) {
  return id == null ? null : String(id);
}

function getBackoffDelayMs(options = {}, attempt = 1) {
  const backoff = options.backoff;
  if (!backoff) return 0;

  if (typeof backoff === 'number') return Math.max(backoff, 0);

  const delay = Math.max(Number(backoff.delay || 0), 0);
  if (String(backoff.type || '').toLowerCase() === 'exponential') {
    return delay * Math.max(1, Math.pow(2, Math.max(Number(attempt || 1) - 1, 0)));
  }

  return delay;
}

function createPgBossJob(queue, rawJob, name, data, opts = {}) {
  const id = normalizeJobId(rawJob?.id || opts.jobId || rawJob?.name);
  const timestamp = rawJob?.createdOn
    ? new Date(rawJob.createdOn).getTime()
    : rawJob?.created_on
      ? new Date(rawJob.created_on).getTime()
      : Date.now();
  const startedAt = rawJob?.startedOn || rawJob?.started_on || null;
  const processedOn = startedAt ? new Date(startedAt).getTime() : 0;

  return {
    id,
    name,
    data: data || {},
    opts: opts || {},
    timestamp,
    processedOn,
    attemptsMade: Number(rawJob?.retryCount || rawJob?.retry_count || 0),
    queue,
    async getState() {
      const state = String(rawJob?.state || '').toLowerCase();
      if (state === 'active') return 'active';
      if (state === 'created' || state === 'retry') return 'waiting';
      if (state === 'completed') return 'completed';
      if (state === 'failed') return 'failed';
      return state || 'waiting';
    },
    async remove() {
      return queue.removeJob(id);
    },
  };
}

class PgBossBullCompatQueue extends EventEmitter {
  constructor(name = DEFAULT_QUEUE_NAME, options = {}) {
    super();
    const connectionString = resolveConnectionString();
    if (!connectionString) {
      throw new Error('QUEUE_BACKEND=pgboss requires DATABASE_URL or PGBOSS_DATABASE_URL');
    }

    this.name = name;
    this.queueName = name;
    this.options = options || {};
    this.handlers = {};
    this._paused = false;
    this._started = false;
    this._readyPromise = null;
    this._jobOptionsById = new Map();
    this._jobDataById = new Map();
    this._workSubscriptions = [];

    this.boss = new PgBoss({
      connectionString,
      schema: DEFAULT_SCHEMA,
      archiveCompletedAfterSeconds: DEFAULT_JOB_RETENTION_DAYS * 24 * 60 * 60,
      deleteAfterDays: DEFAULT_JOB_RETENTION_DAYS,
      monitorStateIntervalSeconds: Number(process.env.PGBOSS_MONITOR_INTERVAL_SECONDS || 60),
    });

    this.boss.on('error', (error) => {
      this.emit('error', error);
    });

    // Tiny Redis-compatible surface used by agentQueue dispatch locks. It is
    // Postgres-backed so the duplicate-delivery guard still works without Redis.
    this.client = {
      set: async (key, value, mode, ttlMode, ttlMs) => this._setLock(key, value, mode, ttlMode, ttlMs),
      get: async (key) => this._getLock(key),
      del: async (...keys) => this._deleteLocks(keys),
      lrem: async () => 0,
      zrem: async () => 0,
      srem: async () => 0,
    };
  }

  toKey(key) {
    return `pgboss:${this.name}:${key}`;
  }

  async isReady() {
    await this._ensureStarted();
    return true;
  }

  async _ensureStarted() {
    if (this._started) return;
    if (!this._readyPromise) {
      this._readyPromise = this.boss.start()
        .then(async () => {
          await this._ensureLockTable();
          this._started = true;
          await this._registerExistingHandlers();
          console.log(`[QUEUE] pg-boss ready schema=${DEFAULT_SCHEMA} queue=${this.name}`);
        });
    }
    await this._readyPromise;
  }

  async _ensureLockTable() {
    await this.boss.db.executeSql(`
      CREATE TABLE IF NOT EXISTS ${DEFAULT_SCHEMA}.arc_queue_locks (
        key text PRIMARY KEY,
        value text NOT NULL,
        expires_at timestamptz NOT NULL
      )
    `);
  }

  async _setLock(key, value, mode, ttlMode, ttlMs) {
    await this._ensureStarted();
    const normalizedMode = String(mode || '').toUpperCase();
    const normalizedTtlMode = String(ttlMode || '').toUpperCase();
    const ttl = normalizedTtlMode === 'PX' ? Math.max(Number(ttlMs) || 0, 1) : 30000;

    if (normalizedMode === 'NX') {
      const result = await this.boss.db.executeSql(`
        INSERT INTO ${DEFAULT_SCHEMA}.arc_queue_locks (key, value, expires_at)
        VALUES ($1, $2, NOW() + ($3 * INTERVAL '1 millisecond'))
        ON CONFLICT (key) DO UPDATE
          SET value = EXCLUDED.value,
              expires_at = EXCLUDED.expires_at
          WHERE ${DEFAULT_SCHEMA}.arc_queue_locks.expires_at <= NOW()
        RETURNING key
      `, [key, String(value), ttl]);
      return result?.rows?.length ? 'OK' : null;
    }

    await this.boss.db.executeSql(`
      INSERT INTO ${DEFAULT_SCHEMA}.arc_queue_locks (key, value, expires_at)
      VALUES ($1, $2, NOW() + ($3 * INTERVAL '1 millisecond'))
      ON CONFLICT (key) DO UPDATE
        SET value = EXCLUDED.value,
            expires_at = EXCLUDED.expires_at
    `, [key, String(value), ttl]);
    return 'OK';
  }

  async _getLock(key) {
    await this._ensureStarted();
    const result = await this.boss.db.executeSql(`
      SELECT value
        FROM ${DEFAULT_SCHEMA}.arc_queue_locks
       WHERE key = $1
         AND expires_at > NOW()
       LIMIT 1
    `, [key]);
    return result?.rows?.[0]?.value || null;
  }

  async _deleteLocks(keys = []) {
    await this._ensureStarted();
    const cleanKeys = keys.flat().filter(Boolean).map(String);
    if (cleanKeys.length === 0) return 0;
    const result = await this.boss.db.executeSql(`
      DELETE FROM ${DEFAULT_SCHEMA}.arc_queue_locks
       WHERE key = ANY($1::text[])
    `, [cleanKeys]);
    return result?.rowCount || 0;
  }

  process(name, concurrency, handler) {
    if (typeof concurrency === 'function') {
      handler = concurrency;
      concurrency = 1;
    }
    const normalizedName = String(name || '').trim();
    if (!normalizedName || typeof handler !== 'function') {
      throw new Error('pg-boss queue process requires a job name and handler');
    }

    this.handlers[normalizedName] = handler;
    this._registerWorker(normalizedName, Math.max(Number(concurrency) || 1, 1), handler)
      .catch((error) => this.emit('error', error));
  }

  async _registerExistingHandlers() {
    for (const [name, handler] of Object.entries(this.handlers)) {
      await this._registerWorker(name, 1, handler);
    }
  }

  async _registerWorker(name, concurrency, handler) {
    await this._ensureStarted();
    if (this._workSubscriptions.includes(name)) return;
    this._workSubscriptions.push(name);

    await this.boss.work(name, { teamSize: concurrency, teamConcurrency: concurrency }, async (jobs) => {
      const batch = Array.isArray(jobs) ? jobs : [jobs];
      for (const rawJob of batch) {
        while (this._paused) {
          await sleep(250);
        }

        const data = rawJob?.data || {};
        const opts = this._jobOptionsById.get(normalizeJobId(rawJob?.id)) || data.__bullOpts || {};
        const job = createPgBossJob(this, rawJob, name, data, opts);

        try {
          const result = await handler(job);
          this.emit('completed', job, result);
        } catch (error) {
          this.emit('failed', job, error);
          throw error;
        }
      }
    });
  }

  async add(name, data = {}, opts = {}) {
    await this._ensureStarted();
    const normalizedName = String(name || '').trim();
    const jobId = normalizeJobId(opts.jobId) || `${normalizedName}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const startAfter = Number(opts.delay || 0) > 0
      ? new Date(Date.now() + Number(opts.delay))
      : undefined;
    const retryLimit = Math.max(Number(opts.attempts || this.options?.defaultJobOptions?.attempts || 1) - 1, 0);
    const retryDelay = Math.ceil(getBackoffDelayMs(opts, 1) / 1000) || 1;
    const payload = {
      ...(data || {}),
      __bullJobId: jobId,
      __bullOpts: opts || {},
    };

    const pgBossJobId = await this.boss.send(normalizedName, payload, {
      singletonKey: jobId,
      retryLimit,
      retryDelay,
      retryBackoff: String(opts?.backoff?.type || '').toLowerCase() === 'exponential',
      startAfter,
      priority: Number.isFinite(Number(opts.priority)) ? Number(opts.priority) : undefined,
      expireInSeconds: Number(opts.timeout) > 0 ? Math.ceil(Number(opts.timeout) / 1000) : undefined,
    });

    const resolvedId = normalizeJobId(pgBossJobId || jobId);
    this._jobOptionsById.set(resolvedId, opts || {});
    this._jobDataById.set(resolvedId, data || {});

    return createPgBossJob(this, { id: resolvedId, createdOn: new Date(), state: startAfter ? 'created' : 'waiting' }, normalizedName, data, opts);
  }

  async getJob(id) {
    await this._ensureStarted();
    const normalizedId = normalizeJobId(id);
    if (!normalizedId) return null;

    const result = await this.boss.db.executeSql(`
      SELECT id::text, name, data, state, created_on, started_on, completed_on, retry_count
        FROM ${DEFAULT_SCHEMA}.job
       WHERE id::text = $1
          OR data->>'__bullJobId' = $1
       ORDER BY created_on DESC
       LIMIT 1
    `, [normalizedId]).catch(() => ({ rows: [] }));
    const row = result?.rows?.[0];
    if (!row) return null;
    return createPgBossJob(this, row, row.name, row.data || this._jobDataById.get(normalizedId) || {}, row.data?.__bullOpts || this._jobOptionsById.get(normalizedId) || {});
  }

  async getJobs(states = [], start = 0, end = 500) {
    await this._ensureStarted();
    const stateMap = {
      waiting: ['created', 'retry'],
      delayed: ['created', 'retry'],
      active: ['active'],
      paused: ['created'],
      completed: ['completed'],
      failed: ['failed'],
    };
    const pgStates = [...new Set((states || []).flatMap((state) => stateMap[state] || [state]))];
    const limit = Math.max((Number(end) || 0) - (Number(start) || 0) + 1, 1);
    const result = await this.boss.db.executeSql(`
      SELECT id::text, name, data, state, created_on, started_on, completed_on, retry_count
        FROM ${DEFAULT_SCHEMA}.job
       WHERE state = ANY($1::text[])
       ORDER BY created_on ASC
       OFFSET $2
       LIMIT $3
    `, [pgStates, Math.max(Number(start) || 0, 0), limit]).catch(() => ({ rows: [] }));

    return (result?.rows || []).map((row) => createPgBossJob(
      this,
      row,
      row.name,
      row.data || {},
      row.data?.__bullOpts || this._jobOptionsById.get(normalizeJobId(row.id)) || {},
    ));
  }

  async removeJob(id) {
    await this._ensureStarted();
    const normalizedId = normalizeJobId(id);
    if (!normalizedId) return false;
    await this.boss.cancel(normalizedId).catch(() => null);
    await this.boss.deleteJob(normalizedId).catch(() => null);
    this._jobOptionsById.delete(normalizedId);
    this._jobDataById.delete(normalizedId);
    return true;
  }

  async pause() {
    this._paused = true;
  }

  async resume() {
    await this._ensureStarted();
    this._paused = false;
  }

  async close() {
    if (this._started) {
      await this.boss.stop({ graceful: true, timeout: 5000 }).catch(() => null);
    }
    this._started = false;
  }
}

function createPgBossQueue(name, options) {
  return new PgBossBullCompatQueue(name, options);
}

module.exports = {
  PgBossBullCompatQueue,
  createPgBossQueue,
  shouldUsePgBossQueue,
};
