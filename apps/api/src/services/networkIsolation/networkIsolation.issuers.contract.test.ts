import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * #10919, spec safety invariant 4: no bypass can isolate or release outside the service. These are
 * source scans, the control with a record on this class of omission. Each scan asserts it found
 * something, so an empty scan cannot pass. A row written some other way is still cancelled at
 * delivery by the episode binding (deliveryBinding.ts); these scans keep the refusal early and loud.
 */
const API_SRC = resolve(__dirname, '../..');
const REPO_ROOT = resolve(API_SRC, '../../..');
const read = (rel: string) => readFileSync(join(API_SRC, rel), 'utf8');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__tests__' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry) && !/\.(test|spec)\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const DISPATCHERS = 'queueCommand|queueCommandForExecution|queueCommandForExecutionWithSystemPrecheck|executeCommand|'
  + 'executeCommandWithCallerPrecheck|executeCommandWithSystemPrecheck|dispatchDeviceCommand|insertQueuedCommandInTransaction|sendCommandToAgent';
const RAW_DISPATCH = new RegExp(`\\b(?:${DISPATCHERS})\\s*\\(`);

describe('every aiDispatch entry point refuses a raw isolation command before dispatch', () => {
  const source = read('services/aiDispatch.ts');
  // Any export starts a new body, so a later non-async dispatcher cannot hide in its neighbour's.
  const starts = [...source.matchAll(/^export (?:async )?(?:function|const|class) (\w+)/gm)];
  const bodies = starts.map((m, i) => ({
    name: m[1]!,
    body: source.slice(m.index!, i + 1 < starts.length ? starts[i + 1]!.index : source.length),
  }));
  // The script lane has no `type` input: it can only ever dispatch `script`.
  const EXEMPT = new Set(['aiDispatchScriptToDevice']);

  it('scans the entry points (non-empty)', () => {
    expect(bodies.map((b) => b.name)).toEqual(expect.arrayContaining([
      'aiExecuteCommand', 'aiExecuteCommandWithSystemPrecheck', 'aiQueueCommandForExecution',
      'aiQueueCommand', 'aiDispatchDeviceCommand', 'aiInsertQueuedCommandInTransaction',
    ]));
  });
  it('each one that reaches a raw dispatch checks first', () => {
    const offenders = bodies.filter((b) => !EXEMPT.has(b.name)).filter((b) => {
      const raw = b.body.search(RAW_DISPATCH);
      const check = b.body.search(/\brefuseRawNetworkIsolation\s*\(/);
      return raw >= 0 && (check < 0 || check > raw);
    }).map((b) => b.name);
    expect(offenders, 'An aiDispatch entry point can queue a raw network-isolation command.').toEqual([]);
  });
});

describe('only the isolation service issues isolation commands', () => {
  const files = [...walk(API_SRC), ...walk(join(REPO_ROOT, 'ee'))];
  // A dispatch call whose arguments name a containment command type before the statement ends.
  const NAMES_CONTAINMENT = new RegExp(
    `\\b(?:queue|ai\\w*Command\\w*|${DISPATCHERS})\\s*\\([^;]*?`
      + `(?:['"](?:execute|release)_containment['"]|CommandTypes\\.(?:EXECUTE|RELEASE)_CONTAINMENT)`,
  );
  const ISSUERS = new Map([
    // The sole issuer: the row it queues is the one the episode row names.
    ['services/networkIsolation/service.ts', 'sole issuer'],
    // Queues execute_containment for process_kill / account_disable / usb_block. Its
    // network_isolation branch calls the service and returns; aiDispatch refuses it regardless.
    ['services/aiToolsIncident.ts', 'non-isolation containment'],
  ]);
  const matching = () => files.filter((file) => NAMES_CONTAINMENT.test(readFileSync(file, 'utf8')))
    .map((file) => relative(API_SRC, file));

  it('scans the API and extension sources (non-empty)', () => {
    expect(files.length).toBeGreaterThan(1000);
  });
  it('no other file dispatches a containment command type', () => {
    expect(matching().filter((rel) => !ISSUERS.has(rel)).sort()).toEqual([]);
  });
  it('the scan really finds both known issuers', () => {
    expect(matching()).toEqual(expect.arrayContaining([...ISSUERS.keys()]));
  });
  it('the incident tool leaves its isolation branch before the raw queue', () => {
    const source = read('services/aiToolsIncident.ts');
    const branch = source.indexOf("input.actionType === 'network_isolation'");
    const service = source.indexOf('startNetworkIsolation(auth', branch);
    const raw = source.indexOf('aiQueueCommandForExecution(', branch);
    expect(branch).toBeGreaterThan(0);
    expect(service).toBeGreaterThan(branch);
    expect(raw).toBeGreaterThan(service);
    expect(source.slice(branch, raw)).toMatch(/return JSON\.stringify\(\{ success: true, \.\.\.result \}\)/);
  });
});

describe('the flow and agent-SDK lanes have no raw isolation path of their own', () => {
  it('flows reach devices only through the tool registry', () => {
    const flowFiles = walk(join(API_SRC, 'services/flows'));
    expect(flowFiles.length).toBeGreaterThan(10);
    const raw = flowFiles.filter((file) => RAW_DISPATCH.test(readFileSync(file, 'utf8'))).map((file) => relative(API_SRC, file));
    expect(raw).toEqual([]);
    expect(read('services/flows/stepExecutor.ts')).toMatch(/executeTool\(tool, rendered, i\.auth\)/);
  });
  it('the agent SDK declares both containment tools as registry handlers and dispatches nothing itself', () => {
    const source = read('services/aiAgentSdkTools.ts');
    expect(source).toMatch(/makeHandler\('execute_containment'/);
    expect(source).toMatch(/makeHandler\('release_containment'/);
    expect(source).not.toMatch(RAW_DISPATCH);
  });
});
