import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { i18n } from '@/lib/i18n';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...args: unknown[]) => fetchWithAuth(...args) }));

import ConfigPolicyList, { type ConfigPolicy } from './ConfigPolicyList';

// Device counts in the policy list (#12467, plan W02c P4).

const jsonResponse = (payload: unknown, status = 200): Response =>
  ({ ok: status >= 200 && status < 300, status, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const id = (n: number) => `${n.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`;
const applied = {
  assignmentCount: 1,
  allOrganizations: false,
  targets: [{ assignmentId: 'a', level: 'organization', targetId: 'o', name: 'Acme', roleFilter: null, osFilter: null }],
  childPolicyCount: 0,
};
const policies = (count: number): ConfigPolicy[] =>
  Array.from({ length: count }, (_, i) => ({
    id: id(i),
    name: `Policy ${String(i).padStart(2, '0')}`,
    status: 'active',
    orgId: null,
    partnerId: 'p',
    appliesTo: applied,
  }));

const reachCalls = () => fetchWithAuth.mock.calls.filter((c) => String(c[0]).startsWith('/configuration-policies/reach'));
const askedIds = (call: unknown[]) => new URL(String(call[0]), 'http://x').searchParams.get('ids')!.split(',');

beforeEach(async () => {
  await i18n.changeLanguage('en');
  fetchWithAuth.mockReset();
  fetchWithAuth.mockImplementation(async (url: string) => {
    const ids = new URL(url, 'http://x').searchParams.get('ids')!.split(',');
    return jsonResponse({ data: Object.fromEntries(ids.map((pid, i) => [pid, { direct: i + 1, throughChildren: 0, organizations: 1, ...(i === 1 ? { partial: true } : {}) }])) });
  });
});

describe('ConfigPolicyList device counts', () => {
  it('the list asks for reach once per page of rows it shows', async () => {
    const user = userEvent.setup();
    const all = policies(12);
    const { rerender } = render(<ConfigPolicyList policies={all.slice(0, 10)} total={12} page={1} pageSize={10} />);
    await waitFor(() => expect(reachCalls()).toHaveLength(1));
    expect(askedIds(reachCalls()[0]!)).toHaveLength(10);
    const rows = screen.getAllByTestId('config-policy-row');
    await waitFor(() => expect(within(rows[0]!).getByTestId('config-policy-applies-to-reach')).toHaveTextContent('1 device'));
    expect(within(rows[1]!).getByTestId('config-policy-applies-to-reach')).toHaveTextContent('At least 2 devices');

    // A re-render of the same page asks again only when its rows change.
    rerender(<ConfigPolicyList policies={all.slice(0, 10)} total={12} page={1} pageSize={10} />);
    // The next page is the server's answer: the parent hands down its rows.
    await user.click(screen.getByTestId('config-policy-next-page'));
    rerender(<ConfigPolicyList policies={all.slice(10)} total={12} page={2} pageSize={10} />);
    await waitFor(() => expect(reachCalls()).toHaveLength(2));
    expect(askedIds(reachCalls()[1]!)).toEqual([id(10), id(11)]);
  });

  it('a reach failure leaves the counts out and the page usable', async () => {
    fetchWithAuth.mockResolvedValue(jsonResponse({ error: 'boom' }, 500));
    render(<ConfigPolicyList policies={policies(3)} pageSize={10} />);
    await waitFor(() => expect(reachCalls()).toHaveLength(1));
    expect(screen.getAllByTestId('config-policy-row')).toHaveLength(3);
    expect(screen.queryByTestId('config-policy-applies-to-reach')).toBeNull();
    expect(screen.getAllByTestId('config-policy-applies-to-cell')[0]).toHaveTextContent('Acme');
  });

  it('a later read that leaves a policy out, or fails, shows no old count for it', async () => {
    const two = policies(2);
    let answer: (ids: string[]) => Response = (ids) =>
      jsonResponse({ data: Object.fromEntries(ids.map((pid) => [pid, { direct: 5, throughChildren: 0, organizations: 1 }])) });
    fetchWithAuth.mockImplementation(async (url: string) => answer(new URL(url, 'http://x').searchParams.get('ids')!.split(',')));
    const { rerender } = render(<ConfigPolicyList policies={two} pageSize={10} />);
    await waitFor(() => expect(screen.getAllByTestId('config-policy-applies-to-reach')).toHaveLength(2));

    // The second policy is no longer readable.
    answer = (ids) => jsonResponse({ data: { [ids[0]!]: { direct: 6, throughChildren: 0, organizations: 1 } } });
    rerender(<ConfigPolicyList policies={[two[0]!]} pageSize={10} />);
    await waitFor(() => expect(screen.getByTestId('config-policy-applies-to-reach')).toHaveTextContent('6 devices'));
    rerender(<ConfigPolicyList policies={two} pageSize={10} />);
    await waitFor(() => expect(reachCalls()).toHaveLength(3));
    await waitFor(() => expect(screen.getAllByTestId('config-policy-applies-to-reach')).toHaveLength(1));

    // A failed read drops the page's counts rather than keeping old ones.
    answer = () => jsonResponse({ error: 'boom' }, 500);
    rerender(<ConfigPolicyList policies={[two[0]!]} pageSize={10} />);
    await waitFor(() => expect(reachCalls()).toHaveLength(4));
    await waitFor(() => expect(screen.queryByTestId('config-policy-applies-to-reach')).toBeNull());
  });

  it('asks nothing for an empty list', () => {
    render(<ConfigPolicyList policies={[]} pageSize={10} />);
    expect(reachCalls()).toHaveLength(0);
  });
});
