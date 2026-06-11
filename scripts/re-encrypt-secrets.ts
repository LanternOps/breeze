#!/usr/bin/env tsx
import { closeDb } from '../apps/api/src/db';
import { reencryptRegisteredSecrets } from '../apps/api/src/services/encryptedColumnRegistry';

function parseBatchSize(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error('--batch-size must be a positive integer');
  }
  return parsed;
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const batchArg = process.argv.find((arg) => arg.startsWith('--batch-size='));
  const dryRun = !args.has('--apply');
  const batchSize = parseBatchSize(batchArg?.split('=')[1]);

  if (dryRun) {
    console.log('[secret-rotation] Dry run only. Re-run with --apply to write rotated ciphertext.');
  }

  const stats = await reencryptRegisteredSecrets({ dryRun, batchSize });
  console.log(JSON.stringify(stats, null, 2));

  if (stats.errors.length > 0) {
    throw new Error(`Secret re-encryption completed with ${stats.errors.length} row error(s)`);
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
