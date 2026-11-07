/**
 * CONTRACT TEST: the vendor update command `oem_update_run` (#11065) reaches a
 * device through one seam only.
 *
 * It can flash a BIOS and reboot a machine. services/oemUpdates/dispatch.ts is
 * the only caller of the queue for this type, and it is what checks the env
 * flag, the manifest gates, the kill switches and the agent version. A second
 * caller would skip all four.
 *
 * Every other way a command type reaches a device is an allowlist today: the
 * generic single and bulk command routes, the AI `execute_command` tool,
 * automations, fleet-finding remediation, fix-memory actions and the mobile
 * device actions. This test fails if `oem_update_run` appears anywhere in the
 * API outside the files below, as the literal or as the
 * `CommandTypes.OEM_UPDATE_RUN` constant.
 *
 * Plain unit test: reads the source tree and parses the route schemas.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, resolve } from 'path';
import { bulkCommandSchema, createCommandSchema } from '../routes/devices/schemas';
import { REMEDIATION_COMMAND_TYPE_ALLOWLIST } from '../services/fleetFindings/dispatch';
import { TEARDOWN_CLAIM_EXEMPT_TYPES, REVALIDATION_REQUIRED_TYPES } from '../services/commandClaimEligibility';
import { COMMAND_MIN_AGENT_VERSION } from '../services/commandMinVersion';
import { defaultOfflinePolicy } from '../services/commandOfflinePolicy';
import { getCommandTimeoutMs } from '../services/commandTimeouts';
import { DRAIN_CLAIM_TYPE_ALLOWLIST } from '../services/drainClaimAllowlist';
import { isLifecycleCommand } from '../services/partnerTrust';
import { isParkedDeliverableCommandType } from '../services/unassignedPool/deliveryEligibility';
import { OEM_UPDATE_MIN_AGENT_VERSION, OEM_UPDATE_RELEASE_MIN_AGENT_VERSION } from '@breeze/shared';

const SRC = resolve(import.meta.dirname, '..');

const ALLOWED: Record<string, string> = {
  'services/commandTypes.ts': 'the type constant',
  'services/commandTimeouts.ts': 'execution budget',
  'services/commandOfflinePolicy.ts': 'live, so an offline device is refused',
  'services/partnerTrust.ts': 'gated (operator-directed) classification',
  'services/commandQueue.ts': 'always audited',
  'services/commandMinVersion.ts': 'minimum agent version',
  'services/commandClaimEligibility.ts': 'delivery revalidation required',
  'services/commandResultHandlers.ts': 'result handler registration',
  'routes/agents/commands.ts': 'HTTP result transport reaches the same handler',
  'services/oemUpdates/dispatch.ts': 'the one seam that queues it',
  'services/oemUpdates/revalidation.ts': 'claim-time recheck of the gates',
  'services/oemUpdates/results.ts': 'refuses a result for any other command type',
};

// The literal, or the constant, as whole words.
const WORD = /(?<![A-Za-z0-9_])(?:oem_update_run|OEM_UPDATE_RUN)(?![A-Za-z0-9_])/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '__tests__' || name === '__snapshots__') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.ts') && !full.endsWith('.test.ts') && !full.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

describe('contract: oem_update_run is only queued through its gated seam (#11065)', () => {
  it('appears only in the allowlisted API files', () => {
    const offenders = walk(SRC)
      .filter((file) => WORD.test(readFileSync(file, 'utf8')))
      .map((file) => relative(SRC, file).replaceAll('\\', '/'))
      .filter((file) => !(file in ALLOWED));
    expect(
      offenders,
      'oem_update_run must go through services/oemUpdates/dispatch.ts: do not add it to generic, bulk, AI, MCP, automation, mobile, fix-memory or fleet-finding paths',
    ).toEqual([]);
  });

  it('has no stale allowlist entries', () => {
    const stale = Object.keys(ALLOWED).filter((file) => !WORD.test(readFileSync(join(SRC, file), 'utf8')));
    expect(stale).toEqual([]);
  });

  it('only the seam calls the enqueue functions with it', () => {
    const queueCall = /(?:dispatchDeviceCommand\w*|queueCommand\w*|executeCommand|insertQueuedCommandInTransaction)\b/;
    const seamOnly = Object.keys(ALLOWED).filter((file) => file !== 'services/oemUpdates/dispatch.ts');
    const offenders = seamOnly.filter((file) => {
      const lines = readFileSync(join(SRC, file), 'utf8').split('\n');
      return lines.some((line, i) =>
        WORD.test(line) && queueCall.test(lines.slice(Math.max(0, i - 3), i + 1).join('\n')));
    });
    expect(offenders).toEqual([]);
  });

  it('is rejected by the generic single and bulk command schemas', () => {
    expect(createCommandSchema.safeParse({ type: 'oem_update_run' }).success).toBe(false);
    expect(
      bulkCommandSchema.safeParse({ deviceIds: ['11111111-1111-4111-8111-111111111111'], type: 'oem_update_run' }).success,
    ).toBe(false);
  });

  it('is not a fleet-finding remediation', () => {
    expect((REMEDIATION_COMMAND_TYPE_ALLOWLIST as readonly string[]).includes('oem_update_run')).toBe(false);
  });

  it('is refused for a parked device and earns no claim exemption', () => {
    expect(isParkedDeliverableCommandType('oem_update_run')).toBe(false);
    expect((DRAIN_CLAIM_TYPE_ALLOWLIST as readonly string[]).includes('oem_update_run')).toBe(false);
    expect(TEARDOWN_CLAIM_EXEMPT_TYPES.has('oem_update_run')).toBe(false);
  });

  it('is gated, never a trust-exempt lifecycle command', () => {
    expect(isLifecycleCommand('oem_update_run')).toBe(false);
  });

  it('must pass a delivery revalidation', () => {
    expect(REVALIDATION_REQUIRED_TYPES.has('oem_update_run')).toBe(true);
  });

  it('rejects an offline device, runs on the two hour budget and carries the fail-closed version', () => {
    expect(defaultOfflinePolicy('oem_update_run')).toEqual({ kind: 'reject' });
    expect(getCommandTimeoutMs('oem_update_run')).toBe(2 * 60 * 60 * 1000);
    expect(COMMAND_MIN_AGENT_VERSION.oem_update_run).toBe(OEM_UPDATE_MIN_AGENT_VERSION);
  });
});

// `oem_update_release` hands a vendor tool's own update schedule back. It runs a
// vendor binary as SYSTEM, so it has the same single-seam rule as the run, but it
// must still reach a device after the feature is switched off, so it queues offline.
const ALLOWED_RELEASE: Record<string, string> = {
  'services/commandTypes.ts': 'the type constant',
  'services/commandTimeouts.ts': 'execution budget',
  'services/commandOfflinePolicy.ts': 'standard class: queues while the device is offline',
  'services/partnerTrust.ts': 'gated (operator-directed) classification',
  'services/commandQueue.ts': 'always audited',
  'services/commandMinVersion.ts': 'minimum agent version',
  'services/commandResultHandlers.ts': 'result handler registration: the ack that ends a takeover',
  'routes/agents/commands.ts': 'HTTP result transport reaches the same handler',
  'services/oemUpdates/dispatch.ts': 'the one seam that queues it',
};

const RELEASE_WORD = /(?<![A-Za-z0-9_])(?:oem_update_release|OEM_UPDATE_RELEASE)(?![A-Za-z0-9_])/;

describe('contract: oem_update_release is only queued through its seam (#11065)', () => {
  it('appears only in the allowlisted API files', () => {
    const offenders = walk(SRC)
      .filter((file) => RELEASE_WORD.test(readFileSync(file, 'utf8')))
      .map((file) => relative(SRC, file).replaceAll('\\', '/'))
      .filter((file) => !(file in ALLOWED_RELEASE));
    expect(
      offenders,
      'oem_update_release must go through services/oemUpdates/dispatch.ts: do not add it to generic, bulk, AI, MCP, automation, mobile, fix-memory or fleet-finding paths',
    ).toEqual([]);
  });

  it('has no stale allowlist entries', () => {
    const stale = Object.keys(ALLOWED_RELEASE).filter((file) => !RELEASE_WORD.test(readFileSync(join(SRC, file), 'utf8')));
    expect(stale).toEqual([]);
  });

  it('only the seam calls the enqueue functions with it', () => {
    const queueCall = /(?:dispatchDeviceCommand\w*|queueCommand\w*|executeCommand|insertQueuedCommandInTransaction)\b/;
    const seamOnly = Object.keys(ALLOWED_RELEASE).filter((file) => file !== 'services/oemUpdates/dispatch.ts');
    const offenders = seamOnly.filter((file) => {
      const lines = readFileSync(join(SRC, file), 'utf8').split('\n');
      return lines.some((line, i) =>
        RELEASE_WORD.test(line) && queueCall.test(lines.slice(Math.max(0, i - 3), i + 1).join('\n')));
    });
    expect(offenders).toEqual([]);
  });

  it('is rejected by the generic single and bulk command schemas', () => {
    expect(createCommandSchema.safeParse({ type: 'oem_update_release' }).success).toBe(false);
    expect(
      bulkCommandSchema.safeParse({ deviceIds: ['11111111-1111-4111-8111-111111111111'], type: 'oem_update_release' }).success,
    ).toBe(false);
  });

  it('is not a fleet-finding remediation', () => {
    expect((REMEDIATION_COMMAND_TYPE_ALLOWLIST as readonly string[]).includes('oem_update_release')).toBe(false);
  });

  it('is refused for a parked device and earns no claim exemption', () => {
    expect(isParkedDeliverableCommandType('oem_update_release')).toBe(false);
    expect((DRAIN_CLAIM_TYPE_ALLOWLIST as readonly string[]).includes('oem_update_release')).toBe(false);
    expect(TEARDOWN_CLAIM_EXEMPT_TYPES.has('oem_update_release')).toBe(false);
  });

  it('is gated, never a trust-exempt lifecycle command', () => {
    expect(isLifecycleCommand('oem_update_release')).toBe(false);
  });

  it('queues for an offline device, runs on the default 30 minute budget and carries the fail-closed version', () => {
    const policy = defaultOfflinePolicy('oem_update_release');
    expect(policy.kind).toBe('queue');
    expect(policy).not.toEqual({ kind: 'reject' });
    expect(getCommandTimeoutMs('oem_update_release')).toBe(30 * 60 * 1000);
    expect(COMMAND_MIN_AGENT_VERSION.oem_update_release).toBe(OEM_UPDATE_RELEASE_MIN_AGENT_VERSION);
  });
});
