'use strict';

const { getCirclePaidCatalog } = require('../circlePaidCatalogService');

describe('getCirclePaidCatalog', () => {
  test('returns Circle Paid with visible roadmap metadata', () => {
    const catalog = getCirclePaidCatalog();

    expect(catalog.economy.mode).toBe('visible_live_and_planned_cards');
    expect(catalog.economy.railLabel).toBe('Live + roadmap cards');
    expect(catalog.economy.userNarrative).toMatch(/roadmap remains visible/i);
  });

  test('keeps the current live card set intact', () => {
    const catalog = getCirclePaidCatalog();
    const liveItemIds = catalog.items
      .filter((item) => item.status === 'live')
      .map((item) => item.id)
      .sort();

    expect(liveItemIds).toEqual([
      'ARC_EVENT_ODDS_COMPARE',
      'ARC_PREDICTION_MARKET_CHECK',
      'ARC_WALLET_ASSET_SNAPSHOT',
    ]);
  });

  test('still includes non-live cards as visible roadmap stages', () => {
    const catalog = getCirclePaidCatalog();
    const nonLiveStatuses = catalog.items
      .filter((item) => item.status !== 'live')
      .map((item) => item.status);

    expect(nonLiveStatuses.length).toBeGreaterThan(0);
    expect(nonLiveStatuses).toEqual(expect.arrayContaining(['preview']));
  });
});