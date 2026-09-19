#!/usr/bin/env tsx
// Partner trust evidence card backfill. Run AFTER partner-trust-backfill.sql:
//   curl -s -H "Authorization: Bearer $ADMIN_TOKEN" "$API/admin/trust/queue?limit=200" | \
//     jq -r '.partners[].id' | \
//     pnpm --filter @breeze/api partner-trust:backfill-cards
//
// Reads partner UUIDs from stdin, one per line (or whitespace-separated),
// and queues an evidence card for each (probation_watch type).

import { closeDb, withSystemDbAccessContext } from '../src/db';
import { sendEvidenceCard } from '../src/services/partnerTrustEvidenceCard';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<void> {
  const ids = [...new Set((await readStdin()).split(/\s+/).filter(Boolean))];
  if (ids.length === 0) throw new Error('Provide one or more partner UUIDs on stdin.');

  const invalid = ids.filter((id) => !UUID.test(id));
  if (invalid.length > 0) throw new Error(`Invalid partner UUID(s): ${invalid.join(', ')}`);

  await withSystemDbAccessContext(async () => {
    for (const partnerId of ids) {
      await sendEvidenceCard(partnerId, 'probation_watch');
      console.log(`[partner-trust-backfill-cards] Sent evidence card for ${partnerId}`);
    }
  }, 'partnerTrustBackfillCards');
}

main()
  .catch((error) => {
    console.error('[partner-trust-backfill-cards] Failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
