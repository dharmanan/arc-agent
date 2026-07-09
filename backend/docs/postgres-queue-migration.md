# Postgres Queue Migration

This branch adds an optional PostgreSQL-backed queue path using `pg-boss` while keeping the existing Bull/Redis path as the default rollback option.

## Safety model

- Default remains Redis/Bull unless `QUEUE_BACKEND=pgboss` is set.
- `bull` and `ioredis` are intentionally kept in `package.json` during rollout.
- If pg-boss fails in Railway, set `QUEUE_BACKEND=redis` or remove `QUEUE_BACKEND` and redeploy.
- Do not delete Upstash until smoke tests pass with `QUEUE_BACKEND=pgboss`.

## Files

- `backend/src/queue/pgBossQueueAdapter.js`
  - Bull-compatible adapter around pg-boss.
  - Supports `process`, `add`, `getJob`, `getJobs`, `pause`, `resume`, `isReady`, `on`.
  - Provides a small Postgres-backed `queue.client` compatibility layer for dispatch locks.

- `backend/scripts/enablePgBossQueueAdapter.js`
  - Codemod that patches `backend/src/queue/agentQueue.js` to choose Redis or pg-boss by `QUEUE_BACKEND`.

## Local patch command

Run from repo root:

```bash
cd backend
node scripts/enablePgBossQueueAdapter.js
git diff -- src/queue/agentQueue.js
```

Expected queue switch in `agentQueue.js`:

```js
const queue = shouldUsePgBossQueue()
  ? createPgBossQueue('agent-jobs', queueOptions)
  : new Bull('agent-jobs', {
      createClient: createBullRedisClient,
      ...queueOptions,
    });
```

## Install

```bash
cd backend
npm install
```

This should update `package-lock.json` and install `pg-boss`.

## Railway rollout

1. Deploy with current Redis behavior first:

```env
QUEUE_BACKEND=redis
```

or leave `QUEUE_BACKEND` unset.

2. Confirm normal boot.

3. Switch only backend service to:

```env
QUEUE_BACKEND=pgboss
```

4. Keep Upstash Redis alive during test.

5. Watch Railway logs for:

```text
[QUEUE] Backend=pgboss
[QUEUE] pg-boss ready
```

6. Run smoke checks:

```bash
cd backend
npm run smoke:readiness
npm run smoke:automation-live
npm run smoke:defi-full
```

## Rollback

Set:

```env
QUEUE_BACKEND=redis
```

or remove `QUEUE_BACKEND`, then redeploy. Redis/Bull code path is still present.

## When Redis can be deleted

Only delete Upstash after all of these pass on Railway with `QUEUE_BACKEND=pgboss`:

- backend boots cleanly
- manual task queue readiness passes
- market analysis queues and completes
- oracle loop queues and completes
- DEFI_LOOP queues and completes or policy-holds normally
- no repeated pg-boss worker errors in logs
