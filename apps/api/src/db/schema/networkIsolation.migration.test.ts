import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ACTIVE_STATES,
  ISOLATION_DESIRED_STATES,
  ISOLATION_FAILURE_CODES,
  ISOLATION_MECHANISMS,
  ISOLATION_RELEASE_KINDS,
  ISOLATION_REQUESTED_BY_KINDS,
  ISOLATION_STATES,
  RESOLVED_TERMINAL_STATES,
} from '@breeze/shared';

/**
 * Network-isolation containment W1a (#10089, feature #10088, plan W1a Task 1).
 *
 * The migration is the source of truth for what Drizzle cannot express (the
 * column-list ON DELETE SET NULL, the partial indexes' predicates, the policies,
 * the device-move trigger), and nothing else reads its text before Integration
 * Tests. These assertions pin the shape the plan and spec §4 require.
 */
const MIGRATION_FILE = '2027-01-17-200000-device-network-isolations.sql';
const MIGRATION = path.join(__dirname, '../../../migrations', MIGRATION_FILE);

const RESOLVED_TERMINAL = ['released', 'expired', 'failed', 'uninstalled'];
const ACTIVE = ['requested', 'dispatched', 'applying', 'applied', 'verified', 'release_requested'];

function sqlText(): string {
  return fs.readFileSync(MIGRATION, 'utf8');
}

/** The SQL with `--` comments stripped, whitespace collapsed. */
function normalized(): string {
  return sqlText()
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join(' ')
    .replace(/\s+/g, ' ');
}

function quotedList(states: string[]): string {
  return states.map((s) => `'${s}'`).join(', ');
}

