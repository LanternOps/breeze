#!/usr/bin/env tsx
// Tool Catalog W06 (#5221) Task A8 — the legacy Jobs → Flows conversion census
// of ONE installation, printed as JSON. Read-only, system context.
//
//   cd apps/api && DATABASE_URL=... npx tsx scripts/automationConversionCensus.ts
//
// The output is aggregates only: class counts, fidelity and finding counts,
// compliance-remediation targets, switched counts and the oldest switch age —
// never an id, a name or any other row content. Only these numbers ever leave
// the host; nothing about a customer is printed or committed.

import { closeDb } from '../src/db';
import { conversionCensus } from '../src/services/flows/conversion/census';

async function main(): Promise<void> {
  const census = await conversionCensus(new Date());
  process.stdout.write(`${JSON.stringify(census, null, 2)}\n`);
}

main()
  .catch((error) => {
    console.error('[automation-conversion-census] Failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
    // The service graph the converter loads (event bus, queues) keeps handles
    // open; this is a one-shot CLI, so exit once the pool is closed.
    process.exit();
  });
