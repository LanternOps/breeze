import { createHash } from 'crypto';

function getEnrollmentKeyPepper(): string {
  const pepper =
    process.env.ENROLLMENT_KEY_PEPPER
    || process.env.APP_ENCRYPTION_KEY
    || process.env.SECRET_ENCRYPTION_KEY
    || process.env.JWT_SECRET
    || (process.env.NODE_ENV === 'test' ? 'test-enrollment-key-pepper' : '');

  if (!pepper && process.env.NODE_ENV === 'production') {
    throw new Error('No enrollment key pepper configured. Set ENROLLMENT_KEY_PEPPER, APP_ENCRYPTION_KEY, SECRET_ENCRYPTION_KEY, or JWT_SECRET.');
  }

  return pepper;
}

export function hashEnrollmentKey(rawKey: string): string {
  return createHash('sha256')
    .update(`${getEnrollmentKeyPepper()}:${rawKey}`)
    .digest('hex');
}
