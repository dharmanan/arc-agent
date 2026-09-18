/**
 * Archive mode for the retired Arc Testnet deployment.
 *
 * The public production domain is always read-only. The VITE_ARCHIVE_MODE
 * environment variable remains as an explicit opt-in for preview/static builds.
 */
const hostname =
  typeof window !== 'undefined'
    ? String(window.location.hostname || '').toLowerCase()
    : '';

const archiveHost =
  hostname === 'arcmachina.xyz' ||
  hostname === 'www.arcmachina.xyz';

export const ARCHIVE_MODE =
  archiveHost ||
  String(import.meta.env.VITE_ARCHIVE_MODE || '').toLowerCase() === 'true';

export const ARCHIVE_TITLE = 'Arc Testnet archived';

export const ARCHIVE_MESSAGE =
  'This deployment is preserved as a read-only demo. Live agent execution and Arc Testnet backend services are disabled.';

export function createArchiveError() {
  const error = new Error(ARCHIVE_MESSAGE);
  error.name = 'ArchiveModeError';
  error.code = 'ARCHIVED_TESTNET_DEMO';
  error.status = 410;
  return error;
}
