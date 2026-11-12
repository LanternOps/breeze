import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { AiOfferingDto } from '@breeze/shared';
import { jsonRes, CONN } from './testFixtures';
import { NO_SURFACE_TURNS, OFF, offeringRow, toolProfileFor } from './offeringFixtures';

const fetchWithAuth = vi.fn();
vi.mock('../../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
const showToast = vi.fn();
vi.mock('../../shared/Toast', () => ({ showToast: (...a: unknown[]) => showToast(...a) }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

import OfferingDrawer from './OfferingDrawer';

const AT = '2026-10-01T00:00:00.000Z';
const body = () => JSON.parse(fetchWithAuth.mock.calls[0][1].body);

/** A gateway (BYO OpenAI-compatible) offering. */
function gateway(over: Partial<AiOfferingDto> = {}): AiOfferingDto {
  return offeringRow({
    id: OFF, connectionId: CONN, funding: 'partner_key', source: 'discovered', updatedAt: AT,
    verification: { state: 'verified', at: AT, harnessVersion: '1', summary: null, surfaces: NO_SURFACE_TURNS },
    contextWindow: { effective: null, source: 'unknown', override: null, discovered: null, observed: null },
    toolProfile: toolProfileFor({ windowOverrideSupported: true }),
    ...over,
  });
}

const open = (o: AiOfferingDto) =>
  render(<OfferingDrawer offering={o} offerings={[]} onClose={vi.fn()} onSaved={vi.fn()} />);

beforeEach(() => { fetchWithAuth.mockReset(); showToast.mockReset(); });

describe('OfferingDrawer — Tools and context (#11398)', () => {
  it('capacity unknown when no window facts: auto uses every tool', () => {
    open(gateway());
    expect(screen.getByTestId('ai-offering-context-facts').textContent).toMatch(/Capacity unknown/);
    expect(screen.getByTestId('ai-offering-tool-surface-chat').textContent).toMatch(/Full/);
  });

  it('auto shows the resolved profile per surface and the window source, with an observed window\'s age', () => {
    const at = new Date(Date.now() - 12 * 60_000).toISOString();
    open(gateway({
      contextWindow: { effective: 8192, source: 'observed', override: null, discovered: 131072, observed: { value: 8192, at, fresh: true } },
      toolProfile: toolProfileFor({ windowOverrideSupported: true }, {
        chat: { resolved: 'minimal', reason: 'auto_window', autoProfile: 'minimal' },
        script_builder: { resolved: 'minimal', reason: 'auto_window', autoProfile: 'minimal', missingRequired: ['execute_script_on_device'] },
      }),
    }));
    const facts = screen.getByTestId('ai-offering-context-facts').textContent!;
    expect(facts).toMatch(/8,192/);
    expect(facts).toMatch(/12 min/);
    expect(screen.getByTestId('ai-offering-tool-surface-chat').textContent).toMatch(/Minimal/);
    expect(screen.getByTestId('ai-offering-tool-surface-script_builder').textContent).toMatch(/execute_script_on_device/);
  });

  it('a stale observation is shown with its age but said not to limit anything (behaviour unchanged)', () => {
    const at = new Date(Date.now() - 3 * 3_600_000).toISOString();
    open(gateway({ contextWindow: { effective: 131072, source: 'discovered', override: null, discovered: 131072, observed: { value: 8192, at, fresh: false } } }));
    const stale = screen.getByTestId('ai-offering-context-observed-stale').textContent!;
    expect(stale).toMatch(/8,192/);
    expect(stale).toMatch(/3 h/);
  });

  it('custom reveals domains and tools; saving sends toolProfile and toolAllowlist together', async () => {
    fetchWithAuth.mockResolvedValueOnce(jsonRes({ id: OFF, updatedAt: AT }));
    open(gateway());
    expect(screen.queryByTestId('ai-offering-tool-list')).toBeNull();
    fireEvent.change(screen.getByTestId('ai-offering-tool-profile'), { target: { value: 'custom' } });
    fireEvent.click(screen.getByTestId('ai-offering-tool-domain-devices'));
    fireEvent.change(screen.getByTestId('ai-offering-tool-list'), { target: { value: 'search_logs, query_audit_log\nsearch_logs' } });
    fireEvent.click(screen.getByTestId('ai-offering-save'));
    await waitFor(() => expect(body()).toEqual({
      expectedUpdatedAt: AT, toolProfile: 'custom', toolAllowlist: { domains: ['devices'], tools: ['query_audit_log', 'search_logs'] },
    }));
  });

  it('switching custom → standard sends toolProfile and toolAllowlist: null together', async () => {
    fetchWithAuth.mockResolvedValueOnce(jsonRes({ id: OFF, updatedAt: AT }));
    open(gateway({ toolProfile: toolProfileFor({ profile: 'custom', allowlist: { domains: ['devices'], tools: [] }, windowOverrideSupported: true }) }));
    expect((screen.getByTestId('ai-offering-tool-domain-devices') as HTMLInputElement).checked).toBe(true);
    fireEvent.change(screen.getByTestId('ai-offering-tool-profile'), { target: { value: 'standard' } });
    fireEvent.click(screen.getByTestId('ai-offering-save'));
    await waitFor(() => expect(body()).toEqual({ expectedUpdatedAt: AT, toolProfile: 'standard', toolAllowlist: null }));
  });

  it('an empty custom list cannot be saved (the API would refuse it)', () => {
    open(gateway());
    fireEvent.change(screen.getByTestId('ai-offering-tool-profile'), { target: { value: 'custom' } });
    fireEvent.click(screen.getByTestId('ai-offering-save'));
    expect(fetchWithAuth).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
  });

  it('sets and clears the context window override (gateway only)', async () => {
    fetchWithAuth.mockResolvedValue(jsonRes({ id: OFF, updatedAt: AT }));
    open(gateway());
    fireEvent.change(screen.getByTestId('ai-offering-context-window'), { target: { value: '32768' } });
    fireEvent.click(screen.getByTestId('ai-offering-save'));
    await waitFor(() => expect(body()).toEqual({ expectedUpdatedAt: AT, contextWindowOverride: 32768 }));
  });

  it('clearing a stored override sends null', async () => {
    fetchWithAuth.mockResolvedValueOnce(jsonRes({ id: OFF, updatedAt: AT }));
    open(gateway({ contextWindow: { effective: 16384, source: 'override', override: 16384, discovered: 131072, observed: null } }));
    fireEvent.change(screen.getByTestId('ai-offering-context-window'), { target: { value: '' } });
    fireEvent.click(screen.getByTestId('ai-offering-save'));
    await waitFor(() => expect(body()).toEqual({ expectedUpdatedAt: AT, contextWindowOverride: null }));
  });

  it('refuses an out-of-range override client-side', () => {
    open(gateway());
    fireEvent.change(screen.getByTestId('ai-offering-context-window'), { target: { value: '512' } });
    fireEvent.click(screen.getByTestId('ai-offering-save'));
    expect(fetchWithAuth).not.toHaveBeenCalled();
  });

  it('a non-gateway model offers the profile but no override field', () => {
    open(offeringRow({ id: OFF, toolProfile: toolProfileFor({ windowOverrideSupported: false }) }));
    expect(screen.getByTestId('ai-offering-tool-profile')).toBeTruthy();
    expect(screen.queryByTestId('ai-offering-context-window')).toBeNull();
  });

  it('dropped custom names render a warning', () => {
    open(gateway({ toolProfile: toolProfileFor({ profile: 'custom', allowlist: { domains: [], tools: ['retired_tool'] }, droppedCustomNames: ['retired_tool'], windowOverrideSupported: true }) }));
    expect(screen.getByTestId('ai-offering-dropped-tools').textContent).toMatch(/retired_tool/);
  });

  it('suggests a smaller profile when an explicit one is larger than auto would pick at the window', () => {
    open(gateway({
      contextWindow: { effective: 32768, source: 'discovered', override: null, discovered: 32768, observed: null },
      toolProfile: toolProfileFor({ profile: 'full', windowOverrideSupported: true }, { chat: { resolved: 'full', reason: 'explicit', autoProfile: 'standard' } }),
    }));
    expect(screen.getByTestId('ai-offering-tool-fit-chat').textContent).toMatch(/Standard/);
  });

  it('per-surface readiness renders passed / failed / inconclusive / stale / absent copy', () => {
    open(gateway({
      verification: {
        state: 'verified', at: AT, harnessVersion: '1', summary: null,
        surfaces: {
          chat: { state: 'passed', at: AT, profile: 'minimal', promptTokens: 3100, cachedTokens: 0, summary: null },
          helper: { state: 'failed', at: AT, profile: 'full', promptTokens: 8000, cachedTokens: 0, summary: 'answered without calling a tool' },
          script_builder: { state: 'inconclusive', at: AT, profile: 'full', promptTokens: null, cachedTokens: null, summary: 'endpoint timed out' },
          ai_agents: { state: 'stale', at: AT, profile: 'full', promptTokens: null, cachedTokens: null, summary: null },
          office_chat: NO_SURFACE_TURNS.office_chat,
        },
      },
    }));
    expect(screen.getByTestId('ai-offering-readiness-chat').textContent).toMatch(/passed/i);
    expect(screen.getByTestId('ai-offering-readiness-chat').textContent).toMatch(/3,100/);
    expect(screen.getByTestId('ai-offering-readiness-helper').textContent).toMatch(/answered without calling a tool/);
    expect(screen.getByTestId('ai-offering-readiness-script_builder').textContent).toMatch(/endpoint failed, not the model/i);
    expect(screen.getByTestId('ai-offering-readiness-ai_agents').textContent).toMatch(/Re-verify/);
    expect(screen.getByTestId('ai-offering-readiness-office_chat').textContent).toMatch(/not checked/i);
  });

  it('absent readiness on a verified model says the basic check passed and how to run a round trip', () => {
    open(gateway());
    expect(screen.getByTestId('ai-offering-readiness-chat').textContent).toMatch(/Verified \(basic\)\. Re-verify to check a real tool round trip on Chat\./);
  });

  it('states the verify cost: real traffic, billed by the partner\'s provider, ≈128k tokens worst case', () => {
    open(gateway());
    const cost = screen.getByTestId('ai-offering-verify-cost').textContent!;
    expect(cost).toMatch(/billed by your provider/);
    expect(cost).toMatch(/128,000/);
    expect(cost).toMatch(/500,000/);
  });

  it('rule-3 copy: set by the partner; organizations cannot override it', () => {
    open(gateway());
    expect(screen.getByTestId('ai-offering-tools-section').textContent)
      .toMatch(/Set by the partner on the model\. Organizations choose models; they cannot override this\./);
  });

  it('a too-small refusal names the feature; editing the draft clears the inline refusal', async () => {
    fetchWithAuth.mockResolvedValueOnce(jsonRes({
      error: 'This change would leave a feature using this model unable to run.', code: 'tool_profile_underpowered',
      details: { field: 'contextWindowOverride', surfaces: [{ surface: 'chat', missing: [], tooSmall: true }] },
    }, 422));
    open(gateway());
    fireEvent.change(screen.getByTestId('ai-offering-context-window'), { target: { value: '4096' } });
    fireEvent.click(screen.getByTestId('ai-offering-save'));
    await waitFor(() => expect(screen.getByTestId('ai-offering-tools-error').textContent).toMatch(/Chat: no tool profile fits this context window/));
    fireEvent.change(screen.getByTestId('ai-offering-context-window'), { target: { value: '40960' } });
    expect(screen.queryByTestId('ai-offering-tools-error')).toBeNull();
  });

  it('AI agents: a missing troubleshooting floor is worded as troubleshooting runs only', () => {
    open(gateway({ toolProfile: toolProfileFor({ profile: 'minimal', windowOverrideSupported: true }, {
      ai_agents: { resolved: 'minimal', reason: 'explicit', missingRequired: ['execute_command', 'run_script'] },
    }) }));
    const row = screen.getByTestId('ai-offering-tool-surface-ai_agents').textContent!;
    expect(row).toMatch(/Device troubleshooting runs refuse this model/);
    expect(row).toMatch(/Other agent runs are not affected/);
  });

  it('a tool_profile_underpowered refusal lists each feature and its missing tools inline', async () => {
    fetchWithAuth.mockResolvedValueOnce(jsonRes({
      error: 'This tool profile drops tools a feature using this model requires.', code: 'tool_profile_underpowered',
      details: { field: 'toolProfile', surfaces: [{ surface: 'script_builder', missing: ['execute_script_on_device'] }] },
    }, 422));
    open(gateway());
    fireEvent.change(screen.getByTestId('ai-offering-tool-profile'), { target: { value: 'minimal' } });
    fireEvent.click(screen.getByTestId('ai-offering-save'));
    await waitFor(() => expect(screen.getByTestId('ai-offering-tools-error').textContent).toMatch(/Script builder.*execute_script_on_device/));
  });
});
