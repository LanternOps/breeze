import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  PROMPT_KINDS,
  PROMPT_KIND_NAMES,
  applyPromptUpdate,
  isPromptDecision,
  negotiatePromptKindVersion,
  parsePromptKindAd,
  promptActionResultSchema,
  promptActionSchema,
  promptAuthRequestSchema,
  promptBrandingSyncSchema,
  promptCloseSchema,
  promptClosedSchema,
  promptHostHeartbeatFixtureSchema,
  promptKindAdSchema,
  promptPresentedSchema,
  promptShowSchema,
  promptSkewMatrixSchema,
  promptUpdateSchema,
  type PromptShow,
} from './index';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'prompt-host');

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, name), 'utf8'));
}

function showFixture(name: string): PromptShow {
  return promptShowSchema.parse(fixture(name));
}

/** Asserts a refusal AND that it is refused for the stated reason, not an unrelated check. */
function expectRefused(result: { success: boolean; error?: { issues: Array<{ message: string }> } }, reason: string) {
  expect(result.success).toBe(false);
  expect(result.error!.issues.map((i) => i.message).join(' | ')).toContain(reason);
}

/** Every fixture is claimed by exactly one schema, keyed by file-name prefix. */
const SCHEMA_BY_PREFIX: Array<[RegExp, z.ZodType]> = [
  [/^show\./, promptShowSchema],
  [/^update\./, promptUpdateSchema],
  [/^close\./, promptCloseSchema],
  [/^presented\.json$/, promptPresentedSchema],
  [/^action\.json$/, promptActionSchema],
  [/^action_result\./, promptActionResultSchema],
  [/^closed\./, promptClosedSchema],
  [/^branding_sync\./, promptBrandingSyncSchema],
  [/^auth\./, promptAuthRequestSchema],
  [/^heartbeat\.prompt_host(\.empty)?\.json$/, promptHostHeartbeatFixtureSchema],
  [/^skew-matrix\.json$/, promptSkewMatrixSchema],
];

const REQUIRED_FIXTURES = [
  'show.notice.json',
  'show.restart.json',
  'show.elevation.waiting.json',
  'update.state.json',
  'update.cleared_actions.json',
  'close.fenced.json',
  'presented.json',
  'action.json',
  'action_result.accepted.json',
  'action_result.rejected_stale.json',
  'closed.render_failed.json',
  'branding_sync.set.json',
  'branding_sync.cleared.json',
  'auth.prompt_v1.json',
  'auth.legacy.json',
  'heartbeat.prompt_host.json',
  'heartbeat.prompt_host.empty.json',
  'skew-matrix.json',
];

const fixtureFiles = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.json')).sort();

function schemaFor(file: string): z.ZodType {
  const matches = SCHEMA_BY_PREFIX.filter(([re]) => re.test(file));
  expect(matches, `exactly one schema claims ${file}`).toHaveLength(1);
  return matches[0]![1];
}

describe('prompt-host golden fixtures', () => {
  it('ships every fixture the agent and Assist suites decode', () => {
    expect(fixtureFiles).toEqual([...REQUIRED_FIXTURES].sort());
  });

  it.each(fixtureFiles)('%s parses with its schema', (file) => {
    const result = schemaFor(file).safeParse(fixture(file));
    expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
  });

  // Decoders ignore unknown keys (forward compatibility), so a misspelled
  // fixture key would parse. Pin that every fixture key is one the schema knows.
  it.each(fixtureFiles)('%s carries no key its schema does not know', (file) => {
    expect(schemaFor(file).parse(fixture(file))).toEqual(fixture(file));
  });

  it('the decision fixtures are decisions and the waiting fixture is not', () => {
    for (const f of ['show.notice.json', 'show.restart.json']) {
      const s = showFixture(f);
      expect(isPromptDecision(s.state, s.presentation), f).toBe(true);
    }
    const waiting = showFixture('show.elevation.waiting.json');
    expect(isPromptDecision(waiting.state, waiting.presentation)).toBe(false);
  });

  it.each(['show.notice.json', 'show.restart.json'])('%s: exactly one safe action and the default names it', (file) => {
    const show = showFixture(file);
    const safe = show.actions.filter((a) => a.role === 'safe');
    expect(safe).toHaveLength(1);
    expect(show.defaultActionId).toBe(safe[0]!.id);
  });

  it('branding_sync.set logo bytes and sha256 describe the embedded data', () => {
    const sync = promptBrandingSyncSchema.parse(fixture('branding_sync.set.json'));
    if (sync.cleared) throw new Error('expected a set identity');
    const bytes = Buffer.from(sync.logo!.data, 'base64');
    expect(bytes.length).toBe(sync.logo!.bytes);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(sync.logo!.sha256);
  });

  it('auth.legacy carries none of the prompt additions', () => {
    const legacy = fixture('auth.legacy.json') as Record<string, unknown>;
    for (const key of ['promptProtocolVersion', 'promptKinds', 'rendererVersion']) {
      expect(legacy).not.toHaveProperty(key);
    }
  });

  it('update.cleared_actions keeps an explicit empty action list (present means replace)', () => {
    const update = promptUpdateSchema.parse(fixture('update.cleared_actions.json'));
    expect(update.actions).toEqual([]);
  });
});

