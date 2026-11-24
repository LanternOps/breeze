import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));

import StartFrom, { eligibleParentsUrl } from './ConfigPolicyCreatePage';
import type { DraftParent } from './page/usePolicyDraft';
import { fetchWithAuth } from '../../stores/auth';
import { i18n } from '@/lib/i18n';

const fetchMock = vi.mocked(fetchWithAuth);
const PARENT = '20000000-0000-4000-8000-0000000000bb';
const json = (payload: unknown): Response =>
  ({ ok: true, status: 200, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

function Harness({ url, onChange }: { url: string | null; onChange: (p: DraftParent | null) => void }) {
  const [parent, setParent] = useState<DraftParent | null>(null);
  return (
    <StartFrom
      eligibleUrl={url}
      parent={parent}
      onChange={(next) => {
        setParent(next);
        onChange(next);
      }}
    />
  );
}

// "Start from" on the one-page create (spec "Create: inactive until activated",
// plan W03d C1): optional, Blank by default, or Based on a parent policy.
describe('Start from', () => {
  beforeEach(async () => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(json({ data: [{ id: PARENT, name: 'MSP baseline', ownerScope: 'partner' }] }));
    await i18n.changeLanguage('en');
  });

  it('defaults to Blank and reads nothing', () => {
    render(<Harness url="/configuration-policies/eligible-parents?ownerScope=partner" onChange={vi.fn()} />);
    expect(screen.getByTestId('config-policy-start-blank')).toBeChecked();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('Based on a parent lists the eligible parents for the owner and reports the choice by id and name', async () => {
    const onChange = vi.fn();
    render(<Harness url="/configuration-policies/eligible-parents?ownerScope=partner" onChange={onChange} />);
    fireEvent.click(screen.getByTestId('config-policy-start-parent'));
    fireEvent.change(await screen.findByTestId('policy-link-selector'), { target: { value: PARENT } });
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith({ id: PARENT, name: 'MSP baseline' }));
    expect(fetchMock).toHaveBeenCalledWith('/configuration-policies/eligible-parents?ownerScope=partner');
  });

  it('back to Blank clears the parent', async () => {
    const onChange = vi.fn();
    render(<Harness url="/configuration-policies/eligible-parents?ownerScope=partner" onChange={onChange} />);
    fireEvent.click(screen.getByTestId('config-policy-start-parent'));
    fireEvent.change(await screen.findByTestId('policy-link-selector'), { target: { value: PARENT } });
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith({ id: PARENT, name: 'MSP baseline' }));
    fireEvent.click(screen.getByTestId('config-policy-start-blank'));
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it('an organization-managed draft with no organization yet asks for one first', () => {
    render(<Harness url={null} onChange={vi.fn()} />);
    fireEvent.click(screen.getByTestId('config-policy-start-parent'));
    expect(screen.getByTestId('config-policy-start-parent-needs-org')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('eligibleParentsUrl', () => {
  it('follows the owner, and is null for an organization not chosen yet', () => {
    expect(eligibleParentsUrl({ kind: 'msp' })).toBe('/configuration-policies/eligible-parents?ownerScope=partner');
    expect(eligibleParentsUrl({ kind: 'org', orgId: 'org-a' })).toBe(
      '/configuration-policies/eligible-parents?ownerScope=organization&orgId=org-a',
    );
    expect(eligibleParentsUrl({ kind: 'org', orgId: null })).toBeNull();
  });
});
