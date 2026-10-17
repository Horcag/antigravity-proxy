const INSPECTION_LIMIT = 64 * 1024;
const DISABLED_FOR_TERMS = 'this service has been disabled in this account for violation of terms of service';

/** Recognize only the explicit account-suspension response, never ordinary permission errors. */
export function isAccountSuspended(status: number | undefined, text: string): boolean {
  if (status !== 403) return false;
  const normalized = text.slice(0, INSPECTION_LIMIT).replace(/\\[nrt]/g, ' ').replace(/\s+/g, ' ').toLowerCase();
  return normalized.includes(DISABLED_FOR_TERMS);
}