describe('kind registry', () => {
  // Spec §3.1 kind registry: copy class per kind, and the scope that follows from it.
  const SPEC_CLASSES: Record<string, 'breeze' | 'operator'> = {
    'notice.info': 'breeze',
    'restart.prompt': 'operator',
    'restart.final': 'operator',
    'remote.consent': 'breeze',
    'remote.session': 'breeze',
    'elevation.request': 'breeze',
  };

  it('has exactly the six spec kinds', () => {
    expect([...PROMPT_KIND_NAMES].sort()).toEqual(Object.keys(SPEC_CLASSES).sort());
  });

  it.each(Object.entries(SPEC_CLASSES))('%s is class %s with the matching scope', (kind, copyClass) => {
    const def = PROMPT_KINDS[kind as keyof typeof PROMPT_KINDS];
    expect(def.copyClass).toBe(copyClass);
    expect(def.scope).toBe(copyClass === 'operator' ? 'prompt_operator' : 'prompt');
  });
});

describe('isPromptDecision', () => {
  it.each([
    ['pending', 'card', true],
    ['pending', 'modal', true],
    ['pending', 'list_only', true],
    ['pending', 'indicator', false],
    ['waiting', 'card', false],
    ['approved', 'card', false],
    ['expired', 'modal', false],
  ] as const)('%s + %s -> %s', (state, presentation, expected) => {
    expect(isPromptDecision(state, presentation)).toBe(expected);
  });
});

describe('promptShowSchema invariants', () => {
  const base = () => showFixture('show.restart.json');

  it('refuses a decision with no safe action', () => {
    const show = base();
    show.actions = show.actions.map((a) => ({ ...a, role: 'proceed' as const }));
    expectRefused(promptShowSchema.safeParse(show), 'exactly one safe action');
  });

  it('refuses a decision with two safe actions', () => {
    const show = base();
    show.actions = show.actions.map((a) => ({ ...a, role: 'safe' as const }));
    expectRefused(promptShowSchema.safeParse(show), 'exactly one safe action');
  });

  it('refuses a decision whose default is not the safe action', () => {
    const show = base();
    expect(show.actions.map((a) => a.id)).toContain('restart_now');
    show.defaultActionId = 'restart_now';
    expectRefused(promptShowSchema.safeParse(show), 'a decision defaults to its safe action');
  });

  it('refuses a decision with no default', () => {
    const show = base();
    delete (show as { defaultActionId?: string }).defaultActionId;
    expectRefused(promptShowSchema.safeParse(show), 'a decision defaults to its safe action');
  });

  it('refuses more than three actions', () => {
    const show = base();
    show.actions = [
      ...show.actions,
      { id: 'a3', label: 'Three', role: 'neutral' },
      { id: 'a4', label: 'Four', role: 'neutral' },
    ];
    expect(promptShowSchema.safeParse(show).success).toBe(false);
  });

  it('refuses duplicate action ids', () => {
    const show = base();
    show.actions = [show.actions[0]!, { ...show.actions[1]!, id: show.actions[0]!.id }];
    expectRefused(promptShowSchema.safeParse(show), 'duplicate action id');
  });

  it('refuses a default that names no action (not a decision)', () => {
    const show = showFixture('show.elevation.waiting.json');
    show.defaultActionId = 'missing';
    expectRefused(promptShowSchema.safeParse(show), 'defaultActionId names no action');
  });

  it('refuses both an absolute deadline and a response window', () => {
    const show = base();
    show.timing = { ...show.timing, responseMs: 30_000 };
    expectRefused(promptShowSchema.safeParse(show), 'deadlineUnixMs and responseMs are exclusive');
  });

  it('refuses an expiry action that is not one of the actions', () => {
    const show = base();
    show.timing = { ...show.timing, expiry: { actionId: 'nope', text: 'x' } };
    expectRefused(promptShowSchema.safeParse(show), 'expiry names no action');
  });

  it('refuses operator text on a breeze-class kind', () => {
    const show = showFixture('show.notice.json');
    show.copy = { ...show.copy, operatorNote: 'Call 555-0100' };
    expectRefused(promptShowSchema.safeParse(show), 'operator text on a breeze-class kind');
  });

  it('refuses operator text on a kind outside the registry (fails closed)', () => {
    const show = showFixture('show.notice.json');
    show.kind = 'future.kind';
    show.copy = { ...show.copy, operatorNote: 'x' };
    expectRefused(promptShowSchema.safeParse(show), 'operator text on a breeze-class kind');
  });

  it('allows operator text on an operator-class kind', () => {
    expect(base().copy.operatorNote).toBeTruthy();
  });

  it('accepts an indicator in pending with no default (not a decision)', () => {
    const show = showFixture('show.notice.json');
    const indicator = {
      ...show,
      promptId: 'session:00000000-0000-4000-8000-0000000000aa',
      kind: 'remote.session',
      presentation: 'indicator',
      actions: [{ id: 'details', label: 'Details', role: 'neutral' }],
    };
    delete (indicator as { defaultActionId?: string }).defaultActionId;
    expect(promptShowSchema.safeParse(indicator).success).toBe(true);
  });

  it('refuses a random-looking prompt id without a domain prefix', () => {
    const show = base();
    show.promptId = '7f3c2a10';
    expect(promptShowSchema.safeParse(show).success).toBe(false);
  });

  it('ignores an unknown additive field (forward compatible) and strips it', () => {
    const parsed = promptShowSchema.safeParse({ ...base(), futureField: 1 });
    expect(parsed.success).toBe(true);
    expect(parsed.data).not.toHaveProperty('futureField');
  });
});

