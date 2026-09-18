import { describe, expect, it } from 'vitest';
import { getTableColumns, getTableName } from 'drizzle-orm';
import { toolSources, toolSourceTools } from './toolSources';

describe('toolSources schema', () => {
  it('declares the dual-owner columns and the encrypted auth column on tool_sources', () => {
    expect(getTableName(toolSources)).toBe('tool_sources');
    const cols = Object.keys(getTableColumns(toolSources));
    for (const c of [
      'id',
      'orgId',
      'partnerId',
      'slug',
      'name',
      'kind',
      'endpointUrl',
      'credentialOrigin',
      'authKind',
      'authConfigEncrypted',
      'authFingerprint',
      'status',
      'lastDiscoveredAt',
      'lastError',
      'rateLimitPerMinute',
      'createdByUserId',
      'createdAt',
      'updatedAt',
    ]) {
      expect(cols).toContain(c);
    }
  });

  it('denormalises owner ids onto tool_source_tools and carries revision/review flags', () => {
    expect(getTableName(toolSourceTools)).toBe('tool_source_tools');
    const cols = Object.keys(getTableColumns(toolSourceTools));
    for (const c of [
      'id',
      'sourceId',
      'orgId',
      'partnerId',
      'name',
      'qualifiedName',
      'description',
      'inputSchema',
      'outputSchema',
      'annotations',
      'proposedTier',
      'tier',
      'enabled',
      'reviewNeeded',
      'revision',
      'lastError',
      'discoveredAt',
      'removedAt',
      'updatedAt',
    ]) {
      expect(cols).toContain(c);
    }
  });
});
