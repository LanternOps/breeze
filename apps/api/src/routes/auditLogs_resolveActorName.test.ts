import { describe, it, expect } from 'vitest';
import { resolveActorName, type DbRow } from './auditLogs';

// Minimal row factory — only the fields resolveActorName actually reads.
// resolveActorName reads row.userName, row.deviceHostname, row.deviceDisplayName,
// row.log.actorType, row.log.actorEmail, plus details.rawActorId.
function row(opts: {
  userName?: string | null;
  deviceHostname?: string | null;
  deviceDisplayName?: string | null;
  actorType: 'user' | 'api_key' | 'agent' | 'system';
  actorEmail?: string | null;
}): DbRow {
  return {
    log: {
      actorType: opts.actorType,
      actorEmail: opts.actorEmail ?? null,
    } as DbRow['log'],
    userName: opts.userName ?? null,
    deviceHostname: opts.deviceHostname ?? null,
    deviceDisplayName: opts.deviceDisplayName ?? null,
  };
}

describe('resolveActorName', () => {
  it('uses joined user name when present', () => {
    expect(
      resolveActorName(row({ userName: 'Alice', actorType: 'user', actorEmail: 'a@b.com' }))
    ).toBe('Alice');
  });

  it('returns "Agent (<hostname>)" for an agent action with a hostname (display name preferred)', () => {
    expect(
      resolveActorName(
        row({
          actorType: 'agent',
          deviceHostname: 'TS-Kim-XPS',
          deviceDisplayName: null,
        })
      )
    ).toBe('Agent (TS-Kim-XPS)');

    expect(
      resolveActorName(
        row({
          actorType: 'agent',
          deviceHostname: 'TS-Kim-XPS',
          deviceDisplayName: 'Kim Laptop',
        })
      )
    ).toBe('Agent (Kim Laptop)');
  });

  it('does NOT return the bare hostname for an agent action', () => {
    const result = resolveActorName(
      row({ actorType: 'agent', deviceHostname: 'TS-Kim-XPS' })
    );
    expect(result).not.toBe('TS-Kim-XPS');
  });

  it('falls back to "Agent <rawActorId-slice>" when no device joined', () => {
    expect(
      resolveActorName(row({ actorType: 'agent' }), {
        rawActorId: 'abcdef1234567890',
      })
    ).toBe('Agent abcdef12');
  });

  it('falls back to "Agent" when no device and no rawActorId', () => {
    expect(resolveActorName(row({ actorType: 'agent' }))).toBe('Agent');
  });

  it('returns "System" for system actor with no user join', () => {
    expect(resolveActorName(row({ actorType: 'system' }))).toBe('System');
  });

  it('returns actorEmail for api_key/user when present and no userName', () => {
    expect(
      resolveActorName(
        row({ actorType: 'api_key', actorEmail: 'svc@example.com' })
      )
    ).toBe('svc@example.com');
  });

  it('returns "API Key <slice>" for api_key with no email', () => {
    expect(
      resolveActorName(row({ actorType: 'api_key' }), {
        rawActorId: 'deadbeef1234',
      })
    ).toBe('API Key deadbeef');
  });
});
