/**
 * #8318 §5.8 — org-move parity. Every device-bound write and helper call of the
 * org-move engine has a counterpart in the install incarnation boundary, or is
 * listed as move-only with a reason (orgMoveParity.ts).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scanOrgMoveWrites } from '../../__tests__/helpers/orgMoveParityScan';
import { INSTALL_BOUNDARY_HANDLERS } from './index';
import { ORG_MOVE_PARITY } from './orgMoveParity';

const MOVE_ENGINE = join(__dirname, '../deviceOrgMove/moveDeviceOrgInTransaction.ts');

describe('org-move parity (#8318 §5.8)', () => {
  const scanned = scanOrgMoveWrites(readFileSync(MOVE_ENGINE, 'utf8'));

  it('the scan sees the move engine (guards against a scanner that silently matches nothing)', () => {
    expect(scanned.has('table:device_commands')).toBe(true);
    expect(scanned.has('call:revokeDiagnosticGrantsForMove')).toBe(true);
    expect(scanned.has('table:time_entries')).toBe(true); // a sql.identifier('...') write
    expect(scanned.has('sqlfn:breeze_rehome_device_custom_field_values')).toBe(true);
  });

  it('every write and call of the move is classified as boundary or move-only', () => {
    const unclassified = [...scanned].filter((key) => !(key in ORG_MOVE_PARITY)).sort();
    expect(unclassified, 'classify each in services/deviceInstallBoundary/orgMoveParity.ts').toEqual([]);
  });

  it('no entry is stale: each still occurs in the move engine', () => {
    const stale = Object.keys(ORG_MOVE_PARITY).filter((key) => !scanned.has(key)).sort();
    expect(stale).toEqual([]);
  });

  it('every boundary counterpart names tables its handler lists', () => {
    const handlers = new Map(INSTALL_BOUNDARY_HANDLERS.map((h) => [h.id, h]));
    const broken: string[] = [];
    for (const [key, entry] of Object.entries(ORG_MOVE_PARITY)) {
      if (!('boundary' in entry)) continue;
      const handler = handlers.get(entry.boundary);
      if (!handler) {
        broken.push(`${key}: no handler ${entry.boundary}`);
        continue;
      }
      for (const table of entry.tables) {
        if (!handler.tables.includes(table)) broken.push(`${key}: ${entry.boundary} does not list ${table}`);
      }
    }
    expect(broken).toEqual([]);
  });

  it('every move-only entry gives a reason', () => {
    for (const [key, entry] of Object.entries(ORG_MOVE_PARITY)) {
      if ('moveOnly' in entry) expect(entry.moveOnly.trim().length, key).toBeGreaterThan(10);
    }
  });
});

describe('orgMoveParityScan (the scanner bites)', () => {
  it('finds drizzle writes, raw writes, identifier writes, imported calls and db functions', () => {
    const fixture = `
      import { sql, eq } from 'drizzle-orm';
      import { deviceCommands } from '../../db/schema';
      import { revokeSomething } from '../somewhere';
      export async function f(tx: any, id: string) {
        await tx.update(deviceCommands).set({ status: 'cancelled' }).where(eq(deviceCommands.deviceId, id));
        await tx.execute(sql\`UPDATE new_grants SET revoked_at = now() WHERE device_id = \${id}\`);
        await tx.execute(sql\`DELETE FROM new_sessions WHERE device_id = \${id}\`);
        await tx.execute(sql\`UPDATE \${sql.identifier('new_children')} SET org_id = \${id}\`);
        await tx.execute(sql\`SELECT * FROM public.breeze_new_fn(\${id})\`);
        await revokeSomething(tx, id);
        localHelper();
      }
      function localHelper() {}
    `;
    const keys = scanOrgMoveWrites(fixture, 'fixture.ts');
    expect([...keys].sort()).toEqual([
      'call:revokeSomething',
      'sqlfn:breeze_new_fn',
      'table:device_commands',
      'table:new_children',
      'table:new_grants',
      'table:new_sessions',
    ]);
  });

  it('a new write in the move engine fails the classification', () => {
    const moved = readFileSync(MOVE_ENGINE, 'utf8').replace(
      'export async function moveDeviceOrgInTransaction(',
      'async function injected(tx: any) { await tx.execute(sql`UPDATE some_new_grant_table SET revoked = true`); }\nexport async function moveDeviceOrgInTransaction(',
    );
    const unclassified = [...scanOrgMoveWrites(moved)].filter((key) => !(key in ORG_MOVE_PARITY));
    expect(unclassified).toEqual(['table:some_new_grant_table']);
  });
});
