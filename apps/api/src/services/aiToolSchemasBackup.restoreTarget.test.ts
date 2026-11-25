import { describe, expect, it } from 'vitest';
import { backupToolSchemas, VOLUME_ROOT_TARGET_REFUSAL } from './aiToolSchemasBackup';

// #12638: restore_snapshot's input schema refuses a volume-root targetPath,
// so the call is refused before an approval is ever asked for.
describe('restore_snapshot targetPath (#12638)', () => {
  const schema = backupToolSchemas.restore_snapshot!;
  const base = { snapshotId: '11111111-1111-4111-8111-111111111111', deviceId: '22222222-2222-4222-8222-222222222222' };

  it.each(['C:\\', '/', '\\\\?\\D:\\', '\\\\nas\\share'])('refuses %j', (targetPath) => {
    const result = schema.safeParse({ ...base, targetPath });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain(VOLUME_ROOT_TARGET_REFUSAL.slice(0, 40));
  });

  it.each([undefined, 'D:\\Restored', '/var/restore'])('accepts %j', (targetPath) => {
    expect(schema.safeParse({ ...base, ...(targetPath ? { targetPath } : {}) }).success).toBe(true);
  });

  it('bounds targetPath at the schema (#12654)', () => {
    expect(schema.safeParse({ ...base, targetPath: `D:\\${'a'.repeat(4096 - 3)}` }).success).toBe(true);
    expect(schema.safeParse({ ...base, targetPath: `D:\\${'a'.repeat(4096)}` }).success).toBe(false);
    expect(schema.safeParse({ ...base, targetPath: `C:\\${' '.repeat(200_000)}x` }).success).toBe(false);
  });
});
