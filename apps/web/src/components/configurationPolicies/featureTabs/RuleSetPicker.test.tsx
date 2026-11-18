import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { YARA_BUILTIN_RULE_SET_ID, YARA_MAX_RULE_SETS_PER_POLICY } from '@breeze/shared';

const { fetchWithAuth } = vi.hoisted(() => ({ fetchWithAuth: vi.fn() }));
vi.mock('@/stores/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/stores/auth')>()),
  fetchWithAuth,
}));

import RuleSetPicker, { attachableRuleSets } from './RuleSetPicker';
import type { YaraRuleSetSummary } from '../../security/detectionRules/ruleSetsApi';

const json = (status: number, payload: unknown) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  }) as unknown as Response;

function set(over: Partial<YaraRuleSetSummary>): YaraRuleSetSummary {
  return {
    id: 'x',
    orgId: null,
    partnerId: null,
    name: 'Set',
    description: null,
    source: 'custom',
    isBuiltin: false,
    enabled: true,
    autoQuarantine: false,
    currentVersion: 1,
    publishedVersion: 1,
    publishedSha256: null,
    publishedAt: null,
    publishedEngine: null,
    stale: false,
    ruleCount: 1,
    createdAt: '2026-10-20T00:00:00.000Z',
    updatedAt: '2026-10-20T00:00:00.000Z',
    ...over,
  };
}

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const BUILTIN = set({ id: YARA_BUILTIN_RULE_SET_ID, isBuiltin: true, name: 'Breeze built-in', source: 'builtin' });
const PARTNER = set({ id: 'aaaaaaaa-0000-4000-8000-000000000001', partnerId: 'p-1', name: 'MSP wide' });
const OTHER_PARTNER = set({ id: 'aaaaaaaa-0000-4000-8000-000000000009', partnerId: 'p-2', name: 'Other MSP' });
const A1 = set({ id: 'aaaaaaaa-0000-4000-8000-0000000000a1', orgId: ORG_A, name: 'A one' });
const A_STALE = set({ id: 'aaaaaaaa-0000-4000-8000-0000000000a2', orgId: ORG_A, name: 'A stale', stale: true });
const A_NEW = set({ id: 'aaaaaaaa-0000-4000-8000-0000000000a3', orgId: ORG_A, name: 'A new', publishedVersion: 0 });
const A_OFF = set({ id: 'aaaaaaaa-0000-4000-8000-0000000000a4', orgId: ORG_A, name: 'A off', enabled: false });
const B1 = set({ id: 'bbbbbbbb-0000-4000-8000-0000000000b1', orgId: ORG_B, name: 'B one' });
const ALL = [BUILTIN, PARTNER, A1, A_STALE, A_NEW, A_OFF, B1];

async function settle() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

const ids = (sets: YaraRuleSetSummary[]) => sets.map((s) => s.id).sort();

describe('attachableRuleSets — mirrors checkSecurityRuleSetsWrite, keyed on the POLICY owner', () => {
  it('org policy for org A (viewer sees A and B): A sets + partner-wide + built-in, never B', () => {
    expect(ids(attachableRuleSets(ALL, { orgId: ORG_A, partnerId: null }))).toEqual(
      ids([BUILTIN, PARTNER, A1, A_STALE, A_NEW, A_OFF]),
    );
  });

  it('partner-wide policy: partner-wide + built-in only', () => {
    expect(ids(attachableRuleSets(ALL, { orgId: null, partnerId: 'p-1' }))).toEqual(ids([BUILTIN, PARTNER]));
  });

  it('a known owner partner excludes another partner’s partner-wide sets', () => {
    expect(ids(attachableRuleSets([...ALL, OTHER_PARTNER], { orgId: null, partnerId: 'p-1' }))).toEqual(
      ids([BUILTIN, PARTNER]),
    );
  });

  it('disabled, never-published and stale sets stay attachable', () => {
    const got = ids(attachableRuleSets(ALL, { orgId: ORG_A, partnerId: null }));
    expect(got).toEqual(expect.arrayContaining([A_STALE.id, A_NEW.id, A_OFF.id]));
  });

  it('an undefined owner (policy editor did not pass it) returns the list unfiltered — never guessed partner-wide', () => {
    expect(ids(attachableRuleSets(ALL, { orgId: undefined, partnerId: null }))).toEqual(ids(ALL));
  });
});

