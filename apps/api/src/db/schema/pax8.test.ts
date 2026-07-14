import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { pax8SubscriptionSnapshots } from './pax8';

describe('Pax8 subscription quantity evidence defaults', () => {
  it('treats legacy rows as unknown in both Drizzle and the migration', () => {
    const column = getTableConfig(pax8SubscriptionSnapshots).columns
      .find((candidate) => candidate.name === 'quantity_known');
    expect(column?.default).toBe(false);

    const migration = readFileSync(fileURLToPath(new URL(
      '../../../migrations/2026-07-14-pax8-snapshot-quantity-evidence.sql',
      import.meta.url,
    )), 'utf8');
    expect(migration).toMatch(/quantity_known boolean NOT NULL DEFAULT false/i);
  });
});
