/** Keep denied elevations compatible with their required denial_reason. */
export function normalizePamDenialReason(reason?: string | null): string {
  return reason?.trim() || 'Denied without reason';
}
