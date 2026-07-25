'use strict';

describe('arcProvider dedicated Gateway RPC pool', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  test('uses ARC_GATEWAY_RPC_URLS only for gateway traffic classes', () => {
    process.env.ARC_RPC_URLS = 'https://general-a.example,https://general-b.example';
    process.env.ARC_GATEWAY_RPC_URLS = 'https://gateway-a.example https://gateway-b.example';

    const {
      getArcRpcUrlPool,
      getArcRpcPoolConfiguration,
    } = require('../arcProvider');

    expect(getArcRpcUrlPool({ trafficClass: 'gateway_read' })).toEqual([
      'https://gateway-a.example',
      'https://gateway-b.example',
    ]);
    expect(getArcRpcUrlPool({ trafficClass: 'gateway_deposit' })).toEqual([
      'https://gateway-a.example',
      'https://gateway-b.example',
    ]);
    expect(getArcRpcUrlPool({ trafficClass: 'background_read' })).toEqual([
      'https://general-a.example',
      'https://general-b.example',
    ]);
    expect(getArcRpcPoolConfiguration({ trafficClass: 'gateway_payment' })).toMatchObject({
      poolKind: 'gateway_dedicated',
      endpointCount: 2,
      gatewayDedicatedConfigured: true,
    });
  });

  test('falls back to the default pool when ARC_GATEWAY_RPC_URLS is absent', () => {
    process.env.ARC_RPC_URLS = 'https://general-only.example';
    delete process.env.ARC_GATEWAY_RPC_URLS;

    const {
      getArcRpcUrlPool,
      getArcRpcPoolConfiguration,
    } = require('../arcProvider');

    expect(getArcRpcUrlPool({ trafficClass: 'gateway_read' })).toEqual([
      'https://general-only.example',
    ]);
    expect(getArcRpcPoolConfiguration({ trafficClass: 'gateway_read' })).toMatchObject({
      poolKind: 'default',
      endpointCount: 1,
      gatewayDedicatedConfigured: false,
    });
  });
});
