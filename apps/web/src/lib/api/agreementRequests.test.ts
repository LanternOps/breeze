import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));

import { recordSignedAgreement } from './agreementRequests';

describe('recordSignedAgreement', () => {
  beforeEach(() => {
    fetchWithAuth.mockReset();
    fetchWithAuth.mockResolvedValue({ ok: true, status: 201 });
  });

  const base = {
    orgId: 'org-1',
    templateVersionId: 'v-1',
    variableValues: { 'custom.po': 'PO-9' },
    signerName: 'Jane Doe',
    signedAt: '2026-10-18T12:00:00.000Z',
    method: 'signed_document' as const,
    reference: 'Scanned MSA',
  };

  it('posts multipart FormData to the record-signed path with variableValues stringified and the file appended', async () => {
    const file = new File(['%PDF'], 'msa.pdf', { type: 'application/pdf' });
    await recordSignedAgreement({ ...base, file });

    const [path, init] = fetchWithAuth.mock.calls[0]!;
    expect(path).toBe('/contracts/agreement-requests/record-signed');
    expect(init.method).toBe('POST');
    expect(init.body).toBeInstanceOf(FormData);
    const fd = init.body as FormData;
    expect(fd.get('orgId')).toBe('org-1');
    expect(fd.get('templateVersionId')).toBe('v-1');
    expect(fd.get('variableValues')).toBe(JSON.stringify({ 'custom.po': 'PO-9' }));
    expect(fd.get('method')).toBe('signed_document');
    expect(fd.get('reference')).toBe('Scanned MSA');
    expect((fd.get('file') as File).name).toBe('msa.pdf');
    // A JSON content-type would break the multipart boundary.
    expect(init.headers).toBeUndefined();
  });

  it('omits optional fields that are empty', async () => {
    await recordSignedAgreement({
      ...base,
      contractId: null,
      label: '',
      signerEmail: '  ',
      effectiveDate: null,
      file: null,
    });
    const fd = fetchWithAuth.mock.calls[0]![1].body as FormData;
    for (const k of ['contractId', 'label', 'signerEmail', 'effectiveDate', 'file']) {
      expect(fd.has(k)).toBe(false);
    }
  });
});