describe('RuleSetPicker', () => {
  const onChange = vi.fn();
  const onBlockingChange = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    fetchWithAuth.mockResolvedValue(json(200, { data: ALL }));
  });

  function renderPicker(props: Partial<React.ComponentProps<typeof RuleSetPicker>> = {}) {
    return render(
      <RuleSetPicker
        value={[]}
        onChange={onChange}
        policyOwner={{ orgId: ORG_A, partnerId: null }}
        disabled={false}
        onBlockingChange={onBlockingChange}
        {...props}
      />,
    );
  }

  it('trap 2: the list fetch pins the policy owner, not the switcher org', async () => {
    renderPicker();
    await settle();
    expect(fetchWithAuth).toHaveBeenCalledWith('/security/yara/rule-sets', expect.objectContaining({ orgIdOverride: ORG_A }));

    fetchWithAuth.mockClear();
    renderPicker({ policyOwner: { orgId: null, partnerId: 'p-1' } });
    await settle();
    expect(fetchWithAuth).toHaveBeenCalledWith(
      '/security/yara/rule-sets',
      expect.objectContaining({ skipOrgIdInjection: true }),
    );
  });

  it('renders the attachable sets with owner and status badges', async () => {
    renderPicker();
    await settle();

    expect(screen.queryByTestId(`rule-set-option-${B1.id}`)).toBeNull();
    const row = (id: string) => screen.getByTestId(`rule-set-option-row-${id}`);
    expect(row(BUILTIN.id).querySelector('[data-testid="rule-set-option-badge-builtin"]')).not.toBeNull();
    expect(row(PARTNER.id).querySelector('[data-testid="rule-set-option-badge-all-orgs"]')).not.toBeNull();
    expect(row(A_STALE.id).querySelector('[data-testid="rule-set-option-badge-errors"]')).not.toBeNull();
    expect(row(A_NEW.id).querySelector('[data-testid="rule-set-option-badge-unpublished"]')).not.toBeNull();
    expect(row(A_OFF.id).querySelector('[data-testid="rule-set-option-badge-disabled"]')).not.toBeNull();
  });

  it('selecting and clearing an option calls onChange', async () => {
    renderPicker({ value: [A1.id] });
    await settle();
    fireEvent.click(screen.getByTestId(`rule-set-option-${PARTNER.id}`));
    expect(onChange).toHaveBeenLastCalledWith([A1.id, PARTNER.id]);
    fireEvent.click(screen.getByTestId(`rule-set-option-${A1.id}`));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it('empty selection shows the legacy-scan note', async () => {
    renderPicker({ value: [] });
    await settle();
    expect(screen.getByTestId('rule-set-picker-legacy-note')).toBeInTheDocument();
  });

  it('a saved id that is not attachable renders as unavailable with a remove button and blocks', async () => {
    renderPicker({ value: [A1.id, B1.id] });
    await settle();

    expect(screen.getByTestId(`rule-set-unavailable-${B1.id}`)).toBeInTheDocument();
    expect(screen.getByTestId('rule-set-picker-blocking')).toBeInTheDocument();
    expect(onBlockingChange).toHaveBeenLastCalledWith(true);
    fireEvent.click(screen.getByTestId(`rule-set-unavailable-remove-${B1.id}`));
    expect(onChange).toHaveBeenLastCalledWith([A1.id]);
  });

  it('a list fetch failure is not deletion: ids untouched, nothing unavailable, retry offered', async () => {
    fetchWithAuth.mockResolvedValue(json(500, { error: 'boom' }));
    renderPicker({ value: [A1.id, B1.id] });
    await settle();

    expect(screen.getByTestId('rule-set-picker-load-error')).toBeInTheDocument();
    expect(screen.queryByTestId(`rule-set-unavailable-${B1.id}`)).toBeNull();
    expect(screen.queryByTestId(`rule-set-unavailable-${A1.id}`)).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
    expect(onBlockingChange).not.toHaveBeenCalledWith(true);

    fetchWithAuth.mockResolvedValue(json(200, { data: ALL }));
    fireEvent.click(screen.getByTestId('rule-set-picker-retry'));
    await settle();
    expect(screen.queryByTestId('rule-set-picker-load-error')).toBeNull();
    expect(screen.getByTestId(`rule-set-unavailable-${B1.id}`)).toBeInTheDocument();
  });

  it(`at ${YARA_MAX_RULE_SETS_PER_POLICY} selected, unselected options are disabled`, async () => {
    const many = Array.from({ length: YARA_MAX_RULE_SETS_PER_POLICY }, (_, i) =>
      set({ id: `cccccccc-0000-4000-8000-${String(i).padStart(12, '0')}`, orgId: ORG_A, name: `S${i}` }),
    );
    fetchWithAuth.mockResolvedValue(json(200, { data: [...many, A1] }));
    renderPicker({ value: many.map((s) => s.id) });
    await settle();

    expect((screen.getByTestId(`rule-set-option-${A1.id}`) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByTestId(`rule-set-option-${many[0].id}`) as HTMLInputElement).disabled).toBe(false);
    expect(screen.getByTestId('rule-set-picker-cap')).toBeInTheDocument();
  });

  it('preselects the built-in pack only when asked and when it is in the list', async () => {
    renderPicker({ value: [], preselectBuiltin: true });
    await settle();
    expect(onChange).toHaveBeenCalledWith([YARA_BUILTIN_RULE_SET_ID]);

    onChange.mockClear();
    fetchWithAuth.mockResolvedValue(json(200, { data: [A1] }));
    renderPicker({ value: [], preselectBuiltin: true });
    await settle();
    expect(onChange).not.toHaveBeenCalled();

    onChange.mockClear();
    fetchWithAuth.mockResolvedValue(json(200, { data: ALL }));
    renderPicker({ value: [], preselectBuiltin: false });
    await settle();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('highlights the ids a gate error named', async () => {
    renderPicker({ value: [A1.id, B1.id], highlightIds: [B1.id.toUpperCase(), A1.id] });
    await settle();
    expect(screen.getByTestId(`rule-set-unavailable-${B1.id}`).getAttribute('data-highlighted')).toBe('true');
    expect(screen.getByTestId(`rule-set-option-row-${A1.id}`).getAttribute('data-highlighted')).toBe('true');
    expect(screen.getByTestId(`rule-set-option-row-${PARTNER.id}`).getAttribute('data-highlighted')).toBe('false');
  });
});
