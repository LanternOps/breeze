import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { AiAssignmentRowDto, AiModelsSnapshotDto, AiOfferingDto, AiSurface, AiSurfaceDefaultsDto } from '@breeze/shared';
import { jsonRes, SNAPSHOT } from './testFixtures';
import { offeringRow } from './offeringFixtures';

const fetchWithAuth = vi.fn();
vi.mock('../../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
const showToast = vi.fn();
vi.mock('../../shared/Toast', () => ({ showToast: (...a: unknown[]) => showToast(...a) }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

import FeatureDefaultsCard from './FeatureDefaultsCard';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const A2 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const K = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const UPDATED = '2026-10-01T00:00:00.000Z';
const LATER = '2026-10-03T00:00:00.000Z';

const off = (id: string, over: Partial<AiOfferingDto> = {}) =>
  offeringRow({ id, enabled: true, displayName: `Model ${id.slice(0, 1)}`, ...over });

function assignment(surface: AiSurface, defaultOfferingId: string, updatedAt = UPDATED): AiAssignmentRowDto {
  return { surface, role: 'default', defaultOfferingId, permittedOfferingIds: null, allowUserChoice: true, options: null, fallbackOfferingIds: null, fallbackMayCrossFunding: null, updatedAt };
}

function defaultsFor(surface: AiSurface, defaultOfferingId: string, over: Partial<AiSurfaceDefaultsDto> & { updatedAt?: string } = {}): AiSurfaceDefaultsDto {
  const { updatedAt, ...rest } = over;
  return { surface, role: 'default', requiresTools: surface === 'chat', partner: assignment(surface, defaultOfferingId, updatedAt), orgOverrideCount: surface === 'helper' ? 2 : 0, ...rest };
}

function snapWithDefaults(over: { offerings?: AiOfferingDto[]; helperDefault?: string; chatUpdatedAt?: string; extra?: AiSurfaceDefaultsDto[]; chatFallbacks?: string[]; chatCrossFunding?: boolean } = {}): AiModelsSnapshotDto {
  const chat = defaultsFor('chat', A, { updatedAt: over.chatUpdatedAt });
  if (over.chatFallbacks) chat.partner = { ...chat.partner!, fallbackOfferingIds: over.chatFallbacks, fallbackMayCrossFunding: over.chatCrossFunding ?? false };
  const roleEntry = (role: string): AiSurfaceDefaultsDto => ({ surface: 'ai_agents', role, requiresTools: true, partner: null, orgOverrideCount: 0 });
  return {
    ...SNAPSHOT,
    offerings: over.offerings ?? [off(A), off(B), off(A2), off(K, { funding: 'partner_key', displayName: 'Own key K' })],
    defaults: [
      chat,
      defaultsFor('helper', over.helperDefault ?? A),
      defaultsFor('ai_agents', A),
      roleEntry('triage'), roleEntry('analysis'), roleEntry('remediation'),
      ...(over.extra ?? []),
    ],
  };
}

beforeEach(() => { fetchWithAuth.mockReset(); showToast.mockReset(); });

const optionValues = (testId: string) => [...(screen.getByTestId(testId) as HTMLSelectElement).options].map((o) => o.value);

describe('FeatureDefaultsCard', () => {
  it('PUTs only dirty rows with expectedUpdatedAt', async () => {
    fetchWithAuth.mockResolvedValueOnce(jsonRes({ assignments: [{ surface: 'chat', role: 'default', updatedAt: 'x' }] }));
    render(<FeatureDefaultsCard snapshot={snapWithDefaults()} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByTestId('ai-defaults-default-chat'), { target: { value: B } });
    expect(screen.getByTestId('ai-defaults-dirty')).toBeTruthy();
    fireEvent.click(screen.getByTestId('ai-defaults-save'));
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalled());
    expect(fetchWithAuth.mock.calls[0][0]).toBe('/ai/models/assignments');
    expect(fetchWithAuth.mock.calls[0][1].method).toBe('PUT');
    expect(JSON.parse(fetchWithAuth.mock.calls[0][1].body)).toEqual({ assignments: [{
      surface: 'chat', role: 'default', defaultOfferingId: B, permittedOfferingIds: null, allowUserChoice: true, options: null,
      fallbackOfferingIds: [], fallbackMayCrossFunding: false, expectedUpdatedAt: UPDATED,
    }] });
  });

  it('sends expectedUpdatedAt null for a surface with no partner row yet', async () => {
    fetchWithAuth.mockResolvedValueOnce(jsonRes({ assignments: [] }));
    const s = snapWithDefaults();
    s.defaults[1] = { ...s.defaults[1], partner: null };
    render(<FeatureDefaultsCard snapshot={s} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByTestId('ai-defaults-default-helper'), { target: { value: B } });
    fireEvent.click(screen.getByTestId('ai-defaults-save'));
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalled());
    expect(JSON.parse(fetchWithAuth.mock.calls[0][1].body).assignments[0]).toMatchObject({ surface: 'helper', defaultOfferingId: B, expectedUpdatedAt: null });
  });

  it('refreshes the snapshot and clears the footer after a save', async () => {
    fetchWithAuth.mockResolvedValueOnce(jsonRes({ assignments: [] }));
    const onSaved = vi.fn();
    render(<FeatureDefaultsCard snapshot={snapWithDefaults()} onSaved={onSaved} />);
    fireEvent.click(screen.getByTestId('ai-defaults-user-choice-chat'));
    fireEvent.click(screen.getByTestId('ai-defaults-save'));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByTestId('ai-defaults-dirty')).toBeNull());
  });

  it('a tool surface lists only tool-capable models', () => {
    render(<FeatureDefaultsCard snapshot={snapWithDefaults({ offerings: [off(A, { supportsTools: true }), off(C, { supportsTools: false })] })} onSaved={vi.fn()} />);
    const values = optionValues('ai-defaults-default-chat');
    expect(values).toContain(A);
    expect(values).not.toContain(C);
    expect(optionValues('ai-defaults-default-helper')).toContain(C);
    expect(screen.getByTestId('ai-defaults-row-chat').textContent).toMatch(/needs tools/i);
  });

  it('narrowing the permitted set drops a default outside it from the select', () => {
    render(<FeatureDefaultsCard snapshot={snapWithDefaults()} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByTestId('ai-defaults-permitted-mode-chat'), { target: { value: 'list' } });
    fireEvent.click(screen.getByTestId(`ai-defaults-permitted-chat-${B}`));
    expect(optionValues('ai-defaults-default-chat')).toEqual([B]);
    expect((screen.getByTestId('ai-defaults-default-chat') as HTMLSelectElement).value).toBe(B);
  });

  it('refuses to save an "Only these" set with nothing ticked', async () => {
    render(<FeatureDefaultsCard snapshot={snapWithDefaults()} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByTestId('ai-defaults-permitted-mode-chat'), { target: { value: 'list' } });
    fireEvent.click(screen.getByTestId('ai-defaults-save'));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
    expect(fetchWithAuth).not.toHaveBeenCalled();
  });

  it('Discard restores the snapshot and hides the footer', () => {
    render(<FeatureDefaultsCard snapshot={snapWithDefaults()} onSaved={vi.fn()} />);
    fireEvent.click(screen.getByTestId('ai-defaults-user-choice-chat'));
    expect(screen.getByTestId('ai-defaults-dirty')).toBeTruthy();
    fireEvent.click(screen.getByTestId('ai-defaults-discard'));
    expect(screen.queryByTestId('ai-defaults-dirty')).toBeNull();
    expect((screen.getByTestId('ai-defaults-user-choice-chat') as HTMLInputElement).checked).toBe(true);
  });

  it('marks the failing row from a 422 details.surface', async () => {
    fetchWithAuth.mockResolvedValueOnce(jsonRes({ error: 'needs tools', code: 'tools_unsupported', details: { surface: 'chat', field: 'defaultOfferingId' } }, 422));
    render(<FeatureDefaultsCard snapshot={snapWithDefaults()} onSaved={vi.fn()} />);
    fireEvent.click(screen.getByTestId('ai-defaults-user-choice-chat'));
    fireEvent.click(screen.getByTestId('ai-defaults-save'));
    await waitFor(() => expect(screen.getByTestId('ai-defaults-row-chat').getAttribute('aria-invalid')).toBe('true'));
    expect(screen.getByTestId('ai-defaults-row-helper').getAttribute('aria-invalid')).not.toBe('true');
  });

  it('a 409 stale_write reloads the snapshot', async () => {
    fetchWithAuth.mockResolvedValueOnce(jsonRes({ error: 'stale', code: 'stale_write' }, 409));
    const onSaved = vi.fn();
    render(<FeatureDefaultsCard snapshot={snapWithDefaults()} onSaved={onSaved} />);
    fireEvent.click(screen.getByTestId('ai-defaults-user-choice-chat'));
    fireEvent.click(screen.getByTestId('ai-defaults-save'));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it('a snapshot reload (another card autosaved) keeps dirty rows and refreshes clean ones', () => {
    const { rerender } = render(<FeatureDefaultsCard snapshot={snapWithDefaults()} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByTestId('ai-defaults-default-chat'), { target: { value: B } });
    rerender(<FeatureDefaultsCard snapshot={snapWithDefaults({ helperDefault: A2 })} onSaved={vi.fn()} />);
    expect((screen.getByTestId('ai-defaults-default-chat') as HTMLSelectElement).value).toBe(B);
    expect((screen.getByTestId('ai-defaults-default-helper') as HTMLSelectElement).value).toBe(A2);
    expect(screen.queryByTestId('ai-defaults-conflict-chat')).toBeNull();
  });

  it('flags a dirty row whose stored row changed elsewhere', () => {
    const { rerender } = render(<FeatureDefaultsCard snapshot={snapWithDefaults()} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByTestId('ai-defaults-default-chat'), { target: { value: B } });
    rerender(<FeatureDefaultsCard snapshot={snapWithDefaults({ chatUpdatedAt: LATER })} onSaved={vi.fn()} />);
    expect(screen.getByTestId('ai-defaults-conflict-chat')).toBeTruthy();
    expect((screen.getByTestId('ai-defaults-default-chat') as HTMLSelectElement).value).toBe(B);
  });

  it('edits thinking display and speed per surface, limited to the default model', () => {
    render(<FeatureDefaultsCard snapshot={snapWithDefaults()} onSaved={vi.fn()} />);
    expect(screen.getByTestId('ai-defaults-display-chat')).toBeTruthy();
    expect(optionValues('ai-defaults-speed-chat')).not.toContain('fast');
  });

  it('offers the effort and speed the default supports and sends them as options', async () => {
    fetchWithAuth.mockResolvedValueOnce(jsonRes({ assignments: [] }));
    const rich = off(A, {
      fastRates: { inputCentsPerM: 1, outputCentsPerM: 1, cacheReadCentsPerM: 1, cacheWriteCentsPerM: 1 },
      optionSupport: { effort: ['low', 'high'], thinkingDisplay: ['summarized'], speed: ['standard', 'fast'], inferenceGeo: [] },
      allowedOptions: { effort: ['high'] },
    });
    render(<FeatureDefaultsCard snapshot={snapWithDefaults({ offerings: [rich, off(B)] })} onSaved={vi.fn()} />);
    expect(optionValues('ai-defaults-effort-chat')).toEqual(['', 'high']);
    expect(optionValues('ai-defaults-speed-chat')).toContain('fast');
    fireEvent.change(screen.getByTestId('ai-defaults-effort-chat'), { target: { value: 'high' } });
    fireEvent.change(screen.getByTestId('ai-defaults-speed-chat'), { target: { value: 'fast' } });
    fireEvent.click(screen.getByTestId('ai-defaults-save'));
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalled());
    expect(JSON.parse(fetchWithAuth.mock.calls[0][1].body).assignments[0].options).toEqual({ effort: 'high', speed: 'fast' });
  });

  it('shows the approvals note on script_reviewer and translates APPROVALS_DECIDE_REQUIRED', async () => {
    fetchWithAuth.mockResolvedValueOnce(jsonRes({ error: 'nope', code: 'APPROVALS_DECIDE_REQUIRED' }, 403));
    const s = snapWithDefaults({ extra: [defaultsFor('script_reviewer', A)] });
    render(<FeatureDefaultsCard snapshot={s} onSaved={vi.fn()} />);
    expect(screen.getByTestId('ai-defaults-row-script_reviewer').textContent).toMatch(/approvals permission/i);
    fireEvent.click(screen.getByTestId('ai-defaults-user-choice-script_reviewer'));
    fireEvent.click(screen.getByTestId('ai-defaults-save'));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: expect.stringMatching(/approvals/i) })));
  });

  it('links to org overrides only when there are some', () => {
    render(<FeatureDefaultsCard snapshot={snapWithDefaults()} onSaved={vi.fn()} />);
    expect(screen.queryByTestId('ai-defaults-org-overrides-chat')).toBeNull();
    expect(screen.getByTestId('ai-defaults-org-overrides-helper')).toBeTruthy();
  });

  describe('stored ids that are no longer available', () => {
    const staleSnap = (chat: Partial<AiAssignmentRowDto>, offerings = [off(A), off(B, { enabled: false, displayName: 'Model B' })]): AiModelsSnapshotDto => ({
      ...SNAPSHOT,
      offerings,
      defaults: [{ surface: 'chat', role: 'default', requiresTools: true, partner: { ...assignment('chat', A), ...chat }, orgOverrideCount: 0 }],
    });

    it('renders a stored-but-disabled permitted id as a checked, labelled "unavailable" entry that can be unticked', async () => {
      fetchWithAuth.mockResolvedValueOnce(jsonRes({ assignments: [] }));
      render(<FeatureDefaultsCard snapshot={staleSnap({ permittedOfferingIds: [A, B] })} onSaved={vi.fn()} />);
      const box = screen.getByTestId(`ai-defaults-permitted-chat-${B}`) as HTMLInputElement;
      expect(box.checked).toBe(true);
      expect(box.closest('label')?.textContent).toMatch(/Model B.*unavailable/i);
      fireEvent.click(box);
      expect((screen.getByTestId(`ai-defaults-permitted-chat-${B}`) as HTMLInputElement).checked).toBe(false);
      fireEvent.click(screen.getByTestId('ai-defaults-save'));
      await waitFor(() => expect(fetchWithAuth).toHaveBeenCalled());
      expect(JSON.parse(fetchWithAuth.mock.calls[0][1].body).assignments[0].permittedOfferingIds).toEqual([A]);
    });

    it('renders a stored permitted id whose offering is gone with a generic unavailable label', () => {
      render(<FeatureDefaultsCard snapshot={staleSnap({ permittedOfferingIds: [A, C] })} onSaved={vi.fn()} />);
      const box = screen.getByTestId(`ai-defaults-permitted-chat-${C}`) as HTMLInputElement;
      expect(box.checked).toBe(true);
      expect(box.closest('label')?.textContent).toMatch(/unavailable/i);
    });

    it('shows a stored default that is no longer available as such, not as another model', () => {
      render(<FeatureDefaultsCard snapshot={staleSnap({ defaultOfferingId: B })} onSaved={vi.fn()} />);
      const select = screen.getByTestId('ai-defaults-default-chat') as HTMLSelectElement;
      expect(select.value).toBe(B);
      expect(select.selectedOptions[0]?.textContent).toMatch(/Model B.*unavailable/i);
    });
  });

  it('renders the three ai_agents escalation sub-rows', () => {
    render(<FeatureDefaultsCard snapshot={snapWithDefaults()} onSaved={vi.fn()} />);
    for (const role of ['triage', 'analysis', 'remediation']) expect(screen.getByTestId(`ai-defaults-row-ai_agents-${role}`)).toBeTruthy();
  });

  it('a role sub-row starts on "Same as AI agents default" and is not dirty', () => {
    render(<FeatureDefaultsCard snapshot={snapWithDefaults()} onSaved={vi.fn()} />);
    const sel = screen.getByTestId('ai-defaults-default-ai_agents-triage') as HTMLSelectElement;
    expect(sel.value).toBe('');
    expect(sel.options[0].textContent).toBe('Same as AI agents default');
    expect(screen.queryByTestId('ai-defaults-fallbacks-ai_agents-triage')).toBeNull();
    expect(screen.queryByTestId('ai-defaults-dirty')).toBeNull();
  });

  it('choosing a triage model saves a triage row; the fallback list and crossing switch ride along', async () => {
    fetchWithAuth.mockResolvedValueOnce(jsonRes({ assignments: [] }));
    render(<FeatureDefaultsCard snapshot={snapWithDefaults()} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByTestId('ai-defaults-default-ai_agents-triage'), { target: { value: B } });
    fireEvent.change(screen.getByTestId('ai-defaults-fallback-add-ai_agents-triage'), { target: { value: A } });
    fireEvent.click(screen.getByTestId('ai-defaults-save'));
    await waitFor(() => expect(JSON.parse(fetchWithAuth.mock.calls[0][1].body).assignments).toEqual([expect.objectContaining({
      surface: 'ai_agents', role: 'triage', defaultOfferingId: B, fallbackOfferingIds: [A], fallbackMayCrossFunding: false, expectedUpdatedAt: null,
    })]));
  });

  it('clearing a stored role row saves it as a clear (null default, no list)', async () => {
    fetchWithAuth.mockResolvedValueOnce(jsonRes({ assignments: [] }));
    const s = snapWithDefaults();
    const triage = s.defaults.find((d) => d.role === 'triage')!;
    triage.partner = { ...assignment('ai_agents', B), role: 'triage' };
    render(<FeatureDefaultsCard snapshot={s} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByTestId('ai-defaults-default-ai_agents-triage'), { target: { value: '' } });
    fireEvent.click(screen.getByTestId('ai-defaults-save'));
    await waitFor(() => expect(JSON.parse(fetchWithAuth.mock.calls[0][1].body).assignments).toEqual([expect.objectContaining({
      surface: 'ai_agents', role: 'triage', defaultOfferingId: null, permittedOfferingIds: null, options: null, fallbackOfferingIds: null, expectedUpdatedAt: UPDATED,
    })]));
  });

  it('switching cross-funding off drops the entries that cross', () => {
    render(<FeatureDefaultsCard snapshot={snapWithDefaults({ chatFallbacks: [B, K], chatCrossFunding: true })} onSaved={vi.fn()} />);
    expect(screen.getByTestId('ai-defaults-fallback-chat-1')).toBeTruthy();
    fireEvent.click(screen.getByTestId('ai-defaults-cross-funding-chat'));
    expect(screen.queryByTestId('ai-defaults-fallback-chat-1')).toBeNull();
    expect(screen.getByTestId('ai-defaults-fallback-chat-0').textContent).toContain('Model b');
  });

  it('a 422 crosses_funding highlights the role row named in details', async () => {
    fetchWithAuth.mockResolvedValueOnce(jsonRes({ error: 'x', code: 'crosses_funding', details: { surface: 'ai_agents', role: 'triage', field: 'fallbackOfferingIds' } }, 422));
    render(<FeatureDefaultsCard snapshot={snapWithDefaults()} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByTestId('ai-defaults-default-ai_agents-triage'), { target: { value: B } });
    fireEvent.click(screen.getByTestId('ai-defaults-save'));
    await waitFor(() => expect(screen.getByTestId('ai-defaults-row-ai_agents-triage').getAttribute('aria-invalid')).toBe('true'));
    expect(screen.getByTestId('ai-defaults-row-ai_agents').getAttribute('aria-invalid')).not.toBe('true');
  });
});
