import { describe, expect, it } from 'vitest';
import { isStructurallyValidCron } from './cron';
describe('isStructurallyValidCron', () => {
  it.each(['0 6 * * 1-5', '*/15 * * * *', '0 0 6 * * *'])('accepts %s', (p) => expect(isStructurallyValidCron(p)).toBe(true));
  it.each(['', '0 6 * *', 'every morning', '60 6 * * *'])('rejects %s', (p) => expect(isStructurallyValidCron(p)).toBe(false));
});
