import type { FlowFormAction, FlowFormTarget, FlowFormTrigger, FlowFormValues } from './types';

/** Test fixtures only; not exported from the form index. */
export const SCRIPT = '33333333-3333-4333-8333-333333333333';
export const CHANNEL = '55555555-5555-4555-8555-555555555555';
export const CHANNEL_2 = '55555555-5555-4555-8555-5555555555bd';
export const GROUP = '44444444-4444-4444-8444-444444444444';

const schedule: FlowFormTrigger = { type: 'schedule', cron: '0 2 * * *', timezone: 'UTC' };
const onGroup: FlowFormTarget = { kind: 'target', target: { type: 'groups', groupIds: [GROUP] } };
const script: FlowFormAction = { type: 'run_script', scriptId: SCRIPT, whenOffline: 'queue' };
const notify: FlowFormAction = { type: 'notify', channelId: CHANNEL, title: 'Done', message: 'Cleanup finished', severity: 'info' };
const alert: FlowFormAction = { type: 'create_alert', severity: 'high', title: 'Disk low', message: 'Disk low on {{item.name}}' };

/** Every case round-trips through compile, decode and the recognizer without a values change. */
export const FORM_CASES: Array<[string, FlowFormValues]> = [
  ['scheduled script on a group', { name: 'Nightly cleanup', trigger: schedule, target: onGroup, actions: [script], onFailure: { mode: 'stop' } }],
  ['script with parameters, runAs and skip', {
    name: 'Params', description: 'Runs a script', trigger: schedule, target: onGroup,
    actions: [{ type: 'run_script', scriptId: SCRIPT, parameters: { LIMIT: 5, DRY: true, MODE: 'fast' }, runAs: 'user', whenOffline: 'skip' }],
    onFailure: { mode: 'stop' },
  }],
  ['event on the triggering device', {
    name: 'On alert', trigger: { type: 'event', event: 'alert.triggered', filter: { severity: 'critical' } },
    target: { kind: 'trigger_device' }, actions: [script], onFailure: { mode: 'stop' },
  }],
  ['event with a notify-only action list', {
    name: 'Event notice', trigger: { type: 'event', event: 'device.offline', filter: {} },
    target: { kind: 'trigger_device' }, actions: [notify], onFailure: { mode: 'stop' },
  }],
  ['schedule with a notify-only action list', {
    name: 'Weekly note', trigger: schedule, target: { kind: 'target', target: { type: 'all' } }, actions: [notify], onFailure: { mode: 'stop' },
  }],
  ['manual script then notify (counts suffix)', {
    name: 'Manual', trigger: { type: 'manual' }, target: onGroup, actions: [script, notify], onFailure: { mode: 'stop' },
  }],
  ['notify first then script', {
    name: 'Heads up', trigger: schedule, target: onGroup, actions: [notify, script], onFailure: { mode: 'stop' },
  }],
  ['script then script under continue', {
    name: 'Two scripts', trigger: schedule, target: onGroup, actions: [script, script], onFailure: { mode: 'continue' },
  }],
  ['script then alert under continue', {
    name: 'Alert after', trigger: schedule, target: onGroup, actions: [script, alert], onFailure: { mode: 'continue' },
  }],
  ['alert first then script', {
    name: 'Alert first', trigger: schedule, target: onGroup, actions: [alert, script], onFailure: { mode: 'stop' },
  }],
  ['alert then notify then alert (shared targets step)', {
    name: 'Alerts', trigger: schedule, target: onGroup, actions: [alert, notify, alert], onFailure: { mode: 'stop' },
  }],
  ['onFailure notify with two channels over two scripts', {
    name: 'Failure notices', trigger: schedule, target: onGroup, actions: [script, script, notify],
    onFailure: { mode: 'notify', channelIds: [CHANNEL, CHANNEL_2], notice: 'perDevice' },
  }],
  ['onFailure summary with two channels over two scripts', {
    name: 'Failure summary', trigger: schedule, target: onGroup, actions: [script, script, notify],
    onFailure: { mode: 'notify', channelIds: [CHANNEL, CHANNEL_2], notice: 'summary' },
  }],
  ['filter target', {
    name: 'Filter', trigger: schedule,
    target: { kind: 'target', target: { type: 'filter', filter: { operator: 'AND', conditions: [{ field: 'osType', operator: 'equals', value: 'windows' }] } } },
    actions: [script], onFailure: { mode: 'stop' },
  }],
  ['webhook with a resolver (partner-wide)', {
    name: 'Hook', trigger: { type: 'webhook', auth: 'hmac', orgResolver: { path: 'body.customer.id', system: 'psa' } },
    target: onGroup, actions: [script], onFailure: { mode: 'stop' },
  }],
  ['webhook with token auth', {
    name: 'Hook token', trigger: { type: 'webhook', auth: 'token' }, target: { kind: 'target', target: { type: 'all' } },
    actions: [notify], onFailure: { mode: 'stop' },
  }],
];
