'use strict';

const http = require('http');
const { Wallet } = require('ethers');

const TEST_OWNER_ADDRESS = '0x00000000000000000000000000000000000000AA';
const TEST_JWT_SECRET = 'test-secret-1234567890-test-secret';

function buildTestApp(router) {
  const express = require('express');
  const app = express();

  app.use(express.json());
  app.use('/api/auth', router);
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
  });

  return app;
}

async function createServer(app) {
  const server = http.createServer(app);

  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const { port } = server.address();

  return {
    async post(path, body, headers = {}) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });

      return {
        status: response.status,
        body: await response.json(),
      };
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function loadAuthHarness() {
  jest.resetModules();
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = TEST_JWT_SECRET;

  const db = { query: jest.fn() };
  const passkeyService = {
    generateRegistrationOptions: jest.fn().mockResolvedValue({ challenge: 'register-challenge' }),
    verifyRegistration: jest.fn(),
    generateAuthenticationOptions: jest.fn().mockResolvedValue({ challenge: 'challenge-1' }),
    verifyAuthentication: jest.fn().mockResolvedValue(undefined),
  };

  jest.doMock('../../db', () => db);
  jest.doMock('../../services/passkeyService', () => passkeyService);

  let router;
  let signToken;
  jest.isolateModules(() => {
    router = require('../auth');
    ({ signToken } = require('../../middleware/auth'));
  });

  return {
    app: buildTestApp(router),
    db,
    passkeyService,
    signToken,
  };
}

