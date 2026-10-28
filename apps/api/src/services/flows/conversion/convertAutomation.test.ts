import { describe, expect, it } from 'vitest';
import { flowDocumentV1Schema, isStructurallyValidCron, type FlowConversionFindingCode, type FlowDocumentV1 } from '@breeze/shared';
import { isCronDue } from '../../cronDue';
import { latestCronOccurrence } from '../../aiAgents/sweepOccurrence';
import { automationSourceDigest, convertAutomation } from './convertAutomation';
import { AUTOMATION, CHANNEL, CHANNEL_PD, GROUP, ORG, PARTNER, SCRIPT, SCRIPT_ELEVATED, ctx, row } from './__fixtures__/automations';

/**
 * Tool Catalog W06 (#5221) Task A7 — the pure converter: one fixture per
 * conversion-map row of the plan. Legacy executes action-major with a
 * per-device stop; the converted document chains each fleet step on the
 * previous one's device sets.
 */

const codes = (r: ReturnType<typeof convertAutomation>) => r.findings.map((f) => f.code);
const has = (r: ReturnType<typeof convertAutomation>, c: FlowConversionFindingCode) => codes(r).includes(c);
const stepsOf = (r: ReturnType<typeof convertAutomation>) => (r.document as FlowDocumentV1).steps;

