import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentForClientState } from '../agentState.js';

test('strips private keys from a flat create-agent response', () => {
  const response = {
    id: 'agent-1',
    walletAddress: '0xabc',
    privateKey: 'secret-for-test-only',
    private_key: 'legacy-secret',
    private_key_encrypted: 'encrypted-secret',
    privateKeyEncrypted: 'legacy-encrypted-secret',
  };
  assert.deepEqual(agentForClientState(response), {
    id: 'agent-1',
    walletAddress: '0xabc',
  });
  assert.equal(response.privateKey, 'secret-for-test-only');
});

test('uses the nested agent object without copying a top-level secret', () => {
  const response = {
    privateKey: 'secret-for-test-only',
    agent: {
      id: 'agent-2',
      walletAddress: '0xdef',
      privateKey: 'nested-secret',
    },
  };
  assert.deepEqual(agentForClientState(response), {
    id: 'agent-2',
    walletAddress: '0xdef',
  });
});

test('preserves empty/null responses', () => {
  assert.equal(agentForClientState(null), null);
  assert.equal(agentForClientState(undefined), undefined);
});
