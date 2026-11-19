import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { agentOsFloorRefusal, commandOsFloorComponent } from './agentOsFloorCommands';

/**
 * A reader whose successive `select(...)…limit()` calls resolve to the queued
 * row sets: first the device, then the agent_versions row.
 */
function reader(results: unknown[][]) {
  const queue = [...results];
  const wheres: unknown[] = [];
  const select = vi.fn(() => {
    const rows = queue.shift() ?? [];
    const chain: Record<string, unknown> = {};
    chain.from = vi.fn(() => chain);
    chain.where = vi.fn((w: unknown) => {
      wheres.push(w);
      return chain;
    });
    chain.orderBy = vi.fn(() => chain);
    chain.limit = vi.fn(async () => rows);
    return chain;
  });
  return { reader: { select } as never, select, wheres };
}

const darwin = (osVersion: string | null) => ({ osType: 'macos', osVersion, architecture: 'arm64' });

describe('commandOsFloorComponent', () => {
  it('covers update, update_agent and update_watchdog only', () => {
    expect(commandOsFloorComponent('update')).toBe('agent');
    expect(commandOsFloorComponent('update_agent')).toBe('agent');
    expect(commandOsFloorComponent('update_watchdog')).toBe('watchdog');
    expect(commandOsFloorComponent('agent_rollback_v1')).toBeNull();
    expect(commandOsFloorComponent('dev_update')).toBeNull();
    expect(commandOsFloorComponent('run_script')).toBeNull();
  });
});

describe('agentOsFloorRefusal (#12169)', () => {
  it('refuses update_agent to a 13.0 build on darwin 12.7.6', async () => {
    const r = reader([[darwin('darwin 12.7.6')], [{ minOsVersion: '13.0' }]]);
    await expect(
      agentOsFloorRefusal(r.reader, { type: 'update_agent', deviceId: 'd1', payload: { version: '0.140.0' } }),
    ).resolves.toBe('os_below_minimum');
  });

  it('allows on darwin 13.1', async () => {
    const r = reader([[darwin('darwin 13.1')], [{ minOsVersion: '13.0' }]]);
    await expect(
      agentOsFloorRefusal(r.reader, { type: 'update_agent', deviceId: 'd1', payload: { version: '0.140.0' } }),
    ).resolves.toBeNull();
  });

  it('refuses an unknown macOS version when the build has a floor', async () => {
    const r = reader([[darwin('darwin')], [{ minOsVersion: '13.0' }]]);
    await expect(
      agentOsFloorRefusal(r.reader, { type: 'update_watchdog', deviceId: 'd1', payload: { version: '0.140.0' } }),
    ).resolves.toBe('os_version_unknown');
  });

  it('version-less payload is judged by the promoted row', async () => {
    const r = reader([[darwin('darwin 12.7.6')], [{ minOsVersion: '13.0' }]]);
    await expect(agentOsFloorRefusal(r.reader, { type: 'update', deviceId: 'd1', payload: {} })).resolves.toBe(
      'os_below_minimum',
    );
    const { params } = new PgDialect().sqlToQuery(r.wheres[1] as never);
    expect(params).toContain(true); // is_latest = true
  });

  it('judges the exact payload version and the watchdog component', async () => {
    const r = reader([[darwin('darwin 12.7.6')], [{ minOsVersion: null }]]);
    await expect(
      agentOsFloorRefusal(r.reader, { type: 'update_watchdog', deviceId: 'd1', payload: { version: '0.140.0' } }),
    ).resolves.toBeNull();
    const { params } = new PgDialect().sqlToQuery(r.wheres[1] as never);
    expect(params).toEqual(expect.arrayContaining(['macos', 'arm64', 'watchdog', '0.140.0']));
  });

  it('rollback and dev_update are untouched (no reads)', async () => {
    const r = reader([]);
    await expect(
      agentOsFloorRefusal(r.reader, { type: 'agent_rollback_v1', deviceId: 'd1', payload: { targetVersion: '0.1.0' } }),
    ).resolves.toBeNull();
    await expect(agentOsFloorRefusal(r.reader, { type: 'dev_update', deviceId: 'd1', payload: {} })).resolves.toBeNull();
    expect(r.select).not.toHaveBeenCalled();
  });

  it('a non-mac device costs one read and is never refused', async () => {
    const r = reader([[{ osType: 'windows', osVersion: 'Windows 11', architecture: 'amd64' }]]);
    await expect(
      agentOsFloorRefusal(r.reader, { type: 'update_agent', deviceId: 'd1', payload: { version: '0.140.0' } }),
    ).resolves.toBeNull();
    expect(r.select).toHaveBeenCalledTimes(1);
  });

  it('an unregistered version is not refused here (other gates own that)', async () => {
    const r = reader([[darwin('darwin 12.7.6')], []]);
    await expect(
      agentOsFloorRefusal(r.reader, { type: 'update_agent', deviceId: 'd1', payload: { version: '9.9.9' } }),
    ).resolves.toBeNull();
  });
});