describe('convertAutomation — triggers and targets', () => {
  it('scheduled run_script on a groups target is exact with one fleet candidate', () => {
    const r = convertAutomation(row(), ctx());
    expect(r.fidelity).toBe('exact');
    expect(flowDocumentV1Schema.parse(r.document)).toBeTruthy();
    expect(r.document!.trigger).toEqual({ type: 'schedule', cron: '0 2 * * *', timezone: 'UTC' });
    expect(stepsOf(r)).toEqual([{
      id: 'a0_run_script', tool: 'run_script_on_targets', approval: 'default', onFailure: 'continue', timeoutSec: 3600,
      input: { scriptId: SCRIPT, whenOffline: 'queue', target: { type: 'groups', groupIds: [GROUP] } },
    }]);
    expect(r.preApprovalCandidates).toEqual([{ stepId: 'a0_run_script', currentTargetCount: 30 }]);
    expect(has(r, 'queued_is_success')).toBe(true);
    expect(has(r, 'schedule_outage_catch_up')).toBe(true);
  });

  it('event automation binds trigger.device.id', () => {
    const r = convertAutomation(row({ trigger: { type: 'event', eventType: 'alert.triggered', filter: { severity: 'critical' } } }), ctx({ currentTargets: null }));
    expect(r.document!.trigger).toEqual({ type: 'event', event: 'alert.triggered', filter: { severity: 'critical' } });
    expect(stepsOf(r)[0]!.input).toMatchObject({ deviceIds: ['{{trigger.device.id}}'] });
    expect(r.preApprovalCandidates).toEqual([{ stepId: 'a0_run_script', currentTargetCount: null }]);
  });

  it('string filter is review', () => {
    const r = convertAutomation(row({ trigger: { type: 'event', eventType: 'alert.triggered', filter: { severity: 'critical' } } }), ctx({ currentTargets: null }));
    expect(has(r, 'event_filter_string_coercion')).toBe(true);
    expect(r.fidelity).toBe('needs_review');
  });

  it('number and boolean filters are exact', () => {
    const r = convertAutomation(row({ trigger: { type: 'event', eventType: 'device.updated', filter: { count: 5, online: true } } }), ctx({ currentTargets: null }));
    expect(r.fidelity).toBe('exact');
  });

  it('null filter is a blocker', () => {
    const r = convertAutomation(row({ trigger: { type: 'event', eventType: 'x.y', filter: { a: null } } }), ctx({ currentTargets: null }));
    expect(has(r, 'event_filter_null')).toBe(true);
    expect(r.fidelity).toBe('unconvertible');
    expect(r.document).toBeNull();
  });

  it('array filter is a blocker', () => {
    const r = convertAutomation(row({ trigger: { type: 'event', eventType: 'x.y', filter: { a: ['b'] } } }), ctx({ currentTargets: null }));
    expect(has(r, 'event_filter_not_strict')).toBe(true);
  });

  it('an event Job needs durable dispatch; durationMinutes is dropped with info', () => {
    const r = convertAutomation(row({ trigger: { type: 'event', eventType: 'x.y', durationMinutes: 5 } }), ctx({ currentTargets: null, eventDispatchDurable: false }));
    expect(has(r, 'event_dispatch_not_durable')).toBe(true);
    expect(has(r, 'duration_minutes_ignored')).toBe(true);
  });

  it('cron differing across DST is a blocker; the shared evaluator agrees over 400 occurrences across both transitions', () => {
    expect(has(convertAutomation(row({ trigger: { type: 'schedule', cronExpression: '0 2 * *', timezone: 'UTC' } }), ctx()), 'cron_semantics_differ')).toBe(true);
    expect(has(convertAutomation(row({ trigger: { type: 'schedule', cronExpression: '0 2 * * *', timezone: 'Mars/Olympus' } }), ctx()), 'cron_semantics_differ')).toBe(true);
    // The two engines evaluate a minute with the SAME function (flow ticks use
    // latestCronOccurrence over isCronDue), so the occurrences agree.
    const cron = '30 1,2 * * *';
    const tz = 'Europe/Berlin';
    expect(isStructurallyValidCron(cron)).toBe(true);
    let t = new Date('2027-03-20T00:00:00Z').getTime();
    let found = 0;
    while (found < 400) {
      const at = new Date(t);
      const legacy = isCronDue(cron, tz, at);
      const flow = latestCronOccurrence(cron, tz, at, 0)?.at.getTime() === t;
      expect(flow).toBe(legacy);
      if (legacy) found++;
      t += 60_000 * 15;
    }
  });

  it('webhook adds body-shape and url findings', () => {
    const r = convertAutomation(row({ trigger: { type: 'webhook', secret: 'sekrit' } }), ctx({ currentTargets: { count: 3, osTypes: new Set(['linux']) } }));
    expect(r.document!.trigger).toEqual({ type: 'webhook', auth: 'hmac' });
    expect(has(r, 'webhook_body_shape')).toBe(true);
    expect(has(r, 'webhook_url_changes')).toBe(true);
    expect(has(r, 'approval_each_run')).toBe(true);
    expect(r.preApprovalCandidates).toEqual([]);
    expect(has(convertAutomation(row({ trigger: { type: 'webhook', secret: 's' } }), ctx({ legacySecretHeaderAllowed: true })), 'legacy_secret_header_possible')).toBe(true);
  });

  it('source digest ignores the secret', () => {
    const a = automationSourceDigest(row({ trigger: { type: 'webhook', secret: 'one' } }));
    const b = automationSourceDigest(row({ trigger: { type: 'webhook', secret: 'two' } }));
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(convertAutomation(row({ trigger: { type: 'webhook', secret: 'one' } }), ctx()).sourceSnapshot)).not.toContain('one');
    expect(automationSourceDigest(row({ name: 'other' }))).toBe(automationSourceDigest(row()));
    expect(automationSourceDigest(row({ actions: [] }))).not.toBe(automationSourceDigest(row()));
  });

  it('unknown legacy condition type is a blocker; an empty-value condition is dropped like legacy', () => {
    expect(has(convertAutomation(row({ conditions: [{ type: 'hostname', value: 'x' }] }), ctx()), 'condition_unknown_type')).toBe(true);
    const r = convertAutomation(row({ conditions: [{ type: 'os', operator: 'is', value: '' }, { type: 'tag', value: 'prod' }] }), ctx());
    expect(stepsOf(r)[0]!.input.conditions).toEqual([{ type: 'tag', operator: 'is', value: 'prod' }]);
  });

  it('more than 400 current targets is targets_over_cap', () => {
    expect(has(convertAutomation(row(), ctx({ currentTargets: { count: 401, osTypes: new Set(['windows']) } })), 'targets_over_cap')).toBe(true);
  });

  it('partner with 600 orgs is a blocker; with 20 it is review', () => {
    const pw = row({ orgId: null, partnerId: PARTNER, conditions: [] });
    const big = convertAutomation(pw, ctx({ owner: { orgId: null, partnerId: PARTNER }, partnerOrgs: { live: 600, total: 600 } }));
    expect(big.findings.find((f) => f.code === 'partner_wide_org_set_differs')?.severity).toBe('blocker');
    const small = convertAutomation(pw, ctx({ owner: { orgId: null, partnerId: PARTNER }, partnerOrgs: { live: 20, total: 21 } }));
    expect(small.findings.find((f) => f.code === 'partner_wide_org_set_differs')?.severity).toBe('review');
    expect(has(convertAutomation({ ...pw, conditions: { type: 'groups', groupIds: [GROUP] } }, ctx({ owner: { orgId: null, partnerId: PARTNER }, partnerOrgs: { live: 2, total: 2 } })), 'partner_wide_group_target')).toBe(true);
    expect(has(convertAutomation({ ...pw, trigger: { type: 'webhook', secret: 's' } }, ctx({ owner: { orgId: null, partnerId: PARTNER }, partnerOrgs: { live: 2, total: 2 } })), 'partner_wide_webhook')).toBe(true);
  });

  it('creator site ceiling adds site_ceiling_removed', () => {
    expect(has(convertAutomation(row(), ctx({ creatorHasSiteCeiling: true })), 'site_ceiling_removed')).toBe(true);
  });

  it('estimated runs above the flow cap is a blocker; above 80% of the owner cap is review', () => {
    const everyMinute = row({ trigger: { type: 'schedule', cronExpression: '* * * * *', timezone: 'UTC' } });
    expect(has(convertAutomation(everyMinute, ctx()), 'monthly_cap_exceeded')).toBe(true);
    const r = convertAutomation(row(), ctx({ limits: { monthlyRunsPerFlow: 10_000, monthlyRunsPerOwner: 100, ownerRunsThisMonth: 90 } }));
    expect(has(r, 'owner_cap_pressure')).toBe(true);
    expect(r.estimatedMonthlyRuns).toBe(30);
    expect(convertAutomation(row({ trigger: { type: 'manual' } }), ctx({ observedMonthlyRuns: 12 })).estimatedMonthlyRuns).toBe(12);
  });
});

