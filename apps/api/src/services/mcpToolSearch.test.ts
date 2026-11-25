import { describe, expect, it } from 'vitest';
import { rankTools, tokenizeForSearch } from './mcpToolSearch';

const CATALOG = [
  { name: 'manage_patches', description: 'List, approve and install patches. Long text.', domain: 'patching', searchHint: 'patches, KBs, updates, approve, install' },
  { name: 'query_devices', description: 'Search devices by name, OS or status.', domain: 'core', searchHint: 'find devices, offline machines, inventory' },
  { name: 'manage_alerts', description: 'List and acknowledge alerts.', domain: 'monitoring', searchHint: 'alerts, acknowledge, resolve' },
  { name: 'get_device_details', description: 'Everything about one device.', domain: 'devices' },
  { name: 'acme__lookup_widget', description: 'Look up a widget in Acme.', domain: 'integrations' },
];

describe('rankTools', () => {
  it('ranks by the name, hint, first sentence and domain vocabulary', () => {
    expect(rankTools(CATALOG, 'which machines are offline')[0]).toBe('query_devices');
    expect(rankTools(CATALOG, 'approve the KB update')[0]).toBe('manage_patches');
    expect(rankTools(CATALOG, 'acknowledge the disk alert')[0]).toBe('manage_alerts');
  });
  it('ranks a tool with no searchHint (tenant/flow) on name and description', () => {
    expect(rankTools(CATALOG, 'widget lookup')[0]).toBe('acme__lookup_widget');
  });
  it('only the first sentence of a description counts', () => {
    expect(rankTools(CATALOG, 'long text')).not.toContain('manage_patches');
  });
  it('an exact name is pinned first even when another tool scores higher', () => {
    expect(rankTools(CATALOG, 'get_device_details')[0]).toBe('get_device_details');
    expect(rankTools(CATALOG, ' MANAGE_ALERTS ')[0]).toBe('manage_alerts');
  });
  it('domain filters before ranking; limit caps; nothing outside the catalog', () => {
    expect(rankTools(CATALOG, 'devices', { domain: 'patching' })).toEqual([]);
    expect(rankTools(CATALOG, 'device alerts patches widget', { limit: 2 })).toHaveLength(2);
    expect(rankTools(CATALOG, 'device').every((n) => CATALOG.some((t) => t.name === n))).toBe(true);
  });
  it('no matching term → no rows', () => {
    expect(rankTools(CATALOG, 'the of and')).toEqual([]);
  });
  it('tokenizes snake_case and folds plurals', () => {
    expect(tokenizeForSearch('Manage_Patches for devices')).toEqual(['manage', 'patch', 'device']);
  });
});
