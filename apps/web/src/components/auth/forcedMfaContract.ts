export type EnrollmentMethod = 'totp' | 'sms' | 'passkey';

const ORDER: EnrollmentMethod[] = ['totp', 'sms', 'passkey'];

export function normalizeEnrollmentMethods(value: unknown): EnrollmentMethod[] {
  if (!Array.isArray(value)) return [];
  const supplied = new Set(value.filter((method): method is EnrollmentMethod =>
    method === 'totp' || method === 'sms' || method === 'passkey'));
  return ORDER.filter((method) => supplied.has(method));
}
