// MonitorEditor.policyHash.test.tsx — real runAction; mock only toast/navigation.
import { describe, expect, it, vi } from 'vitest';
import { attachAfterCreate, editorHashForTab, tabFromHash } from './MonitorEditor';
import { showToast } from '../shared/Toast';
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
const POLICY = '10000000-0000-4000-8000-000000000009';
const MONITOR = '20000000-0000-4000-8000-000000000001';

describe('policy hash preselection', () => {
  it('attaches using a valid UUID and returns the policy URL', async () => {
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => new Response('{}', { status: 200 }));
    expect(await attachAfterCreate(MONITOR, `#policy=${POLICY}`, fetcher)).toBe(`/configuration-policies/${POLICY}#monitors`);
    expect(fetcher).toHaveBeenCalledWith(`/monitor-definitions/${MONITOR}/attachments`, {
      method: 'POST', body: JSON.stringify({ configPolicyId: POLICY }),
    });
  });
  it.each(['', '#activity', '#policy=../x'])('does not attach for absent/invalid policy in %s', async (hash) => {
    const fetcher = vi.fn();
    expect(await attachAfterCreate(MONITOR, hash, fetcher)).toBe(`/alerts/monitors/${MONITOR}`);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('preserves policy when switching tabs and reads legacy bare tab hashes', async () => {
    const hash = editorHashForTab(`#policy=${POLICY}`, 'activity');
    expect(new URLSearchParams(hash.slice(1)).get('policy')).toBe(POLICY);
    expect(tabFromHash(hash)).toBe('activity');
    expect(tabFromHash('#activity')).toBe('activity');
    expect(tabFromHash('settings')).toBe('settings');
    expect(tabFromHash(`#policy=${POLICY}`)).toBe('settings');
    const settingsHash = editorHashForTab(hash, 'settings');
    const fetcher = vi.fn(async () => new Response('{}', { status: 200 }));
    expect(await attachAfterCreate(MONITOR, settingsHash, fetcher)).toBe(`/configuration-policies/${POLICY}#monitors`);
  });
  it('surfaces failed attachments through runAction without returning a success URL', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ error: 'Denied' }), { status: 403 }));
    await expect(attachAfterCreate(MONITOR, `#policy=${POLICY}`, fetcher)).rejects.toMatchObject({ status: 403 });
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
  });
});
