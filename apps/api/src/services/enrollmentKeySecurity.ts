import { createHash } from 'crypto';

function getEnrollmentKeyPepper(): string {
  const pepper = process.env.ENROLLMENT_KEY_PEPPER?.trim();
  if (pepper) return pepper;

  if (process.env.NODE_ENV === 'test') {
    return 'test-enrollment-key-pepper';
  }

  throw new Error('No enrollment key pepper configured. Set ENROLLMENT_KEY_PEPPER.');
}

export function hashEnrollmentKey(rawKey: string): string {
  return createHash('sha256')
    .update(`${getEnrollmentKeyPepper()}:${rawKey}`)
    .digest('hex');
}
