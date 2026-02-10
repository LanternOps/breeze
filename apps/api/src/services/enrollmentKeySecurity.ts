import { createHash } from 'crypto';

function getEnrollmentKeyPepper(): string {
  return (
    process.env.ENROLLMENT_KEY_PEPPER
    || process.env.APP_ENCRYPTION_KEY
    || process.env.SECRET_ENCRYPTION_KEY
    || process.env.JWT_SECRET
    || (process.env.NODE_ENV === 'test' ? 'test-enrollment-key-pepper' : '')
  );
}

export function hashEnrollmentKey(rawKey: string): string {
  return createHash('sha256')
    .update(`${getEnrollmentKeyPepper()}:${rawKey}`)
    .digest('hex');
}
