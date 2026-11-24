import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Flows completion W01a Task A1 — characterization of the converter's output,
 * captured on code that predates the shared-emitter move. A3 must reproduce
 * every entry byte for byte. A golden diff is a defect in the refactor, never
 * a reason to regenerate (`UPDATE_GOLDEN=1` writes only MISSING entries).
 */
import { convertAutomation } from './convertAutomation';
import { CHANNEL, CHANNEL_PD, PARTNER, SCRIPT, SCRIPT_ELEVATED, ctx, row } from './__fixtures__/automations';

const GOLDEN_PATH = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'convertAutomation.golden.json');

const script = { type: 'run_script', scriptId: SCRIPT, whenOffline: 'queue' };
const notify = { type: 'send_notification', notificationChannelId: CHANNEL };
const alert = { type: 'create_alert', alertSeverity: 'high', alertMessage: 'Disk low on {{device}}' };

interface GoldenCase { label: string; r: ReturnType<typeof row>; context?: Parameters<typeof ctx>[0] }

const CASES: GoldenCase[] = [
  // The eight cases of convertAutomation.validates.test.ts.
  { label: 'schedule + script on a group', r: row() },
  { label: 'event + script on the triggering device', r: row({ trigger: { type: 'event', eventType: 'alert.triggered', filter: { severity: 'critical' } } }), context: { currentTargets: null } },
  { label: 'script then notice under stop', r: row({ actions: [script, notify], onFailure: 'stop', conditions: [] }) },
  { label: 'script, script under continue', r: row({ actions: [script, script], onFailure: 'continue' }) },
  { label: 'notify onFailure with two channels', r: row({ actions: [script, alert], onFailure: 'notify', notificationTargets: { channelIds: [CHANNEL, CHANNEL_PD] } }) },
  { label: 'notice first, legacy conditions', r: row({ actions: [notify, script], conditions: [{ type: 'tag', value: 'prod' }, { type: 'os', operator: 'is_not', value: 'macos' }] }) },
  { label: 'webhook + alert', r: row({ trigger: { type: 'webhook', secret: 's' }, actions: [alert] }) },
  { label: 'manual + generated command', r: row({ trigger: { type: 'manual' }, actions: [{ type: 'execute_command', command: 'Get-Date', shell: 'powershell' }, notify] }) },
  // Additions the plan names.
  { label: 'onFailure notify with one channel and a script', r: row({ actions: [script], onFailure: 'notify', notificationTargets: { channelIds: [CHANNEL] } }) },
  { label: 'alert first (a targets step)', r: row({ actions: [alert, script], onFailure: 'stop' }) },
  { label: 'alert after a script under continue (an a<i>_devices step)', r: row({ actions: [script, alert], onFailure: 'continue' }) },
  { label: 'partner-wide schedule on a filter target', r: row({ orgId: null, partnerId: PARTNER, conditions: { type: 'filter', filter: { operator: 'and', conditions: [{ field: 'osType', operator: 'equals', value: 'windows' }] } } }), context: { owner: { orgId: null, partnerId: PARTNER } as never, partnerOrgs: { live: 3, total: 3 } } },
  { label: 'event-bound with an alert only', r: row({ trigger: { type: 'event', eventType: 'alert.triggered', filter: {} }, actions: [alert] }), context: { currentTargets: null } },
  // Extra coverage of branches the emitters sit in.
  { label: 'script with parameters, runAs and whenOffline skip', r: row({ actions: [{ type: 'run_script', scriptId: SCRIPT, parameters: { a: '1' }, runAs: 'user', whenOffline: 'skip' }] }) },
  { label: 'elevated script is not pre-approvable', r: row({ actions: [{ type: 'run_script', scriptId: SCRIPT_ELEVATED }] }) },
  { label: 'notice after script under notify with two channels', r: row({ actions: [script, notify], onFailure: 'notify', notificationTargets: { channelIds: [CHANNEL, CHANNEL_PD] } }) },
  { label: 'alert with an unsupported placeholder', r: row({ actions: [{ type: 'create_alert', alertTitle: 'x {{foo}}' }] }) },
  // Added after review: the active set stays on the script step across a<i>_devices steps.
  { label: 'script, alert, notice under stop (two devices steps on one script)', r: row({ actions: [script, alert, notify], onFailure: 'stop' }) },
  { label: 'script, alert, script (a later script chains on the first)', r: row({ actions: [script, alert, script], onFailure: 'continue' }) },
  // Two device steps sharing one targets step.
  { label: 'alert then notice share one targets step', r: row({ actions: [alert, notify], onFailure: 'stop' }) },
  { label: 'notice then alert share one targets step', r: row({ actions: [notify, alert], onFailure: 'stop' }) },
  // A targets step created lazily, after a skipped first action.
  { label: 'skipped restart_service then alert (lazy targets step)', r: row({ actions: [{ type: 'execute_command', kind: 'restart_service' }, alert], onFailure: 'stop' }) },
  // Failure blocks.
  { label: 'two scripts under notify with two channels', r: row({ actions: [script, script], onFailure: 'notify', notificationTargets: { channelIds: [CHANNEL, CHANNEL_PD] } }) },
  { label: 'command under notify failure block', r: row({ actions: [{ type: 'execute_command', command: 'Get-Date', shell: 'powershell' }], onFailure: 'notify', notificationTargets: { channelIds: [CHANNEL] } }) },
  { label: 'long name truncated into the failure notice', r: row({ name: 'N'.repeat(130), actions: [script], onFailure: 'notify', notificationTargets: { channelIds: [CHANNEL] } }) },
  // Alert defaults.
  { label: 'alert with default severity, title and message', r: row({ actions: [{ type: 'create_alert' }] }) },
];

const stored: Record<string, string> = existsSync(GOLDEN_PATH) ? JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) : {};

describe('converter output golden', () => {
  for (const { label, r, context } of CASES) {
    it(`converter output is unchanged — ${label}`, () => {
      const out = convertAutomation(r, ctx({ currentTargets: { count: 5, osTypes: new Set(['windows']) }, ...context }));
      const { fidelity, findings, document, documentDigest, preApprovalCandidates, generatedScripts } = out;
      const actual = JSON.stringify({ fidelity, findings, document, documentDigest, preApprovalCandidates, generatedScripts });
      if (stored[label] === undefined) {
        if (process.env.UPDATE_GOLDEN !== '1') throw new Error(`no golden entry for "${label}"; run once with UPDATE_GOLDEN=1 on unmodified code`);
        stored[label] = actual;
        writeFileSync(GOLDEN_PATH, `${JSON.stringify(Object.fromEntries(Object.entries(stored).sort(([a], [b]) => a.localeCompare(b))), null, 1)}\n`);
      }
      expect(actual).toBe(stored[label]);
    });
  }
  it('golden file has no stale entries', () => {
    expect(Object.keys(stored).sort()).toEqual(CASES.map((c) => c.label).sort());
  });
});