describe('promptUpdateSchema invariants', () => {
  const base = () => promptUpdateSchema.parse(fixture('update.state.json'));

  it('refuses a default without the actions it names', () => {
    const update = base();
    delete (update as { actions?: unknown }).actions;
    expectRefused(promptUpdateSchema.safeParse(update), 'defaultActionId travels with actions');
  });

  it('refuses a default that names no action', () => {
    const update = base();
    update.defaultActionId = 'missing';
    expectRefused(promptUpdateSchema.safeParse(update), 'defaultActionId names no action');
  });

  it('refuses duplicate action ids', () => {
    const update = base();
    update.actions = [update.actions![0]!, { ...update.actions![0]! }];
    expectRefused(promptUpdateSchema.safeParse(update), 'duplicate action id');
  });

  it('refuses more than three actions', () => {
    const update = base();
    update.actions = ['a', 'b', 'c', 'd'].map((id) => ({ id, label: id, role: 'neutral' as const }));
    delete update.defaultActionId;
    expect(promptUpdateSchema.safeParse(update).success).toBe(false);
  });

  it('refuses both an absolute deadline and a response window', () => {
    const update = base();
    update.timing = { presentWithinMs: 10_000, deadlineUnixMs: 1, responseMs: 1 };
    expectRefused(promptUpdateSchema.safeParse(update), 'deadlineUnixMs and responseMs are exclusive');
  });
});

describe('applyPromptUpdate (merged-state validation)', () => {
  const show = () => showFixture('show.restart.json');

  it('merges present fields, replaces actions and default together, and takes the new rev and lease', () => {
    const result = applyPromptUpdate(show(), {
      promptId: 'restart:42',
      rev: 2,
      lease: { rendererSession: 'assist-user-5000', epoch: 2 },
      state: 'approved',
      actions: [],
    });
    expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
    expect(result.data!.rev).toBe(2);
    expect(result.data!.lease).toEqual({ rendererSession: 'assist-user-5000', epoch: 2 });
    expect(result.data!.actions).toEqual([]);
    expect(result.data!.defaultActionId).toBeUndefined();
    expect(result.data!.copy).toEqual(show().copy);
  });

  it('refuses an update that leaves a pending decision without a safe default', () => {
    const result = applyPromptUpdate(show(), {
      promptId: 'restart:42',
      rev: 2,
      lease: { rendererSession: 'assist-user-4242', epoch: 1 },
      actions: [{ id: 'restart_now', label: 'Restart now', role: 'proceed' }],
    });
    expectRefused(result, 'exactly one safe action');
  });

  it('refuses operator text added to a breeze-class prompt through an update', () => {
    const notice = showFixture('show.notice.json');
    const result = applyPromptUpdate(notice, {
      promptId: notice.promptId,
      rev: 2,
      lease: notice.lease,
      copy: { ...notice.copy, operatorNote: 'x' },
    });
    expectRefused(result, 'operator text on a breeze-class kind');
  });

  it('refuses an update for another prompt or with a rev that is not newer', () => {
    expectRefused(
      applyPromptUpdate(show(), { promptId: 'restart:43', rev: 2, lease: show().lease }),
      'update is for another prompt',
    );
    expectRefused(applyPromptUpdate(show(), { promptId: 'restart:42', rev: 1, lease: show().lease }), 'rev is not newer');
  });
});

