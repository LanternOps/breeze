export const MFA_RECOVERY_CODE_PATTERN = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/i;

export function isMfaRecoveryCode(value: string): boolean {
  return MFA_RECOVERY_CODE_PATTERN.test(value.trim());
}
