import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { audit, publish, state } = vi.hoisted(() => ({
  audit: vi.fn(async () => {}),
  publish: vi.fn(async () => 1),
  state: {
    trustState: 'probation' as 'probation' | 'trusted' | 'restricted',
    probationEnrollments: 0,
    trustReviewRequestedAt: null as Date | null,
  },
}));

vi.mock('./auditService', () => ({ createAuditLog: audit }));
vi.mock('./redis', () => ({ getRedis: vi.fn(() => ({ publish })) }));
vi.mock('../config/partnerTrustMode', () => ({ partnerTrustMode: vi.fn(() => 'enforce') }));
vi.mock('../db', () => ({
  db: {},
  withSystemDbAccessContext: async (fn: () => unknown) => fn(),
  runOutsideDbContext: (fn: () => unknown) => fn(),
}));
vi.mock('./partnerTrust.repo', () => ({
  readTrust: vi.fn(async () => state),
  writeTrust: vi.fn(async () => {}),
  partnerForDevice: vi.fn(async () => 'p1'),
}));

import { partnerTrustMode } from '../config/partnerTrustMode';
import {
  evaluateCapability,
  GATED_COMMAND_TYPES,
  isLifecycleCommand,
  LIFECYCLE_COMMAND_TYPES,
  setTrustState,
} from './partnerTrust';
import { writeTrust } from './partnerTrust.repo';

function sourceFilesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFilesUnder(path);
    return entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')
      ? [path]
      : [];
  });
}

function addMatches(source: string, pattern: RegExp, commandTypes: Set<string>): void {
  for (const match of source.matchAll(pattern)) {
    const commandType = match[1];
    if (commandType) commandTypes.add(commandType);
  }
}