describe('convertAutomation — actions', () => {
  const notify = { type: 'send_notification', notificationChannelId: CHANNEL };
  const script = { type: 'run_script', scriptId: SCRIPT, whenOffline: 'queue' };

  it('stop narrows later actions to succeeded devices', () => {
    const r = convertAutomation(row({ actions: [script, notify], onFailure: 'stop', conditions: [] }), ctx({ currentTargets: { count: 10, osTypes: new Set(['windows']) } }));
    const s = stepsOf(r);
    expect(s.map((x) => x.id)).toEqual(['a0_run_script', 'a1_devices', 'a1_notify']);
    expect(s[1]).toMatchObject({ tool: 'resolve_targets', input: { fromStep: { stepId: 'a0_run_script', set: 'succeeded' } } });
    expect(s[2]).toMatchObject({
      tool: 'notify', forEach: { items: 'steps.a1_devices.output.devices', maxItems: 500 },
      input: { channelId: CHANNEL, title: 'Nightly cleanup notification', message: 'Automation Nightly cleanup executed on {{item.hostname}}', severity: 'info' },
    });
  });

  it('continue chains dispatched devices', () => {
    const r = convertAutomation(row({ actions: [script, script], onFailure: 'continue' }), ctx());
    expect(stepsOf(r)[1]).toMatchObject({ id: 'a1_run_script', input: { fromStep: { stepId: 'a0_run_script', set: 'dispatched' } } });
  });

  it('onFailure notify adds per-channel failure notices over failed devices', () => {
    const r = convertAutomation(row({ actions: [script], onFailure: 'notify', notificationTargets: { channelIds: [CHANNEL, CHANNEL_PD], emails: ['x@example.com'] } }), ctx());
    const s = stepsOf(r);
    expect(s.map((x) => x.id)).toEqual(['a0_run_script', 'a0_failed', 'a0_failnotice_0', 'a0_failnotice_1']);
    expect(s[1]).toMatchObject({ tool: 'resolve_targets', input: { fromStep: { stepId: 'a0_run_script', set: 'failed' } }, when: 'length(steps.a0_run_script.output.failedDeviceIds) > 0' });
    expect(s[2]).toMatchObject({
      tool: 'notify', when: 'length(steps.a0_run_script.output.failedDeviceIds) > 0', forEach: { items: 'steps.a0_failed.output.devices' },
      input: { channelId: CHANNEL, title: 'Nightly cleanup action failed', severity: 'warning' },
    });
    expect(has(r, 'notification_emails_unused')).toBe(true);
    // notify narrows like stop
    const two = convertAutomation(row({ actions: [script, script], onFailure: 'notify', notificationTargets: { channelIds: [CHANNEL] } }), ctx());
    expect(stepsOf(two).find((x) => x.id === 'a1_run_script')).toMatchObject({ input: { fromStep: { stepId: 'a0_run_script', set: 'succeeded' } } });
  });

  it('a notification before any script resolves the targets once', () => {
    const r = convertAutomation(row({ actions: [notify] }), ctx({ currentTargets: { count: 5, osTypes: new Set(['windows']) } }));
    expect(stepsOf(r).map((x) => x.id)).toEqual(['targets', 'a0_notify']);
    expect(stepsOf(r)[0]).toMatchObject({ tool: 'resolve_targets', input: { target: { type: 'groups', groupIds: [GROUP] } } });
    expect(stepsOf(r)[1]).toMatchObject({ forEach: { items: 'steps.targets.output.devices' } });
  });

  it('notice severity maps with info; text with a foreign {{ is a blocker', () => {
    const r = convertAutomation(row({ actions: [{ ...notify, severity: 'high', title: 'T', message: 'M' }] }), ctx({ currentTargets: { count: 2, osTypes: new Set(['windows']) } }));
    expect(stepsOf(r)[1]!.input).toMatchObject({ severity: 'warning', title: 'T', message: 'M' });
    expect(has(r, 'severity_mapped')).toBe(true);
    expect(has(convertAutomation(row({ actions: [{ ...notify, message: 'Disk {{pct}}' }] }), ctx()), 'text_template_unsupported')).toBe(true);
  });

  it('notices above the per-run cap are a blocker', () => {
    expect(has(convertAutomation(row({ actions: [notify] }), ctx({ currentTargets: { count: 21, osTypes: new Set(['windows']) } })), 'notify_per_run_cap')).toBe(true);
    expect(has(convertAutomation(row({ actions: [notify] }), ctx({ currentTargets: { count: 20, osTypes: new Set(['windows']) } })), 'notify_per_run_cap')).toBe(false);
  });

  it('create_alert maps device placeholders onto the item', () => {
    const r = convertAutomation(row({ actions: [{ type: 'create_alert', alertSeverity: 'high', alertMessage: 'Disk low on {{device}} ({{hostname}})' }] }), ctx({ currentTargets: { count: 2, osTypes: new Set(['windows']) } }));
    expect(stepsOf(r)[1]).toMatchObject({
      tool: 'create_alert', forEach: { items: 'steps.targets.output.devices' },
      input: { deviceId: '{{item.id}}', severity: 'high', title: 'Nightly cleanup automation alert', message: 'Disk low on {{item.name}} ({{item.hostname}})' },
    });
    expect(r.fidelity).toBe('exact');
  });

  it('deploy_software is a blocker', () => {
    expect(has(convertAutomation(row({ actions: [{ type: 'deploy_software', catalogItemId: 'x' }] }), ctx()), 'deploy_software_unmapped')).toBe(true);
  });

  it('a command becomes a generated script; mixed-OS shell-less command is a blocker; restart_service is a blocker', () => {
    const r = convertAutomation(row({ actions: [{ type: 'execute_command', command: 'Get-Service' }] }), ctx());
    expect(has(r, 'command_becomes_script')).toBe(true);
    expect(r.generatedScripts).toEqual([{ stepId: 'a0_command', name: 'Moved from Job "Nightly cleanup" — command 1', language: 'powershell', body: 'Get-Service' }]);
    expect(stepsOf(r)[0]).toMatchObject({ id: 'a0_command', tool: 'run_script_on_targets', input: { scriptId: expect.stringMatching(/^[0-9a-f-]{36}$/) } });
    const mixed = convertAutomation(row({ actions: [{ type: 'execute_command', command: 'uptime' }] }), ctx({ currentTargets: { count: 3, osTypes: new Set(['windows', 'linux']) } }));
    expect(has(mixed, 'command_mixed_os')).toBe(true);
    const shelled = convertAutomation(row({ actions: [{ type: 'execute_command', command: 'uptime', shell: 'bash' }] }), ctx({ currentTargets: { count: 3, osTypes: new Set(['windows', 'linux']) } }));
    expect(has(shelled, 'command_mixed_os')).toBe(false);
    expect(has(convertAutomation(row({ actions: [{ type: 'execute_command', kind: 'restart_service', command: '' }] }), ctx()), 'restart_service_monitor_only')).toBe(true);
  });

  it('inherited elevated is a blocker; explicit elevated too', () => {
    expect(has(convertAutomation(row({ actions: [{ type: 'run_script', scriptId: SCRIPT_ELEVATED }] }), ctx()), 'run_as_elevated')).toBe(true);
    expect(has(convertAutomation(row({ actions: [{ type: 'run_script', scriptId: SCRIPT, runAs: 'elevated' }] }), ctx()), 'run_as_elevated')).toBe(true);
    const userOverride = convertAutomation(row({ actions: [{ type: 'run_script', scriptId: SCRIPT_ELEVATED, runAs: 'user' }] }), ctx());
    expect(has(userOverride, 'run_as_elevated')).toBe(false);
  });

  it('a script or channel the owner does not own is reference_not_owned', () => {
    expect(has(convertAutomation(row({ actions: [{ type: 'run_script', scriptId: '99999999-9999-4999-8999-999999999999' }] }), ctx()), 'reference_not_owned')).toBe(true);
    expect(has(convertAutomation(row({ actions: [{ type: 'send_notification', notificationChannelId: '99999999-9999-4999-8999-999999999999' }] }), ctx()), 'reference_not_owned')).toBe(true);
  });
});

