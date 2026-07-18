'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

describe('paidReadinessSmoke live guard', () => {
  test('exits before private key checks when ALLOW_LIVE_PAID_SMOKE is absent', () => {
    const scriptPath = path.resolve(__dirname, '../paidReadinessSmoke.js');

    const env = { ...process.env };
    delete env.ALLOW_LIVE_PAID_SMOKE;
    delete env.ORACLE_BUYER_PRIVATE_KEY;
    delete env.SMOKE_AGENT_PRIVATE_KEY;

    const result = spawnSync(process.execPath, [scriptPath], {
      env,
      encoding: 'utf8',
    });

    const output = `${result.stdout || ''}\n${result.stderr || ''}`;

    expect(result.status).toBe(1);
    expect(output).toContain('Live paid smoke is disabled. Set ALLOW_LIVE_PAID_SMOKE=true explicitly.');
    expect(output).not.toContain('Missing smoke private key');
  });
});