describe('promptBrandingSyncSchema', () => {
  const set = () => fixture('branding_sync.set.json') as Record<string, any>;

  it('accepts the set identity with cleared:false and the cleared form', () => {
    expect(promptBrandingSyncSchema.safeParse(set()).success).toBe(true);
    expect(promptBrandingSyncSchema.safeParse({ cleared: true, locale: 'en' }).success).toBe(true);
  });

  it.each([
    ['an SVG logo', (s: any) => (s.logo.mime = 'image/svg+xml')],
    ['a URL instead of bytes', (s: any) => (s.logo.data = 'https://example.invalid/x.png')],
    ['a logo over 256 KB', (s: any) => (s.logo.bytes = 262_145)],
    ['a colour that is not #RRGGBB', (s: any) => (s.primaryColor = 'red')],
    ['a scopeId of the wrong length', (s: any) => (s.scopeId = 'abc')],
    ['base64 whose length is not a multiple of 4', (s: any) => (s.logo.data = s.logo.data.slice(0, -1))],
    ['bytes that disagree with the decoded data', (s: any) => (s.logo.bytes = 70)],
    ['no cleared flag', (s: any) => delete s.cleared],
    ['a name over 120 code points', (s: any) => (s.partnerName = 'é'.repeat(121))],
  ])('refuses %s', (_label, mutate) => {
    const s = set();
    mutate(s);
    expect(promptBrandingSyncSchema.safeParse(s).success).toBe(false);
  });

  it('counts the 120-character name cap in code points, not bytes', () => {
    expect(promptBrandingSyncSchema.safeParse({ ...set(), partnerName: 'é'.repeat(120) }).success).toBe(true);
  });

  it('refuses identity fields on the cleared form', () => {
    expect(promptBrandingSyncSchema.safeParse({ cleared: true, locale: 'en', partnerName: 'x' }).success).toBe(false);
  });
});

describe('kind advertisements', () => {
  it('refuses a malformed kind advertisement at auth', () => {
    const auth = fixture('auth.prompt_v1.json') as Record<string, unknown>;
    expect(promptAuthRequestSchema.safeParse({ ...auth, promptKinds: ['notice.info'] }).success).toBe(false);
    expect(promptAuthRequestSchema.safeParse({ ...auth, promptKinds: ['notice.info@0'] }).success).toBe(false);
  });

  it.each(['notice.info@0', 'notice.info@01', 'notice.info@001', 'notice.info@1000', 'notice.info'])(
    'promptKindAdSchema refuses %s',
    (ad) => {
      expect(promptKindAdSchema.safeParse(ad).success).toBe(false);
    },
  );

  it.each([
    ['notice.info@1', { name: 'notice.info', version: 1 }],
    ['elevation.request@12', { name: 'elevation.request', version: 12 }],
    ['notice.info@999', { name: 'notice.info', version: 999 }],
    ['notice.info', null],
    ['notice.info@0', null],
    ['notice.info@01', null],
    ['notice@1', null],
    ['Notice.info@1', null],
    ['notice.info@1@2', null],
    ['notice.info@1234', null],
  ])('parsePromptKindAd(%s)', (input, expected) => {
    expect(parsePromptKindAd(input)).toEqual(expected);
  });
});

describe('skew matrix (spec §8)', () => {
  const rows = promptSkewMatrixSchema.parse(fixture('skew-matrix.json'));

  it.each(rows.map((r) => [r.name, r] as const))('%s', (_name, row) => {
    const version = negotiatePromptKindVersion(row.kind, row.agentSpeaks, row.rendererAdvertises, row.enabled);
    expect(version === null ? 'legacy' : 'prompt').toBe(row.expectedPath);
    if (row.expectedPath === 'prompt') expect(version).toBe(row.expectedVersion);
  });

  it('covers every spec §8 combination', () => {
    const names = rows.map((r) => r.name).join('\n');
    for (const needle of [
      'new agent + old Assist',
      'old agent + new Assist',
      'new agent + new Assist',
      'native user-helper only',
      'kind disabled',
      'kind@n entry',
      'old native process survives an agent update',
    ]) {
      expect(names).toContain(needle);
    }
  });
});
