import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));

import {
  recordSignedAgreement, listAgreementRequests, createAgreementRequest, updateAgreementRequest,
  deleteAgreementRequest, previewAgreementRequest, sendAgreementRequest, getAgreementRequestLink,
  voidAgreementRequest,
} from './agreementRequests';

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

describe('send-for-signature wrappers (#9075 W2c)', () => {
  beforeEach(() => {
    fetchWithAuth.mockReset();
    fetchWithAuth.mockResolvedValue({ ok: true, status: 200 });
  });

  it('lists with only the filters that are set', async () => {
    await listAgreementRequests({ status: 'pending', orgId: 'o1' });
    const url = fetchWithAuth.mock.calls[0]![0] as string;
    expect(url.startsWith('/contracts/agreement-requests?')).toBe(true);
    const p = new URLSearchParams(url.split('?')[1]);
    expect(p.get('status')).toBe('pending');
    expect(p.get('orgId')).toBe('o1');
    expect(p.has('contractId')).toBe(false);
    await listAgreementRequests();
    expect(fetchWithAuth.mock.calls[1]![0]).toBe('/contracts/agreement-requests');
  });

  it('creates, patches and deletes drafts with JSON bodies', async () => {
    await createAgreementRequest({ orgId: 'o1', templateId: 't1', recipients: ['a@b.co'] });
    expect(fetchWithAuth.mock.calls[0]![0]).toBe('/contracts/agreement-requests');
    expect(fetchWithAuth.mock.calls[0]![1].method).toBe('POST');
    expect(JSON.parse(fetchWithAuth.mock.calls[0]![1].body)).toEqual({ orgId: 'o1', templateId: 't1', recipients: ['a@b.co'] });
    await updateAgreementRequest('r1', { variableValues: { x: 'y' } });
    expect(fetchWithAuth.mock.calls[1]![0]).toBe('/contracts/agreement-requests/r1');
    expect(fetchWithAuth.mock.calls[1]![1].method).toBe('PATCH');
    await deleteAgreementRequest('r1');
    expect(fetchWithAuth.mock.calls[2]![1].method).toBe('DELETE');
  });

  it('hits preview, send, link and void paths', async () => {
    await previewAgreementRequest('r1');
    await sendAgreementRequest('r1');
    await getAgreementRequestLink('r1');
    await voidAgreementRequest('r1', '  because ');
    await voidAgreementRequest('r1');
    expect(fetchWithAuth.mock.calls.map((c) => c[0])).toEqual([
      '/contracts/agreement-requests/r1/preview',
      '/contracts/agreement-requests/r1/send',
      '/contracts/agreement-requests/r1/link',
      '/contracts/agreement-requests/r1/void',
      '/contracts/agreement-requests/r1/void',
    ]);
    expect(JSON.parse(fetchWithAuth.mock.calls[3]![1].body)).toEqual({ reason: 'because' });
    expect(JSON.parse(fetchWithAuth.mock.calls[4]![1].body)).toEqual({});
  });
});
