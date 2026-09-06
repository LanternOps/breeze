import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CustomFieldImportPreviewTable, {
  bulkSelectableValueRows,
  defaultValueImportSelection,
  isValueRowSelectable,
  type AnnotatedValueRow,
} from './CustomFieldImportPreviewTable';

const CANDIDATE_0_ID = 'dev-cand-0';

const matched: AnnotatedValueRow = {
  index: 0,
  outcome: 'matched',
  deviceId: 'dev-1',
  method: 'serial',
  organizationId: 'org-1',
  candidates: [],
  values: [{ target: { kind: 'customField', fieldKey: 'asset_owner' }, value: 'IT Team', outcome: 'applied' }],
};

const linkMatch: AnnotatedValueRow = {
  index: 1,
  outcome: 'link-match',
  deviceId: 'dev-2',
  method: 'link',
  organizationId: 'org-1',
  candidates: [],
  values: [{ target: { kind: 'warranty', field: 'warrantyEndDate' }, value: '2027-01-01', outcome: 'applied' }],
};

const ambiguous: AnnotatedValueRow = {
  index: 2,
  outcome: 'ambiguous',
  deviceId: null,
  method: null,
  organizationId: 'org-1',
  candidates: [
    {
      deviceId: CANDIDATE_0_ID,
      hostname: 'WKS-01',
      displayName: 'Workstation 1',
      serialNumber: 'SN-100',
      osType: 'windows',
      status: 'online',
      enrolledAt: '2025-01-01T00:00:00Z',
      lastSeenAt: '2026-09-01T00:00:00Z',
      siteId: 'site-1',
      method: 'hostname',
    },
    {
      deviceId: 'dev-cand-1',
      hostname: 'WKS-01-OLD',
      displayName: 'Workstation 1 (old)',
      serialNumber: 'SN-101',
      osType: 'windows',
      status: 'offline',
      enrolledAt: '2024-01-01T00:00:00Z',
      lastSeenAt: '2025-01-01T00:00:00Z',
      siteId: 'site-1',
      method: 'hostname',
    },
  ],
  values: [{ target: { kind: 'customField', fieldKey: 'asset_owner' }, value: 'IT Team', outcome: 'applied' }],
};

const notFound: AnnotatedValueRow = {
  index: 3,
  outcome: 'not-found',
  deviceId: null,
  method: null,
  organizationId: null,
  candidates: [],
  values: [],
};

const partial: AnnotatedValueRow = {
  index: 4,
  outcome: 'matched',
  deviceId: 'dev-5',
  method: 'serial',
  organizationId: 'org-1',
  candidates: [],
  values: [
    { target: { kind: 'customField', fieldKey: 'unknown_field' }, value: 'x', outcome: 'no-definition' },
    { target: { kind: 'customField', fieldKey: 'ticket_count' }, value: 'abc', outcome: 'type-error', reason: 'invalid_type' },
  ],
};

const reservedKeyRow: AnnotatedValueRow = {
  index: 5,
  outcome: 'matched',
  deviceId: 'dev-6',
  method: 'serial',
  organizationId: 'org-1',
  candidates: [],
  values: [
    {
      target: { kind: 'customField', fieldKey: 'asset_tag' },
      value: 'AT-1',
      outcome: 'applied',
      warning:
        "This key feeds the device's partner integration identity (stableIdentifiers), which is republished to every connected integration",
    },
  ],
};

function renderTable(
  rows: AnnotatedValueRow[],
  overrides: Partial<React.ComponentProps<typeof CustomFieldImportPreviewTable>> = {},
) {
  const onSelectedChange = vi.fn();
  const onPick = vi.fn();
  render(
    <CustomFieldImportPreviewTable
      rows={rows}
      selected={new Set<number>()}
      onSelectedChange={onSelectedChange}
      picks={new Map<number, string>()}
      onPick={onPick}
      {...overrides}
    />,
  );
  return { onSelectedChange, onPick };
}

