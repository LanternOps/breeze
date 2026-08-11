import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  DISCOVERED_ASSET_DETECTION_SOURCES,
  detectionSourceRank,
  buildClassificationWrite,
} from './discoveredAssetClassification';

// Render a drizzle `sql` fragment to the exact query Postgres would receive —
// see unifiSyncService.test.ts for why flattening `queryChunks` instead would
// hide an inverted guard.
function renderSql(value: unknown): string {
  return new PgDialect().sqlToQuery(value as never).sql;
}

describe('detectionSourceRank', () => {
  it('strictly increases across vendor_oui < agent_scan < unifi_controller', () => {
    const vendorOui = detectionSourceRank('vendor_oui');
    const agentScan = detectionSourceRank('agent_scan');
    const unifiController = detectionSourceRank('unifi_controller');

    expect(vendorOui).toBeLessThan(agentScan);
    expect(agentScan).toBeLessThan(unifiController);
  });

  it('gives every member of DISCOVERED_ASSET_DETECTION_SOURCES a finite, unique rank', () => {
    // Runtime companion to the compile-time exhaustive Record in
    // discoveredAssetClassification.ts: that catches a member added without a
    // rank at compile time, but not two members accidentally sharing a rank
    // (which would silently make one classifier unable to ever outrank the
    // other). This iterates the actual array rather than hardcoding the three
    // known sources, so it also covers whatever gets added next.
    const ranks = DISCOVERED_ASSET_DETECTION_SOURCES.map((source) => detectionSourceRank(source));

    for (const rank of ranks) {
      expect(Number.isFinite(rank)).toBe(true);
    }
    expect(new Set(ranks).size).toBe(ranks.length);
  });
});

