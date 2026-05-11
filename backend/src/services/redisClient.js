'use strict';
const Redis = require('ioredis');

// Upstash / production: set REDIS_URL=rediss://...
// Local Docker: set REDIS_HOST + REDIS_PORT + REDIS_PASSWORD
const client = process.env.REDIS_URL
  ? new Redis(process.env.REDIS_URL, {
      maxRetriesPerRequest: 3,
      lazyConnect: true,
      enableReadyCheck: true,
    })
  : new Redis({
      host:     process.env.REDIS_HOST || 'localhost',
      port:     parseInt(process.env.REDIS_PORT || '6379', 10),
      password: process.env.REDIS_PASSWORD || undefined,
      maxRetriesPerRequest: 3,
      lazyConnect: true,
      enableReadyCheck: true,
    });

client.on('error', err => console.error('[REDIS]', err.message));
client.on('connect', () => console.log('[REDIS] connected'));

module.exports = client;
