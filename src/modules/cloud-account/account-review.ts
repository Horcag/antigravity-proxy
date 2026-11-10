import type { CloudAccount } from './types';

export function needsAccountReview(account: Pick<CloudAccount, 'status_reason' | 'quota'>): boolean {
  return Boolean(account.quota?.is_forbidden || account.quota?.isForbidden || (account.status_reason !== 'operator_disabled' && /tos|terms|banned|disabled|forbidden|violation|suspend|3501/i.test(account.status_reason ?? '')));
}
