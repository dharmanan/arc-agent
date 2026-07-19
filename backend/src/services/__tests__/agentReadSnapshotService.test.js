'use strict';

describe('agentReadSnapshotService timeout floors', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  test('enforces 10000ms minimum for background refresh timeout', () => {
    process.env.ARC_RPC_BACKGROUND_REFRESH_TIMEOUT_MS = '5000';

    let service;
    jest.isolateModules(() => {
      service = require('../agentReadSnapshotService');
    });

    expect(service.getBackgroundRefreshTimeoutMs()).toBe(10000);
  });

  test('keeps configured timeout when it is above minimum', () => {
    process.env.ARC_RPC_BACKGROUND_REFRESH_TIMEOUT_MS = '15000';

    let service;
    jest.isolateModules(() => {
      service = require('../agentReadSnapshotService');
    });

    expect(service.getBackgroundRefreshTimeoutMs()).toBe(15000);
  });
});
