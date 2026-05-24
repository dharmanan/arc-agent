'use strict';

describe('passkey service credential hardening', () => {
  beforeEach(() => {
    jest.resetModules();
    process.env.NODE_ENV = 'test';
    process.env.MAX_PASSKEY_CREDENTIALS_PER_USER = '3';
  });

  function loadHarness() {
    const db = {
      query: jest.fn(),
      getClient: jest.fn(),
    };
    const client = {
      query: jest.fn(),
      release: jest.fn(),
    };
    const verifyRegistrationResponse = jest.fn().mockResolvedValue({
      verified: true,
      registrationInfo: {
        credential: {
          id: 'cred-1',
          publicKey: Buffer.from('public-key'),
          counter: 7,
        },
      },
    });

    db.query.mockImplementation(async (text) => {
      if (text.includes('DELETE FROM passkey_challenges')) {
        return { rows: [{ challenge: 'challenge-1' }] };
      }

      throw new Error(`Unexpected db query: ${text}`);
    });
    db.getClient.mockResolvedValue(client);

    jest.doMock('../../db', () => db);
    jest.doMock('@simplewebauthn/server', () => ({
      generateRegistrationOptions: jest.fn(),
      verifyRegistrationResponse,
      generateAuthenticationOptions: jest.fn(),
      verifyAuthenticationResponse: jest.fn(),
    }));

    let passkeyService;
    jest.isolateModules(() => {
      passkeyService = require('../passkeyService');
    });

    return { passkeyService, client, verifyRegistrationResponse };
  }

  test('stores a verified credential and prunes older entries beyond the configured limit', async () => {
    const { passkeyService, client } = loadHarness();

    client.query.mockImplementation(async (text) => {
      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') {
        return { rows: [] };
      }

      if (text.includes('SELECT user_id FROM passkey_credentials')) {
        return { rows: [] };
      }

      return { rows: [] };
    });

    await passkeyService.verifyRegistration('user-1', { id: 'raw-credential' }, 'MacBook', 'https://arcmachina.xyz');

    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO passkey_credentials'),
      ['user-1', 'cred-1', Buffer.from('public-key').toString('base64url'), 7, 'MacBook'],
    );
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM passkey_credentials'),
      ['user-1', 3],
    );
    expect(client.query).toHaveBeenCalledWith('COMMIT');
    expect(client.release).toHaveBeenCalled();
  });

  test('rolls back when a credential is already assigned to another account', async () => {
    const { passkeyService, client } = loadHarness();

    client.query.mockImplementation(async (text) => {
      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') {
        return { rows: [] };
      }

      if (text.includes('SELECT user_id FROM passkey_credentials')) {
        return { rows: [{ user_id: 'user-2' }] };
      }

      return { rows: [] };
    });

    await expect(
      passkeyService.verifyRegistration('user-1', { id: 'raw-credential' }, 'MacBook', 'https://arcmachina.xyz')
    ).rejects.toThrow('Passkey credential already belongs to another account');

    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    expect(client.release).toHaveBeenCalled();
  });
});