describe('device_network_isolations migration', () => {
  it('exists under the assigned slot', () => {
    expect(fs.existsSync(MIGRATION), `${MIGRATION_FILE} is missing`).toBe(true);
  });

  it('enables AND forces RLS, with the four breeze_has_org_access(org_id) policies', () => {
    const sql = normalized();
    expect(sql).toContain('ALTER TABLE device_network_isolations ENABLE ROW LEVEL SECURITY;');
    expect(sql).toContain('ALTER TABLE device_network_isolations FORCE ROW LEVEL SECURITY;');
    for (const cmd of ['select', 'insert', 'update', 'delete']) {
      expect(sql).toContain(`CREATE POLICY breeze_org_isolation_${cmd} ON device_network_isolations`);
    }
    expect(sql).toMatch(/breeze_org_isolation_select ON device_network_isolations FOR SELECT USING \(breeze_has_org_access\(org_id\)\)/);
    expect(sql).toMatch(/breeze_org_isolation_insert ON device_network_isolations FOR INSERT WITH CHECK \(breeze_has_org_access\(org_id\)\)/);
    expect(sql).toMatch(
      /breeze_org_isolation_update ON device_network_isolations FOR UPDATE USING \(breeze_has_org_access\(org_id\)\) WITH CHECK \(breeze_has_org_access\(org_id\)\)/,
    );
    expect(sql).toMatch(/breeze_org_isolation_delete ON device_network_isolations FOR DELETE USING \(breeze_has_org_access\(org_id\)\)/);
    expect(sql).toContain('GRANT SELECT, INSERT, UPDATE, DELETE ON device_network_isolations TO breeze_app');
  });

  it('declares the device composite FK ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE', () => {
    expect(normalized()).toContain(
      'FOREIGN KEY (device_id, org_id) REFERENCES devices(id, org_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE',
    );
  });

  it('declares the incident and action composite FKs with the column-list SET NULL', () => {
    const sql = normalized();
    expect(sql).toContain(
      'FOREIGN KEY (incident_id, org_id) REFERENCES incidents(id, org_id) ON DELETE SET NULL (incident_id) DEFERRABLE INITIALLY IMMEDIATE',
    );
    expect(sql).toContain(
      'FOREIGN KEY (incident_action_id, org_id) REFERENCES incident_actions(id, org_id) ON DELETE SET NULL (incident_action_id) DEFERRABLE INITIALLY IMMEDIATE',
    );
    // A bare composite SET NULL would null org_id too.
    expect(sql).not.toMatch(/REFERENCES incidents\(id, org_id\) ON DELETE SET NULL DEFERRABLE/);
  });

  it('adds UNIQUE (id, org_id) on incidents and incident_actions idempotently', () => {
    const sql = normalized();
    for (const [table, name] of [
      ['incidents', 'incidents_id_org_uq'],
      ['incident_actions', 'incident_actions_id_org_uq'],
    ] as const) {
      expect(sql).toContain(`ALTER TABLE ${table} ADD CONSTRAINT ${name} UNIQUE (id, org_id)`);
      expect(sql).toMatch(
        new RegExp(`IF NOT EXISTS \\( SELECT 1 FROM pg_constraint WHERE conname = '${name}' AND conrelid = '${table}'::regclass \\)`),
      );
    }
  });

  it('keeps one unresolved episode per device with a partial unique index', () => {
    expect(normalized()).toContain(
      `CREATE UNIQUE INDEX IF NOT EXISTS device_network_isolations_one_unresolved_uniq ON device_network_isolations (device_id) WHERE state NOT IN (${quotedList(RESOLVED_TERMINAL)})`,
    );
  });

  it('indexes (org_id, state), the expiry sweep and unconfirmed tombstones', () => {
    const sql = normalized();
    expect(sql).toContain(
      'CREATE INDEX IF NOT EXISTS device_network_isolations_org_state_idx ON device_network_isolations (org_id, state)',
    );
    expect(sql).toContain(
      `CREATE INDEX IF NOT EXISTS device_network_isolations_active_expiry_idx ON device_network_isolations (expires_at) WHERE state IN (${quotedList(ACTIVE)})`,
    );
    expect(sql).toContain(
      "CREATE INDEX IF NOT EXISTS device_network_isolations_unconfirmed_tombstone_idx ON device_network_isolations (device_id) WHERE desired_state = 'released' AND release_confirmed_at IS NULL",
    );
  });

  it('has the spec §4 columns plus the four refinement-4(iv) columns', () => {
    const sql = normalized();
    for (const column of [
      'id uuid PRIMARY KEY',
      'org_id uuid NOT NULL',
      'device_id uuid NOT NULL',
      'incident_id uuid',
      'incident_action_id uuid',
      'desired_state varchar(16) NOT NULL',
      'state varchar(32) NOT NULL',
      'generation integer NOT NULL',
      'acknowledged_at timestamptz',
      'acknowledged_by uuid',
      'break_glass_secret_enc text NOT NULL',
      'requested_by_kind varchar(16) NOT NULL',
      'requested_by_user_id uuid',
      'reason text NOT NULL',
      'expires_at timestamptz NOT NULL',
      'dead_man_seconds integer NOT NULL',
      'remote_relay boolean NOT NULL',
      'mechanism varchar(16)',
      'allow_snapshot jsonb NOT NULL',
      'last_agent_report jsonb',
      'failure_code varchar(48)',
      'release_kind varchar(24)',
      'command_id uuid',
      'release_command_id uuid',
      'expiry_warned_at timestamptz',
      'break_glass_ack_seq bigint',
      'last_journal_seq bigint NOT NULL DEFAULT 0',
      'release_confirmed_at timestamptz',
      'requested_at timestamptz NOT NULL',
      'dispatched_at timestamptz',
      'applied_at timestamptz',
      'verified_at timestamptz',
      'release_requested_at timestamptz',
      'released_at timestamptz',
      'created_at timestamptz NOT NULL',
      'updated_at timestamptz NOT NULL',
    ]) {
      expect(sql, `missing column definition: ${column}`).toContain(column);
    }
    // command ids carry no FK: device_commands is system-scoped and reaped.
    expect(sql).not.toMatch(/command_id uuid REFERENCES/);
  });

  it('deletes resolved history before a device org flip, outside a merge, and refuses an unresolved episode', () => {
    const sql = normalized();
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.breeze_network_isolation_device_moved()');
    expect(sql).toContain('CREATE TRIGGER breeze_network_isolation_device_moved BEFORE UPDATE OF org_id ON public.devices');
    expect(sql).toContain("o.status::text = 'merging'");
    expect(sql).toContain('isolation_unresolved');
    // An unconfirmed tombstone (e.g. failed:not_delivered) still owes the device a release: refuse, never delete.
    expect(sql).toContain("OR (i.desired_state = 'released' AND i.release_confirmed_at IS NULL)");
  });

  it('ties desired_state to state: isolated exactly while isolating', () => {
    expect(normalized()).toContain(
      "CONSTRAINT device_network_isolations_desired_matches_state_chk CHECK ((desired_state = 'isolated') = (state IN ('requested', 'dispatched', 'applying', 'applied', 'verified')))",
    );
  });

  /**
   * The SQL CHECKs and the shared tuples are two copies of one vocabulary; nothing else compares them, so a
   * member added to one side only would ship as a runtime 23514 on the first row that used it.
   */
  it.each([
    ['desired_state', ISOLATION_DESIRED_STATES],
    ['state', ISOLATION_STATES],
    ['failure_code', ISOLATION_FAILURE_CODES],
    ['release_kind', ISOLATION_RELEASE_KINDS],
    ['requested_by_kind', ISOLATION_REQUESTED_BY_KINDS],
    ['mechanism', ISOLATION_MECHANISMS],
  ] as const)('%s CHECK lists exactly the shared members', (column, members) => {
    const match = new RegExp(`device_network_isolations_${column}_chk CHECK \\([^()]*${column} IN \\(([^)]*)\\)\\)`).exec(normalized());
    expect(match, `no CHECK found for ${column}`).not.toBeNull();
    const listed = (match?.[1] ?? '').split(',').map((v) => v.trim().replace(/^'|'$/g, '')).filter(Boolean).sort();
    expect(listed).toEqual([...members].sort());
  });

  it('keeps the hard-coded index predicates in step with the shared state sets', () => {
    expect([...RESOLVED_TERMINAL_STATES].sort()).toEqual([...RESOLVED_TERMINAL].sort());
    expect([...ACTIVE_STATES].sort()).toEqual([...ACTIVE].sort());
  });

  it('never opens its own transaction', () => {
    expect(sqlText()).not.toMatch(/^\s*BEGIN\s*;/im);
    expect(sqlText()).not.toMatch(/^\s*COMMIT\s*;/im);
  });
});