function dispatchedCommandTypeLiterals(): string[] {
  const srcDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const commandTypes = new Set<string>();

  for (const file of sourceFilesUnder(srcDirectory)) {
    const source = readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

    // Direct command queue/execution calls whose command type is a string literal.
    addMatches(
      source,
      /\b(?:queueCommand|queueCommandForExecution|executeCommand)\s*\(\s*[^,]+,\s*['"]([a-z][a-z0-9_]*)['"]/g,
      commandTypes,
    );
    // Direct agent sends with an inline command frame.
    addMatches(
      source,
      /\bsendCommandToAgent\s*\(\s*[^,]+,\s*\{[\s\S]{0,2000}?\btype\s*:\s*['"]([a-z][a-z0-9_]*)['"]/g,
      commandTypes,
    );
    // Direct deviceCommands inserts whose type is a string literal.
    addMatches(
      source,
      /\binsert\s*\(\s*deviceCommands\s*\)[\s\S]{0,2000}?\btype\s*:\s*['"]([a-z][a-z0-9_]*)['"]/g,
      commandTypes,
    );

    if (file.endsWith(`${join('services', 'commandQueue.ts')}`)) {
      const constants = source.match(/export const CommandTypes\s*=\s*\{([\s\S]*?)\}\s*as const/);
      expect(constants, 'CommandTypes constants object must remain discoverable').not.toBeNull();
      addMatches(constants?.[1] ?? '', /:\s*['"]([a-z][a-z0-9_]*)['"]/g, commandTypes);
    }
  }

  return [...commandTypes].sort();
}

function agentDispatcherCommandTypes(): { commandTypes: string[]; unresolvedConstants: string[]; files: string[] } {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
  const heartbeatDirectory = join(repoRoot, 'agent', 'internal', 'heartbeat');
  const toolsTypesFile = join(repoRoot, 'agent', 'internal', 'remote', 'tools', 'types.go');
  const handlerFiles = readdirSync(heartbeatDirectory)
    .filter((name) => /^handlers(?:_.*)?\.go$/.test(name) && !name.endsWith('_test.go'))
    .map((name) => join(heartbeatDirectory, name));
  const constantValues = new Map<string, string>();

  for (const file of [toolsTypesFile, ...handlerFiles]) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/\b(Cmd[A-Za-z0-9_]+)\s*=\s*"([a-z][a-z0-9_]*)"/g)) {
      if (match[1] && match[2]) constantValues.set(match[1], match[2]);
    }
  }

  const referencedConstants = new Set<string>();
  const commandTypes = new Set<string>();
  for (const file of handlerFiles) {
    const source = readFileSync(file, 'utf8');
    // handlers.go contains the primary dispatcher map; handlers_*.go extend it in init().
    const registryMap = source.match(
      /var handlerRegistry\s*=\s*map\[string\]CommandHandler\s*\{([\s\S]*?)^\}/m,
    )?.[1] ?? '';
    addMatches(registryMap, /^\s*"([a-z][a-z0-9_]*)"\s*:/gm, commandTypes);
    addMatches(source, /handlerRegistry\[\s*"([a-z][a-z0-9_]*)"\s*\]/g, commandTypes);
    for (const registrySource of [registryMap, source]) {
      const pattern = registrySource === registryMap
        ? /^\s*(?:tools\.)?(Cmd[A-Za-z0-9_]+)\s*:/gm
        : /handlerRegistry\[\s*(?:tools\.)?(Cmd[A-Za-z0-9_]+)\s*\]/g;
      for (const match of registrySource.matchAll(pattern)) {
        if (match[1]) referencedConstants.add(match[1]);
      }
    }
  }

  const unresolvedConstants = [...referencedConstants]
    .filter((name) => !constantValues.has(name))
    .sort();
  for (const name of referencedConstants) {
    const commandType = constantValues.get(name);
    if (commandType) commandTypes.add(commandType);
  }

  return {
    commandTypes: [...commandTypes].sort(),
    unresolvedConstants,
    files: [toolsTypesFile, ...handlerFiles],
  };
}

beforeEach(() => {
  audit.mockClear();
  publish.mockClear();
  vi.mocked(writeTrust).mockClear();
  state.trustState = 'probation';
  state.probationEnrollments = 0;
  vi.mocked(partnerTrustMode).mockReturnValue('enforce');
});

describe('setTrustState', () => {
  it('publishes the new trust state after persisting it', async () => {
    await setTrustState('p1', 'trusted', 'review approved', 'user-1');

    expect(writeTrust).toHaveBeenCalledWith('p1', 'trusted', 'review approved', 'user-1');
    expect(publish).toHaveBeenCalledWith(
      'partner-trust:changed',
      JSON.stringify({ partnerId: 'p1', trustState: 'trusted' }),
    );
    expect(vi.mocked(writeTrust).mock.invocationCallOrder[0])
      .toBeLessThan(publish.mock.invocationCallOrder[0]!);
  });
});

describe('evaluateCapability', () => {
  it.each(['remote_control', 'device_execute', 'installer_distribute'] as const)(
    'denies %s in probation',
    async (cap) => {
      const d = await evaluateCapability(cap, { partnerId: 'p1' });
      expect(d).toMatchObject({ allow: false, code: 'TRUST_PROBATION', capability: cap });
      expect(audit).toHaveBeenCalledWith(expect.objectContaining({
        action: 'partner.trust.capability_denied',
      }));
    },
  );

  it('denies with TRUST_RESTRICTED when restricted', async () => {
    state.trustState = 'restricted';
    expect(await evaluateCapability('remote_control', { partnerId: 'p1' }))
      .toMatchObject({ allow: false, code: 'TRUST_RESTRICTED' });
  });

  it('allows everything when trusted and writes no audit row', async () => {
    state.trustState = 'trusted';
    expect(await evaluateCapability('remote_control', { partnerId: 'p1' })).toEqual({ allow: true });
    expect(audit).not.toHaveBeenCalled();
  });

  it('allows enroll under the cap and denies at the cap', async () => {
    state.probationEnrollments = 4;
    expect(await evaluateCapability('agent_enroll', { partnerId: 'p1' })).toEqual({ allow: true });
    state.probationEnrollments = 5;
    expect(await evaluateCapability('agent_enroll', { partnerId: 'p1' }))
      .toMatchObject({ allow: false, reason: 'probation_enrollment_cap' });
  });

  it('uses the row-locked enrollment count from detail when supplied', async () => {
    state.probationEnrollments = 4;
    expect(await evaluateCapability('agent_enroll', {
      partnerId: 'p1',
      detail: { probationEnrollments: 5 },
    })).toMatchObject({ allow: false, reason: 'probation_enrollment_cap' });
  });

  it('writes only fixed, typed detail fields to denial audits', async () => {
    await evaluateCapability('remote_control', {
      partnerId: 'p1',
      deviceId: 'device-1',
      commandType: 'script',
      detail: {
        mode: 'forged',
        capability: 'forged',
        probationEnrollments: 5,
        stage: 'dispatch',
        via: 'api',
        untrustedExtra: 'must-not-leak',
      },
    });

    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      details: {
        mode: 'enforce',
        capability: 'remote_control',
        code: 'TRUST_PROBATION',
        reason: 'probation_default_deny',
        deviceId: 'device-1',
        commandType: 'script',
        probationEnrollments: 5,
        stage: 'dispatch',
        via: 'api',
      },
    }));
  });

  it('lets lifecycle commands through device_execute even in probation', async () => {
    expect(await evaluateCapability('device_execute', {
      partnerId: 'p1',
      commandType: 'self_uninstall',
    })).toEqual({ allow: true });
  });

  it('shadow mode allows but records the would-deny', async () => {
    vi.mocked(partnerTrustMode).mockReturnValue('shadow');
    const d = await evaluateCapability('remote_control', { partnerId: 'p1' });
    expect(d).toMatchObject({ allow: true, shadowDenied: { code: 'TRUST_PROBATION' } });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'partner.trust.capability_denied',
      details: expect.objectContaining({ mode: 'shadow' }),
    }));
  });

  it('off mode allows and touches nothing', async () => {
    vi.mocked(partnerTrustMode).mockReturnValue('off');
    expect(await evaluateCapability('remote_control', { partnerId: 'p1' })).toEqual({ allow: true });
    expect(audit).not.toHaveBeenCalled();
  });
});

