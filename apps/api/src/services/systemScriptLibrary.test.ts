import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../db', () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn() },
}));

vi.mock('../db/schema', () => ({
  scripts: {
    id: 'id',
    name: 'name',
    description: 'description',
    category: 'category',
    osTypes: 'osTypes',
    language: 'language',
    content: 'content',
    parameters: 'parameters',
    timeoutSeconds: 'timeoutSeconds',
    runAs: 'runAs',
    isSystem: 'isSystem',
    version: 'version',
    updatedAt: 'updatedAt',
    deletedAt: 'deletedAt',
  },
}));

vi.mock('drizzle-orm', () => ({
  and: vi.fn((...args: unknown[]) => ({ __and: args })),
  eq: vi.fn((col: unknown, val: unknown) => ({ __eq: [col, val] })),
}));

import {
  scriptParameterDefinitionsSchema,
  scriptParameterEnvName,
} from '@breeze/shared';
import { db } from '../db';
import {
  SYSTEM_LIBRARY_SCRIPTS,
  ensureSystemLibraryScripts,
} from './systemScriptLibrary';

const editionMigration = SYSTEM_LIBRARY_SCRIPTS.find(
  (s) => s.name === 'Migrate Agent Edition (Windows)'
);

describe('SYSTEM_LIBRARY_SCRIPTS definitions', () => {
  it('includes the edition migration script with the expected dispatch shape', () => {
    expect(editionMigration).toBeDefined();
    expect(editionMigration?.language).toBe('powershell');
    expect(editionMigration?.osTypes).toEqual(['windows']);
    expect(editionMigration?.runAs).toBe('system');
    expect(editionMigration?.timeoutSeconds).toBe(1800);
  });

  it('declares parameters that pass the real shared definitions schema', () => {
    for (const def of SYSTEM_LIBRARY_SCRIPTS) {
      const parsed = scriptParameterDefinitionsSchema.safeParse(def.parameters ?? []);
      expect(parsed.success, `${def.name}: ${JSON.stringify(parsed.success ? '' : parsed.error.issues)}`).toBe(true);
    }
  });

  it('edition migration declares msi_url, msi_sha256 and target_edition as required', () => {
    const byName = new Map((editionMigration?.parameters ?? []).map((p) => [p.name, p]));
    expect([...byName.keys()].sort()).toEqual(['msi_sha256', 'msi_url', 'target_edition']);
    for (const p of byName.values()) expect(p.required).toBe(true);
    const target = byName.get('target_edition');
    expect(target?.type).toBe('select');
    expect(target?.options).toBe('hosted,self-hosted');
    expect(target?.defaultValue).toBe('hosted');
  });

  it('script content reads every declared parameter via its BREEZE_PARAM_ env var', () => {
    for (const def of SYSTEM_LIBRARY_SCRIPTS) {
      for (const p of def.parameters ?? []) {
        expect(def.content).toContain(`$env:${scriptParameterEnvName(p.name)}`);
      }
    }
  });

  it('content embeds no presigned URLs, bucket hosts, or pinned hashes', () => {
    for (const def of SYSTEM_LIBRARY_SCRIPTS) {
      expect(def.content).not.toMatch(/X-Amz|digitaloceanspaces|amazonaws|breeze-uploads/i);
      // A 64-hex literal would be a baked-in artifact hash — the pin must be a parameter.
      expect(def.content).not.toMatch(/[0-9a-f]{64}/i);
    }
  });

  it('edition migration treats MSI reboot-required exit codes as success', () => {
    // 3010 (ERROR_SUCCESS_REBOOT_REQUIRED) / 1641: /qn /norestart reports
    // these on SUCCESS. Treating them as failure would abort after the
    // uninstall completed, stranding the device agent-less (review finding).
    expect(editionMigration!.content).toContain('@(0, 3010, 1641)');
    expect(editionMigration!.content).not.toMatch(/\$p\.ExitCode -ne 0\) \{ Log 'uninstall failed/);
  });

  it('content avoids the agent SecurityLevelStrict blocked tokens', () => {
    // Partial local mirror of agent/internal/executor/security.go (the
    // credential-tool tokens are obfuscated there and cannot drift here).
    const blocked = [
      /Invoke-WebRequest.*\|\s*Invoke-Expression/i,
      /IEX\s*\(\s*\(New-Object/i,
      /DownloadString\s*\(/i,
      /Get-Credential/i,
      /ConvertTo-SecureString/i,
      /schtasks\s+/i,
      /Register-ScheduledTask/i,
      /New-Service/i,
      /reg\s+add\s+HKLM/i,
      /Set-ItemProperty\s+.*HKLM/i,
      /New-ItemProperty\s+.*HKLM/i,
      /net\s+localgroup\s+administrators/i,
      /format\s+[a-zA-Z]:/i,
    ];
    for (const def of SYSTEM_LIBRARY_SCRIPTS) {
      for (const pattern of blocked) {
        expect(def.content).not.toMatch(pattern);
      }
    }
  });
});

describe('ensureSystemLibraryScripts', () => {
  beforeEach(() => {
    vi.mocked(db.select).mockReset();
    vi.mocked(db.insert).mockReset();
    vi.mocked(db.update).mockReset();
  });

  function mockExisting(rows: Array<Record<string, unknown>>) {
    const limit = vi.fn().mockResolvedValue(rows);
    const where = vi.fn(() => ({ limit }));
    const from = vi.fn(() => ({ where }));
    vi.mocked(db.select).mockReturnValue({ from } as never);
  }

  function mockInsert() {
    const values = vi.fn().mockResolvedValue(undefined);
    vi.mocked(db.insert).mockReturnValue({ values } as never);
    return values;
  }

  function mockUpdate() {
    const where = vi.fn().mockResolvedValue(undefined);
    const set = vi.fn((_patch: Record<string, unknown>) => ({ where }));
    vi.mocked(db.update).mockReturnValue({ set } as never);
    return { set, where };
  }

  function existingRowFor(def: NonNullable<typeof editionMigration>): Record<string, unknown> {
    return {
      id: '3f6f0a4e-8c7e-4a6a-9a53-0d1e51f9a001',
      description: def.description,
      category: def.category,
      osTypes: def.osTypes,
      language: def.language,
      content: def.content,
      parameters: def.parameters,
      timeoutSeconds: def.timeoutSeconds,
      runAs: def.runAs,
      version: 1,
      deletedAt: null,
    };
  }

  it('inserts a missing system script with org/partner NULL and isSystem true', async () => {
    mockExisting([]);
    const values = mockInsert();

    const result = await ensureSystemLibraryScripts();

    expect(result.created).toBe(SYSTEM_LIBRARY_SCRIPTS.length);
    expect(values).toHaveBeenCalledTimes(SYSTEM_LIBRARY_SCRIPTS.length);
    const inserted = values.mock.calls[0]![0] as Record<string, unknown>;
    expect(inserted.isSystem).toBe(true);
    expect(inserted.orgId).toBeNull();
    expect(inserted.partnerId).toBeNull();
    expect(inserted.name).toBe(SYSTEM_LIBRARY_SCRIPTS[0]!.name);
  });

  it('no-ops when the stored row already matches the definition', async () => {
    mockExisting([existingRowFor(editionMigration!)]);
    const values = mockInsert();
    const { set } = mockUpdate();

    const result = await ensureSystemLibraryScripts();

    expect(result.unchanged).toBeGreaterThan(0);
    expect(result.created).toBe(0);
    expect(result.updated).toBe(0);
    expect(values).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
  });

  it('updates in place and bumps version when the definition changed', async () => {
    const stale = existingRowFor(editionMigration!);
    stale.content = '# stale content';
    stale.version = 3;
    mockExisting([stale]);
    const { set } = mockUpdate();

    const result = await ensureSystemLibraryScripts();

    expect(result.updated).toBeGreaterThan(0);
    const patch = set.mock.calls[0]![0];
    expect(patch.content).toBe(editionMigration!.content);
    expect(patch.version).toBe(4);
  });

  it('revokes any security acknowledgement when it replaces the content (#5129)', async () => {
    // The library sync rewrites `content` from a shipped definition with no
    // human in the loop. Only a system-scope PUT can put an acknowledgement on
    // a system script in the first place, so this is rarely non-empty — but the
    // invariant "a wholesale content replacement never inherits an approval"
    // has to hold on every path, not only the ones that are easy to reach.
    const stale = existingRowFor(editionMigration!);
    stale.content = '# stale content';
    stale.acknowledgedSecurityPatterns = ['PowerShell HKLM modification'];
    stale.securityAcknowledgedBy = 'someone-who-approved-the-old-body';
    stale.securityAcknowledgedAt = new Date('2026-01-01T00:00:00.000Z');
    mockExisting([stale]);
    const { set } = mockUpdate();

    await ensureSystemLibraryScripts();

    const patch = set.mock.calls[0]![0];
    expect(patch.acknowledgedSecurityPatterns).toEqual([]);
    expect(patch.securityAcknowledgedBy).toBeNull();
    expect(patch.securityAcknowledgedAt).toBeNull();
    // Guards the guard: the content really was replaced, so the revocation is
    // about a rewritten body rather than a no-op sync.
    expect(patch.content).toBe(editionMigration!.content);
  });

  it('leaves the acknowledgement alone on a metadata-only sync (#5129)', async () => {
    // The sync branch fires on ANY tracked-field diff, not just a content one.
    // A release that bumps only `timeoutSeconds` leaves the reviewed body
    // byte-identical, so revoking there would break the script on the next API
    // boot for no reason. Revocation is keyed to the BODY changing.
    const metadataOnly = existingRowFor(editionMigration!);
    metadataOnly.timeoutSeconds = (editionMigration!.timeoutSeconds ?? 300) + 60;
    metadataOnly.acknowledgedSecurityPatterns = ['PowerShell HKLM modification'];
    metadataOnly.securityAcknowledgedBy = 'admin-who-approved-this-body';
    mockExisting([metadataOnly]);
    const { set } = mockUpdate();

    await ensureSystemLibraryScripts();

    const patch = set.mock.calls[0]![0];
    // Guards the guard: the sync really did run an update (so this is not a
    // no-op path), and it really did leave the content alone.
    expect(patch.timeoutSeconds).toBe(editionMigration!.timeoutSeconds);
    expect(patch.content).toBe(editionMigration!.content);
    expect(patch).not.toHaveProperty('acknowledgedSecurityPatterns');
    expect(patch).not.toHaveProperty('securityAcknowledgedBy');
    expect(patch).not.toHaveProperty('securityAcknowledgedAt');
  });

  it('never resurrects or edits a soft-deleted system script', async () => {
    const deleted = existingRowFor(editionMigration!);
    deleted.deletedAt = new Date('2026-08-01T00:00:00Z');
    deleted.content = '# stale content';
    mockExisting([deleted]);
    const values = mockInsert();
    const { set } = mockUpdate();

    const result = await ensureSystemLibraryScripts();

    expect(result.skipped).toBeGreaterThan(0);
    expect(values).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
  });
});
