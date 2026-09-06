import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const state = vi.hoisted(() => ({
  canManagePartnerWide: undefined as boolean | undefined,
  isPartnerScope: false,
  defaultOwnerScope: 'organization' as 'organization' | 'partner',
}));

const fetchWithAuthMock = vi.fn();
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: (...a: unknown[]) => fetchWithAuthMock(...a),
  useAuthStore: (selector: (s: { user: { canManagePartnerWide?: boolean } }) => unknown) =>
    selector({ user: { canManagePartnerWide: state.canManagePartnerWide } }),
}));

vi.mock('../../hooks/useDefaultOwnerScope', () => ({
  useDefaultOwnerScope: () => ({
    isPartnerScope: state.isPartnerScope,
    defaultOwnerScope: state.defaultOwnerScope,
  }),
}));

const showToastMock = vi.fn();
vi.mock('../shared/Toast', () => ({ showToast: (...a: unknown[]) => showToastMock(...a) }));

import CustomFieldDefinitionImportStep from './CustomFieldDefinitionImportStep';
import type { AnnotatedDefinitionRow } from './CustomFieldDefinitionImportStep';

const ORG_ID = '11111111-1111-4111-8111-111111111111';

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }),
  );
}

async function uploadCsv(csv: string) {
  const file = new File([csv], 'fields.csv', { type: 'text/csv' });
  Object.defineProperty(file, 'text', { value: () => Promise.resolve(csv) });
  fireEvent.change(screen.getByTestId('cf-def-file-input'), { target: { files: [file] } });
  await waitFor(() => expect(screen.getByTestId('cf-def-preview')).toBeInTheDocument());
}

function mockPreview(rows: Partial<AnnotatedDefinitionRow>[]) {
  fetchWithAuthMock.mockImplementationOnce(() =>
    jsonResponse({
      rows: rows.map((r, i) => ({
        index: i,
        fieldKey: 'udf7',
        name: 'udf7',
        type: 'text',
        ownerScope: 'organization',
        organizationId: ORG_ID,
        annotation: 'create',
        existingId: null,
        existingType: null,
        ...r,
      })),
    }),
  );
}

beforeEach(() => {
  fetchWithAuthMock.mockReset();
  showToastMock.mockReset();
  state.canManagePartnerWide = undefined;
  state.isPartnerScope = false;
  state.defaultOwnerScope = 'organization';
});

describe('CustomFieldDefinitionImportStep', () => {
  it('pre-fills each name from sourceLabel so 30 slots are renamed in one grid', async () => {
    render(<CustomFieldDefinitionImportStep source="datto_rmm" organizationId={ORG_ID} />);
    await uploadCsv('UDF Slot,Label\nudf7,\nudf8,\n');
    expect(screen.getByTestId('cf-def-name-udf7')).toHaveValue('udf7');
    expect(screen.getByTestId('cf-def-source-label-udf7')).toHaveTextContent('udf7');
  });

  it('defaults every field to text so an operator who changes nothing still lands values', async () => {
    render(<CustomFieldDefinitionImportStep source="datto_rmm" organizationId={ORG_ID} />);
    await uploadCsv('UDF Slot\nudf7\n');
    expect(screen.getByTestId('cf-def-type-udf7')).toHaveValue('text');
  });

  it('hides the partner-wide owner option from a user who cannot manage it', async () => {
    state.isPartnerScope = true;
    state.canManagePartnerWide = false;
    render(<CustomFieldDefinitionImportStep source="datto_rmm" organizationId={ORG_ID} />);
    await uploadCsv('UDF Slot\nudf7\n');
    expect(screen.queryByTestId('cf-def-owner-partner')).toBeNull();
  });

  it('defaults ownerScope from useDefaultOwnerScope, not from a local copy of the rule', async () => {
    state.isPartnerScope = true;
    state.canManagePartnerWide = true;
    state.defaultOwnerScope = 'partner';
    render(<CustomFieldDefinitionImportStep source="datto_rmm" organizationId={ORG_ID} />);
    await uploadCsv('UDF Slot\nudf7\n');
    expect(screen.getByTestId('cf-def-owner-partner')).toBeChecked();
  });

  it('sends the preview POST through runAction (fetchWithAuth)', async () => {
    mockPreview([{ index: 0, fieldKey: 'udf7', annotation: 'create' }]);
    render(<CustomFieldDefinitionImportStep source="datto_rmm" organizationId={ORG_ID} />);
    await uploadCsv('UDF Slot\nudf7\n');
    fireEvent.click(screen.getByTestId('cf-def-preview'));
    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalled());
    const [url, init] = fetchWithAuthMock.mock.calls[0]!;
    expect(url).toBe('/custom-fields/import/preview');
    expect((init as { method: string }).method).toBe('POST');
  });

  it('surfaces a type-conflict row and excludes it from the commit selection', async () => {
    mockPreview([{ index: 0, fieldKey: 'udf7', annotation: 'type-conflict', existingType: 'text' }]);
    render(<CustomFieldDefinitionImportStep source="datto_rmm" organizationId={ORG_ID} />);
    await uploadCsv('UDF Slot,Type\nudf7,date\n');
    fireEvent.click(screen.getByTestId('cf-def-preview'));
    await waitFor(() => expect(screen.getByTestId('cf-def-annotation-type-conflict')).toBeInTheDocument());
    expect(screen.getByTestId('cf-def-row-0')).toHaveAttribute('aria-disabled', 'true');
  });

  it('is skippable when the definitions already exist', async () => {
    mockPreview([{ index: 0, fieldKey: 'udf7', annotation: 'already-exists', existingId: 'def-1', existingType: 'text' }]);
    render(<CustomFieldDefinitionImportStep source="datto_rmm" organizationId={ORG_ID} />);
    await uploadCsv('UDF Slot\nudf7\n');
    fireEvent.click(screen.getByTestId('cf-def-preview'));
    await waitFor(() => expect(screen.getByTestId('cf-def-skip-to-values')).toBeInTheDocument());
  });

  it('commits through runAction and reports the created count', async () => {
    mockPreview([{ index: 0, fieldKey: 'udf7', annotation: 'create' }]);
    fetchWithAuthMock.mockImplementationOnce(() =>
      jsonResponse({
        created: [{ index: 0, definitionId: 'def-9', fieldKey: 'udf7', ownerScope: 'organization', organizationId: ORG_ID }],
        skipped: [],
        errors: [],
      }),
    );
    const onCommitted = vi.fn();
    render(<CustomFieldDefinitionImportStep source="datto_rmm" organizationId={ORG_ID} onCommitted={onCommitted} />);
    await uploadCsv('UDF Slot\nudf7\n');
    fireEvent.click(screen.getByTestId('cf-def-preview'));
    await waitFor(() => screen.getByTestId('cf-def-commit'));
    fireEvent.click(screen.getByTestId('cf-def-commit'));
    await waitFor(() => expect(onCommitted).toHaveBeenCalled());
    const summary = onCommitted.mock.calls[0]![0];
    expect(summary.created).toHaveLength(1);
  });
});
