import type { MfaCodeMethod } from '../../services/api';

export function normalizeMfaChallengeCode(value: string, method: MfaCodeMethod): string {
  if (method !== 'recovery_code') return value.replace(/\D/g, '').slice(0, 6);
  const compact = value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  return compact.length > 4 ? `${compact.slice(0, 4)}-${compact.slice(4)}` : compact;
}