describe('command allowlist', () => {
  const apiCommandTypes = dispatchedCommandTypeLiterals();
  const agentDispatcher = agentDispatcherCommandTypes();
  const realCommandTypes = [...new Set([...apiCommandTypes, ...agentDispatcher.commandTypes])].sort();

  it('classifies every known command type exactly once', () => {
    expect(
      agentDispatcher.commandTypes.length,
      `expected command types parsed from Go dispatcher files: ${agentDispatcher.files.join(', ')}`,
    ).toBeGreaterThan(0);
    expect(
      agentDispatcher.unresolvedConstants,
      'every Go dispatcher Cmd constant must resolve to a string value',
    ).toEqual([]);
    const lifecycle = new Set<string>(LIFECYCLE_COMMAND_TYPES);
    const gated = new Set<string>(GATED_COMMAND_TYPES);
    expect(LIFECYCLE_COMMAND_TYPES.filter((type) => gated.has(type))).toEqual([]);
    for (const type of realCommandTypes) {
      expect(
        Number(lifecycle.has(type)) + Number(gated.has(type)),
        `expected ${type} in exactly one command classification`,
      ).toBe(1);
      expect(isLifecycleCommand(type)).toBe(lifecycle.has(type));
    }
  });

  it('keeps operator-directed commands gated and narrow lifecycle commands allowed', () => {
    for (const type of [
      'script',
      'network_ping',
      'network_tcp_check',
      'network_http_check',
      'network_dns_check',
      'pam_apply_v2',
      'apply_browser_policy',
      'dev_update',
      'snmp_poll',
      'peripheral_policy_sync',
      'peripheral_policy_sync_v2',
      'filesystem_analysis',
    ]) expect(isLifecycleCommand(type)).toBe(false);
    for (const type of [
      'self_uninstall',
      'terminal_stop',
      'wake_on_lan',
      'pam_cleanup_v2',
    ]) expect(isLifecycleCommand(type)).toBe(true);
  });

  it('an unknown command type is gated (fail closed)', () => {
    expect(isLifecycleCommand('brand_new_command')).toBe(false);
  });
});
