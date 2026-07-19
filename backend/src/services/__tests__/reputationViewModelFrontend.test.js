'use strict';

const fs = require('fs');
const path = require('path');

describe('frontend reputation cached view model', () => {
  test('cached status shows cached score + badge and avoids Local Only / Read error state copy', () => {
    const tasksTabPath = path.resolve(
      __dirname,
      '../../../../frontend/src/components/TasksTab.jsx',
    );
    const source = fs.readFileSync(tasksTabPath, 'utf8');

    expect(source).toContain("reputationOverview?.mode === 'hybrid_cached'");
    expect(source).toContain("Local + On-Chain (Cached)");
    expect(source).toContain("onchain.status === 'live' || onchain.status === 'cached'");
    expect(source).toContain('Cached{onchain.cachedAt ?');
    expect(source).toContain('getOnchainReputationMessage(onchain)');

    const cachedStateSection = source.slice(
      source.indexOf("onchain.status === 'cached'"),
      source.indexOf("onchain.status === 'cached'") + 900,
    );
    expect(cachedStateSection.toLowerCase()).not.toContain('read error');
    expect(cachedStateSection.toLowerCase()).not.toContain('local only');
  });
});
