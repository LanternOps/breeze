import { describe, it, expect, afterEach } from 'vitest';
import {
  submitChangesSchema,
  CHANGE_INGEST_MAX_ITEMS,
  __resolveChangeIngestMaxItemsForTests,
} from './schemas';

// Build a minimal valid change item the schema accepts.
function makeChange(suffix: number) {
  return {
    timestamp: new Date(Date.UTC(2026, 4, 19, 1, 0, suffix % 60)).toISOString(),
    changeType: 'software',
    changeAction: 'added',
    subject: `pkg-${suffix}`,
  };
}

describe('CHANGE_INGEST_MAX_ITEMS resolver — env validation', () => {
  const originalEnv = process.env.CHANGE_INGEST_MAX_ITEMS;
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.CHANGE_INGEST_MAX_ITEMS;
    else process.env.CHANGE_INGEST_MAX_ITEMS = originalEnv;
  });

  it('defaults to 50000 when the env var is unset', () => {
    delete process.env.CHANGE_INGEST_MAX_ITEMS;
    expect(__resolveChangeIngestMaxItemsForTests()).toBe(50000);
  });

  it('parses a valid positive integer in range', () => {
    process.env.CHANGE_INGEST_MAX_ITEMS = '75000';
    expect(__resolveChangeIngestMaxItemsForTests()).toBe(75000);
  });

  it('falls back to default on a non-numeric value (would otherwise become NaN and reject every ingest)', () => {
    process.env.CHANGE_INGEST_MAX_ITEMS = 'abc';
    expect(__resolveChangeIngestMaxItemsForTests()).toBe(50000);
  });

  it('falls back to default on 0 (would otherwise reject every non-empty ingest)', () => {
    process.env.CHANGE_INGEST_MAX_ITEMS = '0';
    expect(__resolveChangeIngestMaxItemsForTests()).toBe(50000);
  });

  it('falls back to default on a negative integer', () => {
    process.env.CHANGE_INGEST_MAX_ITEMS = '-5';
    expect(__resolveChangeIngestMaxItemsForTests()).toBe(50000);
  });

  it('falls back to default on a value above the safety ceiling (200000)', () => {
    process.env.CHANGE_INGEST_MAX_ITEMS = '99999999';
    expect(__resolveChangeIngestMaxItemsForTests()).toBe(50000);
  });

  it('accepts the safety ceiling exactly', () => {
    process.env.CHANGE_INGEST_MAX_ITEMS = '200000';
    expect(__resolveChangeIngestMaxItemsForTests()).toBe(200000);
  });

  it('falls back to default on an empty string', () => {
    process.env.CHANGE_INGEST_MAX_ITEMS = '';
    expect(__resolveChangeIngestMaxItemsForTests()).toBe(50000);
  });
});

describe('submitChangesSchema — array length boundary', () => {
  it('accepts N=CHANGE_INGEST_MAX_ITEMS items', () => {
    const changes = Array.from({ length: CHANGE_INGEST_MAX_ITEMS }, (_, i) => makeChange(i));
    const parsed = submitChangesSchema.safeParse({ changes });
    expect(parsed.success).toBe(true);
  });

  it('rejects N=CHANGE_INGEST_MAX_ITEMS + 1 items', () => {
    const changes = Array.from({ length: CHANGE_INGEST_MAX_ITEMS + 1 }, (_, i) => makeChange(i));
    const parsed = submitChangesSchema.safeParse({ changes });
    expect(parsed.success).toBe(false);
  });

  it('accepts an empty changes array (default)', () => {
    expect(submitChangesSchema.safeParse({}).success).toBe(true);
    expect(submitChangesSchema.safeParse({ changes: [] }).success).toBe(true);
  });
});
