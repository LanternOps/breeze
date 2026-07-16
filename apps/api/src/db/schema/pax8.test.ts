import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { pax8SubscriptionSnapshots } from './pax8';
import { pax8OrderLines } from './pax8Orders';

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

describe('Pax8 quantity authorization baseline', () => {
  it('is represented in Drizzle and added by an idempotent fix-forward migration', () => {
    const column = getTableConfig(pax8OrderLines).columns
      .find((candidate) => candidate.name === 'authorized_baseline_quantity');
    expect(column).toMatchObject({ notNull: false });

    const migration = readFileSync(fileURLToPath(new URL(
      '../../../migrations/2026-07-16-pax8-order-line-authorized-baseline.sql',
      import.meta.url,
    )), 'utf8');
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS authorized_baseline_quantity NUMERIC\(12,2\)/i);
    expect(migration).toMatch(/action = 'change_quantity'/i);
  });
});
