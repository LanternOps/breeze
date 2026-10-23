/**
 * CONTRACT TEST — "Force reboot now" (#8729) stays a human, step-up action.
 *
 * A force reboot closes running apps and discards unsaved work. It is reachable
 * through exactly one door: POST /devices/:id/force-reboot, which requires an
 * interactive user session, devices:execute, MFA and a single-use
 * `device_force_reboot` step-up grant bound to that device.
 *
 * Every other way a command type reaches a device is an allowlist today: the
 * generic single and bulk command routes (routes/devices/schemas.ts), the AI
 * `execute_command` tool, fleet-findings remediation, fix-memory actions and
 * the mobile device actions. This test fails if `force_reboot` is added to any
 * of them, or appears anywhere in the API outside the files below (as the
 * literal or as the `CommandTypes.FORCE_REBOOT` constant).
 *
 * Plain unit test: reads the source tree and parses the route schemas.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, resolve } from 'path';
import { bulkCommandSchema, createCommandSchema } from '../routes/devices/schemas';
import { REMEDIATION_COMMAND_TYPE_ALLOWLIST } from '../services/fleetFindings/dispatch';

const SRC = resolve(import.meta.dirname, '..');

/**
 * The only API files allowed to name the `force_reboot` command type, and why.
 * `device_force_reboot` (the step-up operation) does not match: the scan is
 * for the whole word.
 */
const ALLOWED: Record<string, string> = {
  'services/commandTypes.ts': 'the type constant',
  'services/commandClaimEligibility.ts': 'power-state barrier membership',
  'services/commandOfflinePolicy.ts': 'live_only delivery window',
  'services/commandTimeouts.ts': 'execution budget',
  'services/partnerTrust.ts': 'gated (operator-directed) classification',
  'services/forceReboot.ts': 'version gate, argv, step-up digest',
  'routes/devices/forceReboot.ts': 'the one route that queues it',
  'openapi.ts': 'documents the route and the type',
};

// The literal, or the `CommandTypes.FORCE_REBOOT` constant (so wiring the
// constant into a new path is caught too). Whole words only:
// `device_force_reboot` and `MIN_AGENT_VERSION_FORCE_REBOOT` do not match.
const WORD = /(?<![A-Za-z0-9_])(?:force_reboot|FORCE_REBOOT)(?![A-Za-z0-9_])/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '__tests__' || name === '__snapshots__') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.ts') && !full.endsWith('.test.ts') && !full.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

describe('contract: force_reboot is only reachable through its step-up route (#8729)', () => {
  it('appears only in the allowlisted API files', () => {
    const offenders = walk(SRC)
      .filter((file) => WORD.test(readFileSync(file, 'utf8')))
      .map((file) => relative(SRC, file).replaceAll('\\', '/'))
      .filter((file) => !(file in ALLOWED));
    expect(
      offenders,
      'force_reboot must stay a human, step-up action: do not add it to generic, bulk, AI, MCP, mobile, fix-memory or fleet-finding paths',
    ).toEqual([]);
  });

  it('has no stale allowlist entries', () => {
    const stale = Object.keys(ALLOWED).filter((file) => !WORD.test(readFileSync(join(SRC, file), 'utf8')));
    expect(stale).toEqual([]);
  });

  it('is rejected by the generic single and bulk command schemas', () => {
    expect(createCommandSchema.safeParse({ type: 'force_reboot' }).success).toBe(false);
    expect(
      bulkCommandSchema.safeParse({ deviceIds: ['11111111-1111-4111-8111-111111111111'], type: 'force_reboot' }).success,
    ).toBe(false);
  });

  it('is not a fleet-finding remediation', () => {
    expect((REMEDIATION_COMMAND_TYPE_ALLOWLIST as readonly string[]).includes('force_reboot')).toBe(false);
  });
});
