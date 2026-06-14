import { describe, expect, it } from 'vitest';
import { getOfficeMock } from '../__tests__/officeMock';
import { captureWordContext, captureWordDocumentName } from './captureContext';

describe('captureWordContext', () => {
  it("'none' sends kind only", async () => {
    await expect(captureWordContext('none')).resolves.toEqual({ kind: 'none' });
  });

  it("'selection' captures the selected text under text", async () => {
    const mock = getOfficeMock();
    mock.setBody('alpha beta gamma');
    mock.select('alpha '.length, 'alpha beta'.length);
    await expect(captureWordContext('selection')).resolves.toEqual({
      kind: 'selection',
      text: 'beta',
    });
  });

  it("'sheet' captures the whole document body as text", async () => {
    const mock = getOfficeMock();
    mock.setBody('Whole document body\nLine two');
    await expect(captureWordContext('sheet')).resolves.toEqual({
      kind: 'sheet',
      text: 'Whole document body\nLine two',
    });
  });
});

describe('captureWordDocumentName', () => {
  it('reads the open document file name', async () => {
    getOfficeMock().documentName = 'Proposal.docx';
    await expect(captureWordDocumentName()).resolves.toBe('Proposal.docx');
  });
});
