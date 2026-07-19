'use strict';

describe('arcProvider traffic class isolation', () => {
  const ENDPOINT = 'https://rpc-a.testnet.arc.network';

  function loadProvider() {
    jest.resetModules();
    process.env.ARC_RPC_URLS = ENDPOINT;

    let arcProvider;
    jest.isolateModules(() => {
      arcProvider = require('../arcProvider');
    });

    arcProvider.clearArcRpcProviderCache();
    return arcProvider;
  }

  test('reputation_read rate limit does not block gateway', () => {
    const arcProvider = loadProvider();
    const rateLimitError = new Error('429 request limit reached');

    arcProvider.markArcRpcEndpointUnhealthy(
      ENDPOINT,
      rateLimitError,
      'reputation_read_test',
      { trafficClass: 'reputation_read' },
    );

    const gatewayUrl = arcProvider.getHealthyArcRpcUrl('gateway_probe', {
      trafficClass: 'gateway',
    });

    expect(gatewayUrl).toBe(ENDPOINT);
  });

  test('background_read timeout does not block transaction', () => {
    const arcProvider = loadProvider();
    const timeoutError = new Error('timed out after 5000ms');

    arcProvider.markArcRpcEndpointUnhealthy(
      ENDPOINT,
      timeoutError,
      'background_read_timeout_test',
      {
        trafficClass: 'background_read',
        force: true,
        reason: 'transient',
      },
    );

    const transactionUrl = arcProvider.getHealthyArcRpcUrl('transaction_probe', {
      trafficClass: 'transaction',
    });

    expect(transactionUrl).toBe(ENDPOINT);
  });

  test('gateway rate limit does not block reputation_read', () => {
    const arcProvider = loadProvider();
    const rateLimitError = new Error('request limit reached');

    arcProvider.markArcRpcEndpointUnhealthy(
      ENDPOINT,
      rateLimitError,
      'gateway_rate_limit_test',
      { trafficClass: 'gateway' },
    );

    const reputationUrl = arcProvider.getHealthyArcRpcUrl('reputation_probe', {
      trafficClass: 'reputation_read',
    });

    expect(reputationUrl).toBe(ENDPOINT);
  });

  test('gateway_read cooldown does not block gateway_deposit', () => {
    const arcProvider = loadProvider();
    const rateLimitError = new Error('429 request limit reached');

    arcProvider.markArcRpcEndpointUnhealthy(
      ENDPOINT,
      rateLimitError,
      'gateway_read_rate_limit_test',
      { trafficClass: 'gateway_read' },
    );

    const gatewayDepositUrl = arcProvider.getHealthyArcRpcUrl('gateway_deposit_probe', {
      trafficClass: 'gateway_deposit',
    });

    expect(gatewayDepositUrl).toBe(ENDPOINT);
  });

  test('gateway_deposit cooldown does not block gateway_payment', () => {
    const arcProvider = loadProvider();
    const rateLimitError = new Error('429 request limit reached');

    arcProvider.markArcRpcEndpointUnhealthy(
      ENDPOINT,
      rateLimitError,
      'gateway_deposit_rate_limit_test',
      { trafficClass: 'gateway_deposit' },
    );

    const gatewayPaymentUrl = arcProvider.getHealthyArcRpcUrl('gateway_payment_probe', {
      trafficClass: 'gateway_payment',
    });

    expect(gatewayPaymentUrl).toBe(ENDPOINT);
  });

  test('gateway_payment cooldown does not block gateway_deposit', () => {
    const arcProvider = loadProvider();
    const rateLimitError = new Error('429 request limit reached');

    arcProvider.markArcRpcEndpointUnhealthy(
      ENDPOINT,
      rateLimitError,
      'gateway_payment_rate_limit_test',
      { trafficClass: 'gateway_payment' },
    );

    const gatewayDepositUrl = arcProvider.getHealthyArcRpcUrl('gateway_deposit_probe', {
      trafficClass: 'gateway_deposit',
    });

    expect(gatewayDepositUrl).toBe(ENDPOINT);
  });
});

describe('arcProvider safeArcRpcCall fallback semantics', () => {
  const ENDPOINT_A = 'https://rpc-a.testnet.arc.network';
  const ENDPOINT_B = 'https://rpc-b.testnet.arc.network';

  function loadProvider() {
    jest.resetModules();
    process.env.ARC_RPC_URLS = [ENDPOINT_A, ENDPOINT_B].join(',');

    let arcProvider;
    jest.isolateModules(() => {
      arcProvider = require('../arcProvider');
    });

    arcProvider.clearArcRpcProviderCache();
    return arcProvider;
  }

  function createRateLimitError() {
    const error = new Error('429 request limit reached');
    error.code = 'SERVER_ERROR';
    return error;
  }

  test('no-fallback calls throw after every eligible endpoint fails', async () => {
    const arcProvider = loadProvider();
    const attempted = [];

    await expect(arcProvider.safeArcRpcCall(
      'no_fallback_probe',
      async (_provider, rpcUrl) => {
        attempted.push(rpcUrl);
        throw createRateLimitError();
      },
    )).rejects.toThrow('request limit reached');

    expect(attempted).toEqual([ENDPOINT_A, ENDPOINT_B]);
  });

  test('explicit fallback calls return only the supplied fallback value', async () => {
    const arcProvider = loadProvider();
    const fallback = Object.freeze({ mode: 'fallback_only' });

    const result = await arcProvider.safeArcRpcCall(
      'explicit_fallback_probe',
      async () => {
        throw createRateLimitError();
      },
      fallback,
      { trafficClass: 'reputation_read' },
    );

    expect(result).toBe(fallback);
  });

  test('third argument trafficClass object is treated as options, not fallback', async () => {
    const arcProvider = loadProvider();

    await expect(arcProvider.safeArcRpcCall(
      'options_third_argument_probe',
      async () => {
        throw new Error('hard failure');
      },
      { trafficClass: 'gateway' },
    )).rejects.toThrow('hard failure');
  });

  test('undefined third argument is not treated as implicit fallback', async () => {
    const arcProvider = loadProvider();

    await expect(arcProvider.safeArcRpcCall(
      'undefined_third_argument_probe',
      async () => {
        throw new Error('hard failure');
      },
      undefined,
    )).rejects.toThrow('hard failure');
  });

  test('strict provenance mode does not mark endpoint unhealthy for gateway service 429', async () => {
    const arcProvider = loadProvider();

    const service429Error = new Error('Gateway API balance fetch failed: 429 Too Many Requests');
    service429Error.statusCode = 429;
    service429Error.failureSource = 'gateway_service';
    service429Error.rpcEndpointProven = false;

    await expect(arcProvider.safeArcRpcCall(
      'strict_provenance_service_429_probe',
      async () => {
        throw service429Error;
      },
      {
        trafficClass: 'gateway_deposit',
        strictRpcProvenance: true,
      },
    )).rejects.toThrow('429 Too Many Requests');

    const stillHealthy = arcProvider.getHealthyArcRpcUrl('strict_provenance_health_probe', {
      trafficClass: 'gateway_deposit',
    });
    expect([ENDPOINT_A, ENDPOINT_B]).toContain(stillHealthy);

    const cooldownState = arcProvider.getArcRpcTrafficClassCooldownState('gateway_deposit');
    expect(cooldownState).toMatchObject({
      trafficClass: 'gateway_deposit',
      active: false,
      coolingEndpointCount: 0,
      endpointCount: 2,
    });
  });
});
