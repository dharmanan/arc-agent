/**
 * Production archive mode for the retired Arc Testnet deployment.
 *
 * Vercel enables this with VITE_ARCHIVE_MODE=true. Local development stays
 * unchanged unless the same environment variable is explicitly set.
 */
export const ARCHIVE_MODE =
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
