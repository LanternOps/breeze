import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PSA_MAPPING_CLOSE_STATES,
  PSA_MAPPING_CREATE_STATES,
  PSA_MAPPING_NOTE_STATES,
} from './integrations';
import { PSA_ADAPTER_ERROR_CLASSES } from '../../services/psa/types';

// The psa_ticket_mappings state vocabulary is written three times: the TS
// arrays W2-B will use, the Drizzle check() calls, and the migration CHECKs
// that actually bind. This pins the migration (the one Postgres enforces) to
// the TS arrays so a state added to one cannot silently miss the other.

const MIGRATION = readFileSync(
  join(__dirname, '../../../migrations/2027-01-17-210000-psa-alert-ticketing.sql'),
  'utf8',
);

function checkList(constraint: string, column: string): string[] {
  const start = MIGRATION.indexOf(`ADD CONSTRAINT ${constraint}`);
  expect(start, `${constraint} not found`).toBeGreaterThan(-1);
  const body = MIGRATION.slice(start, MIGRATION.indexOf(';', start));
  const match = body.match(new RegExp(`${column} IN \\(([^)]*)\\)`));
  expect(match, `${constraint} has no ${column} IN (...) list`).not.toBeNull();
  return [...match![1]!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!).sort();
}

describe('psa_ticket_mappings state vocabulary (TS ↔ migration CHECKs)', () => {
  it('create_state', () => {
    expect(checkList('psa_ticket_mappings_create_state_chk', 'create_state')).toEqual([...PSA_MAPPING_CREATE_STATES].sort());
  });

  it('close_state', () => {
    expect(checkList('psa_ticket_mappings_close_state_chk', 'close_state')).toEqual([...PSA_MAPPING_CLOSE_STATES].sort());
  });

  it('note_state', () => {
    expect(checkList('psa_ticket_mappings_note_state_chk', 'note_state')).toEqual([...PSA_MAPPING_NOTE_STATES].sort());
  });

  it('last_error_class matches the adapter error classes', () => {
    expect(checkList('psa_ticket_mappings_last_error_class_chk', 'last_error_class')).toEqual([...PSA_ADAPTER_ERROR_CLASSES].sort());
  });

  it('a created mapping must carry its external ticket id', () => {
    expect(MIGRATION).toMatch(/ADD CONSTRAINT psa_ticket_mappings_created_ticket_chk\s+CHECK \(create_state <> 'created' OR external_ticket_id IS NOT NULL\)/);
  });
});
