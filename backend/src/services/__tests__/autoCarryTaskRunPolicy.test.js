'use strict';

const { shouldTrackAutoCarryStartHandoff } = require('../autoCarryTaskRunPolicy');

describe('autoCarryTaskRunPolicy', () => {
  test('does not track a handoff without a task run id', () => {
    expect(shouldTrackAutoCarryStartHandoff({
      dryRun: false,
      taskRunId: null,
      carryState: 'inactive',
      carryVerdictExecute: true,
    })).toBe(false);
  });

  test('does not track a handoff during dry run', () => {
    expect(shouldTrackAutoCarryStartHandoff({
      dryRun: true,
      taskRunId: 'run-1',
      carryState: 'manual_lp_conflict',
      carryVerdictExecute: true,
    })).toBe(false);
  });

  test('tracks manual LP conversion handoff', () => {
    expect(shouldTrackAutoCarryStartHandoff({
      dryRun: false,
      taskRunId: 'run-1',
      carryState: 'manual_lp_conflict',
      carryVerdictExecute: false,
    })).toBe(true);
  });

  test('tracks debt idle handoff', () => {
    expect(shouldTrackAutoCarryStartHandoff({
      dryRun: false,
      taskRunId: 'run-1',
      carryState: 'debt_idle',
      carryVerdictExecute: false,
    })).toBe(true);
  });

  test('tracks an actionable carry review', () => {
    expect(shouldTrackAutoCarryStartHandoff({
      dryRun: false,
      taskRunId: 'run-1',
      carryState: 'inactive',
      carryVerdictExecute: true,
    })).toBe(true);
  });

  test('does not track a non-actionable hold review', () => {
    expect(shouldTrackAutoCarryStartHandoff({
      dryRun: false,
      taskRunId: 'run-1',
      carryState: 'inactive',
      carryVerdictExecute: false,
    })).toBe(false);
  });
});