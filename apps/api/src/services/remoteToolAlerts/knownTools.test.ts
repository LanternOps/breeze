import { describe, expect, it } from 'vitest';
import { appearedRemoteTools } from './knownTools';

// #11306 — which RMM / remote access tools a management-posture scan added.

function posture(categories: Record<string, Array<{ name: unknown; status?: string }>>) {
  return { collectedAt: '2026-11-06T10:00:00.000Z', scanDurationMs: 10, categories, identity: { joinType: 'none' } };
}

describe('appearedRemoteTools', () => {
  it('raises nothing on the first scan: no stored posture is the baseline', () => {
    const first = posture({ remoteAccess: [{ name: 'Splashtop', status: 'active' }], rmm: [{ name: 'ScreenConnect' }] });
    expect(appearedRemoteTools(null, first)).toEqual([]);
    expect(appearedRemoteTools(undefined, first)).toEqual([]);
    // A stored value with no categories object is not a usable baseline either.
    expect(appearedRemoteTools({}, first)).toEqual([]);
    expect(appearedRemoteTools({ categories: null }, first)).toEqual([]);
  });

  it('reports a remote access tool the previous scan did not have', () => {
    const before = posture({ remoteAccess: [{ name: 'Splashtop', status: 'active' }] });
    const after = posture({ remoteAccess: [{ name: 'Splashtop', status: 'active' }, { name: 'UltraViewer', status: 'installed' }] });
    expect(appearedRemoteTools(before, after)).toEqual([{ name: 'UltraViewer', category: 'remoteAccess', status: 'installed' }]);
  });

  it('reports a new RMM agent too, and a tool appearing in a category the previous scan had none of', () => {
    const before = posture({ mdm: [{ name: 'Intune' }] });
    const after = posture({ rmm: [{ name: 'ScreenConnect', status: 'active' }], remoteAccess: [{ name: 'AnyDesk' }] });
    expect(appearedRemoteTools(before, after)).toEqual([
      { name: 'AnyDesk', category: 'remoteAccess', status: null },
      { name: 'ScreenConnect', category: 'rmm', status: 'active' },
    ]);
  });

  it('ignores a status change, a reorder and a tool that went away', () => {
    const before = posture({ remoteAccess: [{ name: 'AnyDesk', status: 'active' }, { name: 'TeamViewer', status: 'active' }] });
    const after = posture({ remoteAccess: [{ name: 'AnyDesk', status: 'installed' }] });
    expect(appearedRemoteTools(before, after)).toEqual([]);
  });

  it('reports a tool that went away and came back', () => {
    const had = posture({ remoteAccess: [{ name: 'AnyDesk' }] });
    const gone = posture({ remoteAccess: [] });
    expect(appearedRemoteTools(had, gone)).toEqual([]);
    expect(appearedRemoteTools(gone, had)).toEqual([{ name: 'AnyDesk', category: 'remoteAccess', status: null }]);
  });

  it('matches a tool by name across both categories', () => {
    const before = posture({ rmm: [{ name: 'MeshCentral' }] });
    const after = posture({ remoteAccess: [{ name: 'MeshCentral' }] });
    expect(appearedRemoteTools(before, after)).toEqual([]);
  });

  it('takes the category from the known-tool list, not from the agent', () => {
    const before = posture({ rmm: [] });
    const after = posture({ rmm: [{ name: 'UltraViewer' }] });
    expect(appearedRemoteTools(before, after)).toEqual([{ name: 'UltraViewer', category: 'remoteAccess', status: null }]);
  });

  it('ignores names that are not agent signatures, other categories, and malformed entries', () => {
    const before = posture({ remoteAccess: [] });
    const after = posture({
      remoteAccess: [{ name: 'Totally Legit Tool' }, { name: 42 }, { name: '' }, { name: 'constructor' }],
      endpointSecurity: [{ name: 'SentinelOne' }],
      mdm: [{ name: 'TeamViewer' }],
    });
    expect(appearedRemoteTools(before, after)).toEqual([]);
  });

  it('raises nothing when the previous scan could not list processes: its tool list is incomplete', () => {
    // agent/internal/mgmtdetect/runner.go records "process snapshot: <err>" and
    // carries on with an empty process list, so tools seen only by a running
    // process drop out of that scan and would look new on the next one.
    const degraded = { ...posture({ remoteAccess: [] }), errors: ['process snapshot: access is denied'] };
    const after = posture({ remoteAccess: [{ name: 'Ammyy Admin', status: 'active' }] });
    expect(appearedRemoteTools(degraded, after)).toEqual([]);
  });

  it('still compares when the previous scan had an unrelated error', () => {
    const before = { ...posture({ remoteAccess: [] }), errors: ['identity detection panic: boom'] };
    const after = posture({ remoteAccess: [{ name: 'AnyDesk', status: 'active' }] });
    expect(appearedRemoteTools(before, after)).toEqual([{ name: 'AnyDesk', category: 'remoteAccess', status: 'active' }]);
  });

  it('reports a tool listed twice once', () => {
    const before = posture({});
    const after = posture({ remoteAccess: [{ name: 'RustDesk' }, { name: 'RustDesk' }] });
    expect(appearedRemoteTools(before, after)).toHaveLength(1);
  });
});
