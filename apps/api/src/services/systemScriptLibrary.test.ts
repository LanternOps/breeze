import { describe, expect, it, vi, beforeEach } from 'vitest';
import { spawnSync } from 'node:child_process';

const h = vi.hoisted(() => ({
  cuts: [] as Array<{ scriptId: string; provenance: Record<string, unknown> }>,
}));

vi.mock('../db', () => {
  const db = {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    // The sync runs its insert/update + version cut inside db.transaction; the
    // `tx` handed to the callback is `db` itself, so the per-test
    // mockReturnValue queues below work unchanged.
    transaction: vi.fn((fn: (tx: unknown) => unknown) => fn(db)),
  };
  return { db };
});

vi.mock('./scriptVersions', () => ({
  cutScriptVersion: vi.fn((_tx: unknown, args: { scriptId: string; provenance: Record<string, unknown> }) => {
    h.cuts.push(args);
    return Promise.resolve({ id: 'version-row', scriptId: args.scriptId, version: 1 });
  }),
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
    origin: 'origin',
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

// #5016 — the script used to run the whole uninstall -> restore -> install
// dance inside the agent's own script process. The uninstall stops that agent,
// and a script cannot outlive its agent: current agents contain every script in
// a KILL_ON_JOB_CLOSE Job Object (agent/internal/executor/job.go), which the
// kernel fires the moment the agent process exits — killing the script between
// the uninstall and the install and leaving the device agent-less. Only a
// script that EXITS NORMALLY gets its containment released (releaseContainment)
// so detached descendants survive. So the destructive leg must run in a
// detached stage 2 that starts only after stage 1 has exited.
describe('edition migration hand-off to a detached stage 2 (#5016)', () => {
  const content = () => editionMigration!.content;
  const stage2 = () => {
    const c = content();
    const start = c.indexOf("$stage2Script = @'");
    const end = c.indexOf("\n'@", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return c.slice(start, end);
  };
  const stage1 = () => content().replace(stage2(), '');

  it('stage 1 (the agent-hosted process) never runs msiexec itself', () => {
    expect(stage1()).not.toMatch(/msiexec/i);
    expect(stage2()).toMatch(/'\/x \{0\}/);
    expect(stage2()).toMatch(/'\/i "\{0\}"/);
  });

  it('stage 1 launches stage 2 as a separate hidden powershell and exits 0 only after a go marker', () => {
    const s1 = stage1();
    expect(s1).toMatch(/Start-Process -FilePath \$psExe/);
    expect(s1).toContain('-ParentPid');
    const go = s1.indexOf('Set-Content -LiteralPath $go');
    expect(go).toBeGreaterThan(-1);
    // The go marker is the LAST thing stage 1 does before exit 0: stage 2 aborts
    // (nothing touched) unless stage 1 got all the way through.
    expect(s1.slice(go)).toMatch(/^Set-Content -LiteralPath \$go[^\n]*\n\s*exit 0/);
  });

  it('stage 2 waits for stage 1 to exit and checks the go marker before uninstalling', () => {
    const s2 = stage2();
    const wait = s2.indexOf('Wait-Process -Id $ParentPid');
    const goCheck = s2.indexOf('Test-Path -LiteralPath $go');
    const uninstall = s2.indexOf("'/x {0}");
    expect(wait).toBeGreaterThan(-1);
    expect(goCheck).toBeGreaterThan(wait);
    expect(uninstall).toBeGreaterThan(goCheck);
  });

  it('stage 2 never writes to stdout/stderr (nothing reads them once the agent is gone)', () => {
    expect(stage2()).not.toMatch(/Write-(Output|Host|Error|Warning)/);
  });

  it('stage 2 retries msiexec on 1618 (another installation in progress)', () => {
    expect(stage2()).toContain('1618');
  });

  it('stage 2 keeps the identity backup unless the agent is confirmed running', () => {
    const s2 = stage2();
    const cleanup = s2.indexOf('Remove-Item -LiteralPath $bak');
    const running = s2.indexOf("BreezeAgent running'");
    expect(running).toBeGreaterThan(-1);
    expect(cleanup).toBeGreaterThan(running);
  });

  it('stage 1 refuses a work dir owned by anyone but SYSTEM/Administrators (stage 2 runs from it as SYSTEM)', () => {
    const s1 = stage1();
    expect(s1).toContain('GetOwner([System.Security.Principal.SecurityIdentifier])');
    expect(s1).toContain("'S-1-5-18'");
    expect(s1).toContain("'S-1-5-32-544'");
  });

  it('stage 1 never re-uses a work dir it did not create or verify, and re-checks it after locking the ACL', () => {
    const s1 = stage1();
    // Created without -Force: if something appeared at the path after the
    // checks (a planted junction), creation fails and the script aborts.
    expect(s1).toContain('New-Item -ItemType Directory -Path $work -ErrorAction Stop');
    expect(s1).not.toMatch(/New-Item -ItemType Directory -Force -Path \$work/);
    // After icacls, the dir and every top-level entry must be a non-link owned
    // by SYSTEM/Administrators — a child planted before the ACL landed aborts.
    const lock = s1.indexOf('& icacls $work');
    const recheck = s1.indexOf('Get-ChildItem -LiteralPath $work -Force');
    expect(lock).toBeGreaterThan(-1);
    expect(recheck).toBeGreaterThan(lock);
  });

  // Parses both stages with the real PowerShell parser when pwsh is on PATH
  // (developer machines); CI images without pwsh skip it.
  const hasPwsh = spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0']).status === 0;
  it.runIf(hasPwsh)('both stages parse without PowerShell syntax errors', () => {
    for (const [label, src] of [['stage1', content()], ['stage2', stage2().replace("$stage2Script = @'\n", '')]] as const) {
      const r = spawnSync(
        'pwsh',
        [
          '-NoProfile',
          '-Command',
          '$e=$null; [void][System.Management.Automation.Language.Parser]::ParseInput([Console]::In.ReadToEnd(), [ref]$null, [ref]$e); if ($e.Count) { $e | ForEach-Object { $_.ToString() }; exit 1 }',
        ],
        { input: src, encoding: 'utf8' },
      );
      expect(r.status, `${label}: ${r.stdout}${r.stderr}`).toBe(0);
    }
  });
});

describe('ensureSystemLibraryScripts', () => {
  beforeEach(() => {
    vi.mocked(db.select).mockReset();
    vi.mocked(db.insert).mockReset();
    vi.mocked(db.update).mockReset();
    h.cuts = [];
  });

  function mockExisting(rows: Array<Record<string, unknown>>) {
    const limit = vi.fn().mockResolvedValue(rows);
    const where = vi.fn(() => ({ limit }));
    const from = vi.fn(() => ({ where }));
    vi.mocked(db.select).mockReturnValue({ from } as never);
  }

  function mockInsert() {
    const values = vi.fn((vals: Record<string, unknown>) => ({
      returning: vi.fn().mockResolvedValue([{ id: `created-${vals.name as string}` }]),
    }));
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
      origin: 'system',
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
    // #5671: the insert must not fall through to the schema default
    // ('human') — it would contradict the origin='system' the very same
    // transaction writes onto the version row via cutScriptVersion below.
    expect(inserted.origin).toBe('system');
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
    // W01a: cutScriptVersion owns the bump — a second one here would skip a
    // number and break UNIQUE-backed history.
    expect(patch).not.toHaveProperty('version');
    expect(h.cuts).toHaveLength(1);
    expect(h.cuts[0]!.provenance).toMatchObject({ origin: 'system', createdBy: null });
  });

  it('cuts a system-origin version for a newly created library script', async () => {
    mockExisting([]);
    const values = mockInsert();

    const result = await ensureSystemLibraryScripts();

    expect(result.created).toBe(SYSTEM_LIBRARY_SCRIPTS.length);
    expect(h.cuts).toHaveLength(SYSTEM_LIBRARY_SCRIPTS.length);
    expect(h.cuts[0]!.provenance).toMatchObject({
      origin: 'system',
      changelog: 'Shipped system library definition',
      createdBy: null,
    });
    // Inserted at 0 so the cut produces 1; 0 never escapes the transaction.
    expect(values.mock.calls[0]![0]).toMatchObject({ version: 0, isSystem: true });
  });

  it('cuts nothing when every shipped definition is unchanged', async () => {
    mockExisting([existingRowFor(editionMigration!)]);
    mockInsert();
    mockUpdate();

    await ensureSystemLibraryScripts();

    expect(h.cuts).toEqual([]);
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

  it('#5948: self-heals a stale origin="human" row whose definition is otherwise unchanged, without cutting a version', async () => {
    // Pre-#5671 rows were inserted with the schema default ('human') and the
    // insert-side fix (#5671/PR #5946) only corrects NEW inserts. The update
    // branch must self-heal `origin` on next sync even when nothing else in
    // the definition changed — but must NOT cut a spurious version, since
    // cutScriptVersion bumps `version` for what is actually a no-op definition
    // sync (that would skip a number and break UNIQUE-backed history).
    const stale = existingRowFor(editionMigration!);
    stale.origin = 'human';
    mockExisting([stale]);
    const values = mockInsert();
    const { set } = mockUpdate();

    const result = await ensureSystemLibraryScripts();

    expect(set).toHaveBeenCalledTimes(1);
    const patch = set.mock.calls[0]![0];
    expect(patch.origin).toBe('system');
    // The definition body itself did not change, so the self-heal patch is
    // origin-only — it must not touch content/category/etc.
    expect(patch).not.toHaveProperty('content');
    expect(values).not.toHaveBeenCalled();
    expect(h.cuts).toEqual([]);
    expect(result.updated).toBeGreaterThan(0);
    expect(result.unchanged).toBe(0);
  });

  it('#5948: corrects a stale origin="human" row AND cuts a version when the definition also changed', async () => {
    const stale = existingRowFor(editionMigration!);
    stale.origin = 'human';
    stale.content = '# stale content';
    mockExisting([stale]);
    const { set } = mockUpdate();

    await ensureSystemLibraryScripts();

    const patch = set.mock.calls[0]![0];
    expect(patch.origin).toBe('system');
    expect(patch.content).toBe(editionMigration!.content);
    expect(h.cuts).toHaveLength(1);
    expect(h.cuts[0]!.provenance).toMatchObject({ origin: 'system' });
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
