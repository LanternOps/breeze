import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  PROMPT_KINDS,
  PROMPT_KIND_NAMES,
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
  promptPresentedSchema,
  promptShowSchema,
  promptSkewMatrixSchema,
  promptUpdateSchema,
} from './index';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'prompt-host');

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, name), 'utf8'));
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
  [/^heartbeat\.prompt_host\.json$/, promptHostHeartbeatFixtureSchema],
  [/^skew-matrix\.json$/, promptSkewMatrixSchema],
];

const REQUIRED_FIXTURES = [
  'show.notice.json',
  'show.restart.json',
  'show.elevation.waiting.json',
  'update.state.json',
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
  'skew-matrix.json',
];

const fixtureFiles = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.json')).sort();

describe('prompt-host golden fixtures', () => {
  it('ships every fixture the agent and Assist suites decode', () => {
    expect(fixtureFiles).toEqual([...REQUIRED_FIXTURES].sort());
  });

  it.each(fixtureFiles)('%s parses with its schema', (file) => {
    const matches = SCHEMA_BY_PREFIX.filter(([re]) => re.test(file));
    expect(matches, `exactly one schema claims ${file}`).toHaveLength(1);
    const result = matches[0]![1].safeParse(fixture(file));
    expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
  });

  const showFixtures = fixtureFiles.filter((f) => f.startsWith('show.'));
  it.each(showFixtures)('%s: a decision carries exactly one safe action and defaults to it', (file) => {
    const show = promptShowSchema.parse(fixture(file));
    if (!isPromptDecision(show.state, show.presentation)) return;
    const safe = show.actions.filter((a) => a.role === 'safe');
    expect(safe).toHaveLength(1);
    expect(show.defaultActionId).toBe(safe[0]!.id);
  });

  it('includes at least one decision fixture', () => {
    const decisions = showFixtures
      .map((f) => promptShowSchema.parse(fixture(f)))
      .filter((s) => isPromptDecision(s.state, s.presentation));
    expect(decisions.length).toBeGreaterThan(0);
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

describe('promptShowSchema invariants', () => {
  const base = () => promptShowSchema.parse(fixture('show.restart.json'));

  it('refuses a decision with no safe action', () => {
    const show = base();
    show.actions = show.actions.map((a) => ({ ...a, role: 'proceed' as const }));
    expect(promptShowSchema.safeParse(show).success).toBe(false);
  });

  it('refuses a decision with two safe actions', () => {
    const show = base();
    show.actions = show.actions.map((a) => ({ ...a, role: 'safe' as const }));
    expect(promptShowSchema.safeParse(show).success).toBe(false);
  });

  it('refuses a decision whose default is not the safe action', () => {
    const show = base();
    show.defaultActionId = 'restart_now';
    expect(promptShowSchema.safeParse(show).success).toBe(false);
  });

  it('refuses a decision with no default', () => {
    const show = base();
    delete (show as { defaultActionId?: string }).defaultActionId;
    expect(promptShowSchema.safeParse(show).success).toBe(false);
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
    expect(promptShowSchema.safeParse(show).success).toBe(false);
  });

  it('refuses both an absolute deadline and a response window', () => {
    const show = base();
    show.timing = { ...show.timing, responseMs: 30_000 };
    expect(promptShowSchema.safeParse(show).success).toBe(false);
  });

  it('refuses an expiry action that is not one of the actions', () => {
    const show = base();
    show.timing = { ...show.timing, expiry: { actionId: 'nope', text: 'x' } };
    expect(promptShowSchema.safeParse(show).success).toBe(false);
  });

  it('refuses operator text on a breeze-class kind', () => {
    const show = promptShowSchema.parse(fixture('show.notice.json'));
    show.copy = { ...show.copy, operatorNote: 'Call 555-0100' };
    expect(promptShowSchema.safeParse(show).success).toBe(false);
  });

  it('allows operator text on an operator-class kind', () => {
    expect(base().copy.operatorNote).toBeTruthy();
  });

  it('accepts an indicator in pending with no default (not a decision)', () => {
    const show = promptShowSchema.parse(fixture('show.notice.json'));
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
});

describe('promptUpdateSchema invariants', () => {
  it('refuses a default without the actions it names', () => {
    const update = promptUpdateSchema.parse(fixture('update.state.json'));
    delete (update as { actions?: unknown }).actions;
    expect(promptUpdateSchema.safeParse(update).success).toBe(false);
  });

  it('refuses a default that names no action', () => {
    const update = promptUpdateSchema.parse(fixture('update.state.json'));
    update.defaultActionId = 'missing';
    expect(promptUpdateSchema.safeParse(update).success).toBe(false);
  });
});

describe('promptAuthRequestSchema', () => {
  it('refuses a malformed kind advertisement', () => {
    const auth = fixture('auth.prompt_v1.json') as Record<string, unknown>;
    expect(promptAuthRequestSchema.safeParse({ ...auth, promptKinds: ['notice.info'] }).success).toBe(false);
  });
});

describe('parsePromptKindAd', () => {
  it.each([
    ['notice.info@1', { name: 'notice.info', version: 1 }],
    ['elevation.request@12', { name: 'elevation.request', version: 12 }],
    ['notice.info', null],
    ['notice.info@0', null],
    ['notice@1', null],
    ['Notice.info@1', null],
    ['notice.info@1@2', null],
    ['notice.info@1234', null],
  ])('%s', (input, expected) => {
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
