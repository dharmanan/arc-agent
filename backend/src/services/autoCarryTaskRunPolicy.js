'use strict';

function shouldTrackAutoCarryStartHandoff({
  dryRun = false,
  taskRunId = null,
  carryState = '',
  carryVerdictExecute = false,
} = {}) {
  if (dryRun || !taskRunId) return false;

  const normalizedCarryState = String(carryState || '').trim().toLowerCase();

  return normalizedCarryState === 'manual_lp_conflict'
    || normalizedCarryState === 'debt_idle'
    || carryVerdictExecute === true;
}

module.exports = {
  shouldTrackAutoCarryStartHandoff,
};