import { describe, expect, it } from 'vitest';
import type { FlowIssue } from '@breeze/shared';

/**
 * Tool Catalog W06 (#5221) — the save-time allowance for generated-script
 * placeholders (B1 defect, lead decision option 1). A converted draft names
 * each script the switch will generate by a placeholder id; the draft save
 * accepts `reference_not_owned` ONLY for exactly those ids of the flow's own
 * shadow conversion. Enable never applies it.
 */
import { allowGeneratedScriptPlaceholders, generatedScriptPlaceholderIdsFor } from './ledger';
import { convertAutomation, generatedScriptPlaceholderId } from './convertAutomation';
import { AUTOMATION, ctx, row } from './__fixtures__/automations';

const OTHER_AUTOMATION = '77777777-7777-4777-8777-777777777777';
const FOREIGN_SCRIPT = '88888888-8888-4888-8888-888888888888';

const ACTIONS = [
  { type: 'run_script', scriptId: '33333333-3333-4333-8333-333333333333', whenOffline: 'queue' },
  { type: 'execute_command', command: 'Get-Date', shell: 'powershell' },
  'not-a-record',
  { type: 'execute_command', command: 'Get-Service', shell: 'powershell' },
];

function doc(scriptIds: string[]) {
  return {
    version: 1, name: 'Moved', trigger: { type: 'manual' }, inputs: [],
    steps: scriptIds.map((scriptId, i) => ({
      id: `a${i}_command`, tool: 'run_script_on_targets', approval: 'default', onFailure: 'continue', timeoutSec: 3600,
      input: { scriptId, whenOffline: 'queue', target: { type: 'devices', deviceIds: [] } },
    })),
  };
}
const notOwned = (i: number): FlowIssue => ({
  code: 'reference_not_owned', severity: 'error', message: 'This script is not available to the flow\'s owner.',
  stepId: `a${i}_command`, pointer: `/steps/${i}/input/scriptId`,
});
function validation(document: ReturnType<typeof doc>, issues: FlowIssue[]) {
  return { valid: false, effectiveTier: 3 as const, steps: [], issues, document: document as never };
}

describe('generatedScriptPlaceholderIdsFor', () => {
  it('is exactly the placeholders the converter writes into the draft', () => {
    const r = convertAutomation(row({ actions: ACTIONS as never, onFailure: 'continue' }), ctx({ currentTargets: { count: 2, osTypes: new Set(['windows']) } }));
    const fromDocument = new Set((r.document?.steps ?? [])
      .filter((s) => s.tool === 'run_script_on_targets' && s.id.endsWith('_command'))
      .map((s) => s.input.scriptId as string));
    expect(fromDocument.size).toBe(2);
    expect(generatedScriptPlaceholderIdsFor(AUTOMATION, ACTIONS)).toEqual(fromDocument);
  });

  it('a restart_service command becomes no step, so it has no placeholder; indexes still count it', () => {
    const actions = [{ type: 'execute_command', kind: 'restart_service', command: '' }, { type: 'execute_command', command: 'Get-Date' }];
    expect(generatedScriptPlaceholderIdsFor(AUTOMATION, actions)).toEqual(new Set([generatedScriptPlaceholderId(AUTOMATION, 1)]));
  });

  it('a Job with no command action, or no actions array, allows nothing', () => {
    expect(generatedScriptPlaceholderIdsFor(AUTOMATION, [ACTIONS[0]])).toEqual(new Set());
    expect(generatedScriptPlaceholderIdsFor(AUTOMATION, null)).toEqual(new Set());
  });
});

describe('allowGeneratedScriptPlaceholders', () => {
  const allowed = generatedScriptPlaceholderIdsFor(AUTOMATION, ACTIONS);
  const mine = generatedScriptPlaceholderId(AUTOMATION, 1);

  it("this conversion's placeholder is accepted at save and the draft becomes valid", () => {
    const d = doc([mine]);
    const out = allowGeneratedScriptPlaceholders(validation(d, [notOwned(0)]), allowed);
    expect(out.issues).toEqual([]);
    expect(out.valid).toBe(true);
    expect(out.document).toBe(d);
  });

  it("another tenant's real script id in that draft is still reference_not_owned", () => {
    const out = allowGeneratedScriptPlaceholders(validation(doc([mine, FOREIGN_SCRIPT]), [notOwned(0), notOwned(1)]), allowed);
    expect(out.issues).toEqual([notOwned(1)]);
    expect(out.valid).toBe(false);
  });

  it('a placeholder belonging to a different conversion is refused', () => {
    const theirs = generatedScriptPlaceholderId(OTHER_AUTOMATION, 1);
    const out = allowGeneratedScriptPlaceholders(validation(doc([theirs]), [notOwned(0)]), allowed);
    expect(out.issues).toEqual([notOwned(0)]);
    expect(out.valid).toBe(false);
  });

  it('with no live shadow conversion (nothing allowed) a placeholder is refused', () => {
    const out = allowGeneratedScriptPlaceholders(validation(doc([mine]), [notOwned(0)]), new Set());
    expect(out.issues).toEqual([notOwned(0)]);
    expect(out.valid).toBe(false);
  });

  it('every other issue is untouched, including reference_not_owned on another field', () => {
    const d = doc([mine]);
    const group: FlowIssue = { ...notOwned(0), pointer: '/steps/0/input/target/groupIds/0', message: 'group' };
    const schema: FlowIssue = { code: 'schema', severity: 'error', message: 'x', pointer: '/name' };
    const out = allowGeneratedScriptPlaceholders(validation(d, [notOwned(0), group, schema]), allowed);
    expect(out.issues).toEqual([group, schema]);
    expect(out.valid).toBe(false);
  });

  it('a pointer whose step does not name that id is not excused (the id is read from the document, not the issue)', () => {
    const d = doc([FOREIGN_SCRIPT]);
    const out = allowGeneratedScriptPlaceholders(validation(d, [notOwned(0)]), allowed);
    expect(out.issues).toEqual([notOwned(0)]);
  });
});
