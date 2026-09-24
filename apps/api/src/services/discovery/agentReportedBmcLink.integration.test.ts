import '../../__tests__/integration/setup';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { getTestDb } from '../../__tests__/integration/setup';
import { discoveredAssetLinkSourceEnum } from '../../db/schema/discovery';

it('appends agent_report through an enum-only idempotent migration', async () => {
  const path = new URL('../../../migrations/2026-10-30-110400-discovered-asset-link-source-agent-report.sql', import.meta.url);
  const ddl = readFileSync(path, 'utf8');
  expect(ddl.trim()).toBe("ALTER TYPE discovered_asset_link_source ADD VALUE IF NOT EXISTS 'agent_report';");
  await getTestDb().execute(sql.raw(ddl));
  await getTestDb().execute(sql.raw(ddl));
  const rows = await getTestDb().execute(sql`
    SELECT enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'discovered_asset_link_source' ORDER BY enumsortorder`);
  expect(rows.map(row => row.enumlabel)).toEqual(['manual', 'auto', 'agent_report']);
  expect(discoveredAssetLinkSourceEnum.enumValues).toEqual(['manual', 'auto', 'agent_report']);
});