describe('buildClassificationWrite', () => {
  // Update-path shape: the proposed value is a bound literal.
  const literalProposed = {
    assetType: sql`${'access_point'}`,
    detectedAssetType: sql`${'access_point'}`,
  };

  // ON CONFLICT DO UPDATE shape: the proposed value comes from the row we
  // tried to insert, never a value we read back — see buildClassificationWrite's
  // own doc comment on why every guard here must be pure SQL.
  const excludedProposed = {
    assetType: sql.raw('excluded.asset_type'),
    detectedAssetType: sql.raw('excluded.detected_asset_type'),
  };

  it('returns all three guarded columns', () => {
    const write = buildClassificationWrite('unifi_controller', literalProposed);

    expect(write).toHaveProperty('assetType');
    expect(write).toHaveProperty('detectedAssetType');
    expect(write).toHaveProperty('detectedTypeSource');
  });

  it('assetType renders with the manual arm first, then the rank guard, falling back to the existing column (a rejected write is a no-op, not NULL)', () => {
    const write = buildClassificationWrite('unifi_controller', literalProposed);
    const rendered = renderSql(write.assetType);

    expect(rendered).toBe(
      'case when "discovered_assets"."type_source" = \'manual\' then "discovered_assets"."asset_type" ' +
        'when case "discovered_assets"."detected_type_source" when $1 then $2 when $3 then $4 when $5 then $6 else 0 end <= $7 ' +
        'then $8 else "discovered_assets"."asset_type" end',
    );

    // The manual arm must be evaluated BEFORE the rank guard arm — a human
    // pin wins over every classifier regardless of rank.
    const manualArmIndex = rendered.indexOf('type_source" = \'manual\'');
    const rankGuardArmIndex = rendered.indexOf('detected_type_source" when');
    expect(manualArmIndex).toBeGreaterThanOrEqual(0);
    expect(rankGuardArmIndex).toBeGreaterThan(manualArmIndex);

    // A rejected write (both arms false) falls back to re-reading the row's
    // own existing asset_type — the update is a genuine no-op, never a NULL.
    expect(rendered.endsWith('else "discovered_assets"."asset_type" end')).toBe(true);
  });

  it('detectedAssetType has NO manual arm but DOES have the rank guard, falling back to the existing column', () => {
    const write = buildClassificationWrite('unifi_controller', literalProposed);
    const rendered = renderSql(write.detectedAssetType);

    expect(rendered).toBe(
      'case when case "discovered_assets"."detected_type_source" when $1 then $2 when $3 then $4 when $5 then $6 else 0 end <= $7 ' +
        'then $8 else "discovered_assets"."detected_asset_type" end',
    );
    // The latent "what did the machines think" column ignores the manual axis
    // entirely — "reset to auto" needs this to hold the best machine guess
    // even while a human override sits on asset_type.
    expect(rendered).not.toContain('manual');
    expect(rendered.endsWith('else "discovered_assets"."detected_asset_type" end')).toBe(true);
  });

  it('detectedTypeSource is guarded by rank and falls back to the existing column', () => {
    const write = buildClassificationWrite('agent_scan', literalProposed);
    const rendered = renderSql(write.detectedTypeSource);

    expect(rendered).toBe(
      'case when case "discovered_assets"."detected_type_source" when $1 then $2 when $3 then $4 when $5 then $6 else 0 end <= $7 ' +
        'then $8::discovered_asset_detection_source else "discovered_assets"."detected_type_source" end',
    );
    expect(rendered.endsWith('else "discovered_assets"."detected_type_source" end')).toBe(true);
  });

  it('the rank guard compares with <=, not < alone, so a source may refresh its own previous answer', () => {
    const write = buildClassificationWrite('unifi_controller', literalProposed);
    const rendered = renderSql(write.assetType);

    expect(rendered).toContain('<=');
    // The only comparison operator anywhere in this CASE must be `<=` — a bare
    // `<` would block a classifier from ever re-confirming its own prior
    // answer (e.g. a UniFi switch re-provisioned as a gateway).
    expect(rendered.replace(/<=/g, '')).not.toContain('<');
  });

  it('the stored-rank CASE ends in else 0, so a NULL stored detected_type_source ranks below every real source', () => {
    const write = buildClassificationWrite('vendor_oui', literalProposed);
    const rendered = renderSql(write.assetType);

    // vendor_oui is the weakest classifier (rank 10). If a NULL stored source
    // did not rank below it, the very first classifier to ever run on a row
    // would be blocked from writing — which would break every fresh
    // classification, not just precedence disputes between two classifiers.
    expect(rendered).toContain('else 0 end');
  });

  it('renders the (source, rank) ladder in DISCOVERED_ASSET_DETECTION_SOURCES order with the correct ranks bound', () => {
    const write = buildClassificationWrite('unifi_controller', literalProposed);
    const { params } = new PgDialect().sqlToQuery(write.assetType as never);

    // $1..$6 are the stored-rank CASE's (source, rank) arms, in ladder order;
    // $7 is the writing classifier's own rank (unifi_controller = 30).
    expect(params.slice(0, 6)).toEqual(['vendor_oui', 10, 'agent_scan', 20, 'unifi_controller', 30]);
    expect(params[6]).toBe(30);
  });

  it('an ON CONFLICT proposed value (sql.raw excluded.*) renders inline inside the CASE, not as a bound param', () => {
    const write = buildClassificationWrite('unifi_controller', excludedProposed);

    expect(renderSql(write.assetType)).toBe(
      'case when "discovered_assets"."type_source" = \'manual\' then "discovered_assets"."asset_type" ' +
        'when case "discovered_assets"."detected_type_source" when $1 then $2 when $3 then $4 when $5 then $6 else 0 end <= $7 ' +
        'then excluded.asset_type else "discovered_assets"."asset_type" end',
    );
    expect(renderSql(write.detectedAssetType)).toBe(
      'case when case "discovered_assets"."detected_type_source" when $1 then $2 when $3 then $4 when $5 then $6 else 0 end <= $7 ' +
        'then excluded.detected_asset_type else "discovered_assets"."detected_asset_type" end',
    );
  });
});
