import type { MfaCodeMethod, MfaMethod } from '../../services/api';

const CODE_METHODS = new Set<MfaMethod>(['totp', 'sms', 'recovery_code']);

export function resolveMfaCodeMethods(
  primary: MfaMethod,
  allowedMethods: unknown,
): { methods: MfaCodeMethod[]; selected: MfaCodeMethod | null } {
  if (!Array.isArray(allowedMethods)) return { methods: [], selected: null };
  const methods = [...new Set(allowedMethods.filter((method): method is MfaCodeMethod =>
    typeof method === 'string' && CODE_METHODS.has(method as MfaMethod)) )];
  const selected = primary !== 'passkey' && methods.includes(primary)
    ? primary
    : methods[0] ?? null;
  return { methods, selected };
}

export function normalizeMfaChallengeCode(value: string, method: MfaCodeMethod): string {
  if (method !== 'recovery_code') return value.replace(/\D/g, '').slice(0, 6);
  const compact = value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  return compact.length > 4 ? `${compact.slice(0, 4)}-${compact.slice(4)}` : compact;
}
