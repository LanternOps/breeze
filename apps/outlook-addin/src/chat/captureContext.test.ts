import { describe, expect, it } from 'vitest';
import { getOfficeMock } from '../__tests__/officeMock';
import { captureOutlookContext, captureOutlookSubject } from './captureContext';

describe('captureOutlookContext', () => {
  it("'none' sends kind only", async () => {
    await expect(captureOutlookContext('none')).resolves.toEqual({ kind: 'none' });
  });

  it("'selection' carries subject + body under text", async () => {
    const mock = getOfficeMock();
    mock.setItem({ subject: 'Project Apollo', body: 'Status update inside.' }, 'read');
    const result = await captureOutlookContext('selection');
    expect(result?.kind).toBe('selection');
    expect(result?.text).toContain('Project Apollo');
    expect(result?.text).toContain('Status update inside.');
  });

  it("'selection' reads the body through getAsync", async () => {
    const mock = getOfficeMock();
    mock.setItem({ subject: 's', body: 'b' }, 'read');
    await captureOutlookContext('selection');
    expect(mock.bodyGetCalls.length).toBe(1);
  });
});

describe('captureOutlookSubject', () => {
  it('reads the open message subject for the history tag', async () => {
    getOfficeMock().setItem({ subject: 'RE: Contract' }, 'read');
    await expect(captureOutlookSubject()).resolves.toBe('RE: Contract');
  });

  it('returns undefined when there is no subject', async () => {
    getOfficeMock().setItem({ subject: '' }, 'read');
    await expect(captureOutlookSubject()).resolves.toBeUndefined();
  });
});