function nextSelection(onSelectedChange: ReturnType<typeof vi.fn>, prev: Iterable<number> = []): Set<number> {
  const arg = onSelectedChange.mock.calls.at(-1)![0] as unknown;
  expect(typeof arg, 'setState must be called with a functional updater').toBe('function');
  return (arg as (p: Set<number>) => Set<number>)(new Set(prev));
}

describe('CustomFieldImportPreviewTable', () => {
  it('select-all spans only matched and link-match rows', async () => {
    const { onSelectedChange } = renderTable([matched, linkMatch, ambiguous, notFound]);
    await userEvent.click(screen.getByTestId('cf-import-select-all'));
    const next = nextSelection(onSelectedChange);
    expect([...next].sort()).toEqual([matched.index, linkMatch.index].sort());
  });

  it('an ambiguous row expands to ranked candidates showing serial, OS, enrolled and last-seen', async () => {
    renderTable([ambiguous]);
    await userEvent.click(screen.getByTestId(`cf-import-expand-${ambiguous.index}`));
    const first = screen.getByTestId('cf-import-candidate-0');
    for (const field of ['serial', 'os', 'enrolled', 'last-seen']) {
      expect(within(first).getByTestId(`cf-import-candidate-${field}`)).toBeInTheDocument();
    }
  });

  it('an ambiguous row cannot be committed until a candidate is picked', async () => {
    const { onPick } = renderTable([ambiguous]);
    expect(screen.getByTestId(`cf-import-row-${ambiguous.index}`)).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(screen.getByTestId(`cf-import-expand-${ambiguous.index}`));
    await userEvent.click(screen.getByTestId('cf-import-candidate-0-pick'));
    expect(onPick).toHaveBeenCalledWith(ambiguous.index, CANDIDATE_0_ID);
  });

  it('a row with a pick registered is no longer aria-disabled', () => {
    renderTable([ambiguous], { picks: new Map([[ambiguous.index, CANDIDATE_0_ID]]) });
    expect(screen.getByTestId(`cf-import-row-${ambiguous.index}`)).toHaveAttribute('aria-disabled', 'false');
  });

  it('renders per-value outcomes under a partially-applied row', () => {
    renderTable([partial]);
    expect(screen.getByTestId('cf-import-value-outcome-no-definition')).toBeInTheDocument();
    expect(screen.getByTestId('cf-import-value-outcome-type-error')).toBeInTheDocument();
  });

  it('renders the reserved-key warning inline', () => {
    renderTable([reservedKeyRow]);
    expect(screen.getByTestId('cf-import-reserved-key-warning')).toBeInTheDocument();
  });

  it('a not-found row is never selectable, even via select-all', () => {
    renderTable([notFound]);
    expect(screen.getByTestId(`cf-import-select-${notFound.index}`)).toBeDisabled();
  });
});

describe('isValueRowSelectable', () => {
  it('matched and link-match are always selectable', () => {
    expect(isValueRowSelectable(matched, new Map())).toBe(true);
    expect(isValueRowSelectable(linkMatch, new Map())).toBe(true);
  });

  it('ambiguous requires a pick', () => {
    expect(isValueRowSelectable(ambiguous, new Map())).toBe(false);
    expect(isValueRowSelectable(ambiguous, new Map([[ambiguous.index, CANDIDATE_0_ID]]))).toBe(true);
  });

  it('not-found and org-not-found are never selectable', () => {
    expect(isValueRowSelectable(notFound, new Map())).toBe(false);
  });
});

describe('bulkSelectableValueRows / defaultValueImportSelection', () => {
  it('excludes ambiguous rows even when picked', () => {
    const rows = [matched, linkMatch, ambiguous, notFound];
    const bulk = bulkSelectableValueRows(rows);
    expect(bulk.map((r) => r.index).sort()).toEqual([matched.index, linkMatch.index].sort());
    expect(defaultValueImportSelection(rows)).toEqual(new Set([matched.index, linkMatch.index]));
  });
});
