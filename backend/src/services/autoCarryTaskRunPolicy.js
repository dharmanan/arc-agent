'use strict';

function shouldTrackAutoCarryStartHandoff({
  dryRun = false,
  taskRunId = null,
} = {}) {
  if (dryRun || !taskRunId) return false;

  return true;
}

module.exports = {
  shouldTrackAutoCarryStartHandoff,
};