describe('auth hardening', () => {
  test('requires a valid one-time wallet signature before starting passkey registration', async () => {
    const { app, db, passkeyService } = loadAuthHarness();
    const server = await createServer(app);
    const wallet = Wallet.createRandom();
    const activeChallenges = new Set();

    db.query.mockImplementation(async (text, params = []) => {
      if (text.includes('INSERT INTO passkey_challenges')) {
        activeChallenges.add(params[0]);
        return { rows: [] };
      }

      if (text.includes('DELETE FROM passkey_challenges')) {
        const challengeId = params[0];
        const existed = activeChallenges.delete(challengeId);
        return { rows: existed ? [{ challenge: challengeId }] : [] };
      }

      if (text.includes('INSERT INTO users')) {
        return { rows: [{ id: 'user-1' }] };
      }

      throw new Error(`Unexpected query: ${text}`);
    });

    try {
      const challengeResponse = await server.post('/api/auth/passkey/register/challenge', {
        ownerAddress: wallet.address,
      });

      expect(challengeResponse.status).toBe(200);
      expect(challengeResponse.body.challengeId).toMatch(/[0-9a-f-]{36}/i);
      expect(challengeResponse.body.message).toContain(wallet.address.toLowerCase());

      const signature = await wallet.signMessage(challengeResponse.body.message);

      const startResponse = await server.post('/api/auth/passkey/register/start', {
        ownerAddress: wallet.address,
        challengeId: challengeResponse.body.challengeId,
        signature,
      });

      expect(startResponse.status).toBe(200);
      expect(startResponse.body.challenge).toBe('register-challenge');
      expect(passkeyService.generateRegistrationOptions).toHaveBeenCalledWith('user-1', wallet.address.toLowerCase());

      const replayResponse = await server.post('/api/auth/passkey/register/start', {
        ownerAddress: wallet.address,
        challengeId: challengeResponse.body.challengeId,
        signature,
      });

      expect(replayResponse.status).toBe(400);
      expect(replayResponse.body.error).toBe('wallet_challenge_expired');
    } finally {
      await server.close();
    }
  });

  test('rejects passkey registration start with an invalid wallet signature', async () => {
    const { app, db, passkeyService } = loadAuthHarness();
    const server = await createServer(app);
    const wallet = Wallet.createRandom();
    const attacker = Wallet.createRandom();
    const activeChallenges = new Set();

    db.query.mockImplementation(async (text, params = []) => {
      if (text.includes('INSERT INTO passkey_challenges')) {
        activeChallenges.add(params[0]);
        return { rows: [] };
      }

      if (text.includes('DELETE FROM passkey_challenges')) {
        const challengeId = params[0];
        const existed = activeChallenges.delete(challengeId);
        return { rows: existed ? [{ challenge: challengeId }] : [] };
      }

      if (text.includes('INSERT INTO users')) {
        return { rows: [{ id: 'user-1' }] };
      }

      throw new Error(`Unexpected query: ${text}`);
    });

    try {
      const challengeResponse = await server.post('/api/auth/passkey/register/challenge', {
        ownerAddress: wallet.address,
      });

      const signature = await attacker.signMessage(challengeResponse.body.message);
      const startResponse = await server.post('/api/auth/passkey/register/start', {
        ownerAddress: wallet.address,
        challengeId: challengeResponse.body.challengeId,
        signature,
      });

      expect(startResponse.status).toBe(401);
      expect(startResponse.body.error).toBe('invalid_wallet_signature');
      expect(passkeyService.generateRegistrationOptions).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  test('limits repeated passkey login challenge creation attempts', async () => {
    const { app, db, passkeyService } = loadAuthHarness();
    const server = await createServer(app);
    db.query.mockResolvedValue({ rows: [{ id: 'user-1', locked_until: null }] });

    try {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const response = await server.post('/api/auth/passkey/login/start', { ownerAddress: TEST_OWNER_ADDRESS });

        expect(response.status).toBe(200);
        expect(response.body.challenge).toBe('challenge-1');
      }

      const limitedResponse = await server.post('/api/auth/passkey/login/start', { ownerAddress: TEST_OWNER_ADDRESS });

      expect(limitedResponse.status).toBe(429);
      expect(limitedResponse.body.error).toMatch(/Too many authentication attempts/i);
      expect(passkeyService.generateAuthenticationOptions).toHaveBeenCalledTimes(8);
    } finally {
      await server.close();
    }
  });

  test('limits repeated failed passkey verification attempts', async () => {
    const { app, db, passkeyService } = loadAuthHarness();
    const server = await createServer(app);

    db.query.mockImplementation(async (text) => {
      if (text.includes('SELECT id, failed_auth_count, locked_until FROM users')) {
        return { rows: [{ id: 'user-1', failed_auth_count: 0, locked_until: null }] };
      }

      if (text.includes('UPDATE users')) {
        return { rows: [] };
      }

      throw new Error(`Unexpected query: ${text}`);
    });

    passkeyService.verifyAuthentication.mockRejectedValue(new Error('Passkey authentication failed'));

    try {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const response = await server.post('/api/auth/passkey/login/finish', {
          ownerAddress: TEST_OWNER_ADDRESS,
          credential: { id: 'cred-1' },
        });

        expect(response.status).toBe(401);
        expect(response.body.error).toBe('Passkey verification failed');
      }

      const limitedResponse = await server.post('/api/auth/passkey/login/finish', {
        ownerAddress: TEST_OWNER_ADDRESS,
        credential: { id: 'cred-1' },
      });

      expect(limitedResponse.status).toBe(429);
      expect(limitedResponse.body.error).toMatch(/Too many failed authentication attempts/i);
      expect(passkeyService.verifyAuthentication).toHaveBeenCalledTimes(5);
    } finally {
      await server.close();
    }
  });

  test('revokes the current JWT on logout', async () => {
    const { app, signToken } = loadAuthHarness();
    const server = await createServer(app);
    const token = signToken('user-1', TEST_OWNER_ADDRESS.toLowerCase());

    try {
      const logoutResponse = await server.post(
        '/api/auth/logout',
        {},
        { authorization: `Bearer ${token}` },
      );

      expect(logoutResponse.status).toBe(200);
      expect(logoutResponse.body.ok).toBe(true);

      const refreshResponse = await server.post(
        '/api/auth/refresh',
        {},
        { authorization: `Bearer ${token}` },
      );

      expect(refreshResponse.status).toBe(401);
      expect(refreshResponse.body.error).toBe('Session expired');
    } finally {
      await server.close();
    }
  });
});