describe('convertAutomation — rows it never converts', () => {
  it('S+R row is a blocker for both consumers', () => {
    const r = convertAutomation(row(), ctx({ isRemediationTarget: true }));
    expect(codes(r)).toEqual(['compliance_remediation_target']);
    expect(r.document).toBeNull();
  });

  it('managed, policy-workflow and retired rows are blockers; flows off is a blocker', () => {
    expect(codes(convertAutomation(row({ managedByMonitorId: AUTOMATION }), ctx()))).toEqual(['managed_row']);
    expect(codes(convertAutomation(row({ managedByAgentId: AUTOMATION }), ctx()))).toEqual(['managed_row']);
    expect(codes(convertAutomation(row({ trigger: { type: 'event', eventType: 'x', filter: { _policyWorkflow: { id: 'p' } } } }), ctx()))).toEqual(['policy_workflow']);
    expect(codes(convertAutomation(row({ retiredAt: new Date() }), ctx()))).toEqual(['already_retired']);
    expect(codes(convertAutomation(row(), ctx({ liveMonitorConversion: true })))).toEqual(['already_retired']);
    expect(codes(convertAutomation(row(), ctx({ flowsEnabled: false })))).toContain('flows_disabled');
  });
});

describe('convertAutomation — output contract', () => {
  const cases = [
    row(),
    row({ trigger: { type: 'event', eventType: 'alert.triggered', filter: { severity: 'critical' } } }),
    row({ trigger: { type: 'webhook', secret: 's' }, actions: [{ type: 'create_alert', alertSeverity: 'low', alertMessage: 'x' }] }),
    row({ trigger: { type: 'manual' }, actions: [{ type: 'execute_command', command: 'Get-Date', shell: 'powershell' }], onFailure: 'notify', notificationTargets: { channelIds: [CHANNEL] } }),
    row({ actions: [{ type: 'run_script', scriptId: SCRIPT }, { type: 'send_notification', notificationChannelId: CHANNEL_PD }], conditions: [{ type: 'os', value: 'windows' }] }),
  ];

  it('every exact or needs_review document is a valid flow document', () => {
    for (const r0 of cases) {
      const r = convertAutomation(r0, ctx({ currentTargets: r0.trigger && (r0.trigger as { type: string }).type === 'event' ? null : { count: 5, osTypes: new Set(['windows']) } }));
      expect(r.fidelity, JSON.stringify(r.findings)).not.toBe('unconvertible');
      const parsed = flowDocumentV1Schema.safeParse(r.document);
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
      expect(r.documentDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(r.sourceDigest).toBe(automationSourceDigest(r0));
    }
  });

  it('output is deterministic', () => {
    for (const r0 of cases) {
      expect(JSON.stringify(convertAutomation(r0, ctx()))).toBe(JSON.stringify(convertAutomation(r0, ctx())));
    }
  });

  it('a long name is truncated with review; the description says where it came from', () => {
    const r = convertAutomation(row({ name: 'x'.repeat(130), description: 'Keeps disks clean.' }), ctx());
    expect(r.document!.name).toHaveLength(120);
    expect(has(r, 'name_truncated')).toBe(true);
    expect(r.document!.description).toBe(`Keeps disks clean.\n\nMoved from Job ${'x'.repeat(130)}`);
  });

  it('finding details never carry a script body, a command or a secret', () => {
    const r = convertAutomation(row({ trigger: { type: 'webhook', secret: 'TOPSECRET' }, actions: [{ type: 'execute_command', command: 'rm -rf /SECRETCMD' }] }), ctx({ currentTargets: { count: 2, osTypes: new Set(['windows', 'linux']) } }));
    const details = JSON.stringify(r.findings);
    expect(details).not.toContain('TOPSECRET');
    expect(details).not.toContain('SECRETCMD');
    for (const f of r.findings) expect(f.detail.length).toBeLessThanOrEqual(500);
  });

  it('the source snapshot carries the owner-independent fields only', () => {
    const r = convertAutomation(row(), ctx());
    expect(Object.keys(r.sourceSnapshot).sort()).toEqual(['actions', 'conditions', 'notificationTargets', 'onFailure', 'trigger']);
    expect(AUTOMATION).toBeTruthy();
    expect(ORG).toBeTruthy();
  });
});
