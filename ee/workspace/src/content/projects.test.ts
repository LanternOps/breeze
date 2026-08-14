import { describe, it, expect } from 'vitest';
import { deriveDeclaredProject } from './projects';

describe('deriveDeclaredProject — declared location from rel_path', () => {
  it('derives key + label from a Projects folder', () => {
    expect(deriveDeclaredProject('Projects/2023-041 Henderson Water Main Replacement/plans.md'))
      .toEqual({ key: '2023-041', label: 'Henderson Water Main Replacement' });
  });

  it('derives from Short Term folders including nested subfolders', () => {
    expect(deriveDeclaredProject('Short Term/2026-018 Casella Creek Culvert/02 Correspondence/notes.txt'))
      .toEqual({ key: '2026-018', label: 'Casella Creek Culvert' });
  });

  it('derives key (no label) from Emails/<key>/ folders', () => {
    expect(deriveDeclaredProject('Emails/2023-041/2023-08-15 deluca PO 4021 issued.eml'))
      .toEqual({ key: '2023-041', label: null });
  });

  it('returns null for Unfiled email', () => {
    expect(deriveDeclaredProject('Emails/Unfiled/new - re PO 4021.eml')).toBeNull();
  });

  it('returns null for loose files at a root (misfile targets stay unclaimed)', () => {
    expect(deriveDeclaredProject('Short Term/fish passage memo review comments.md')).toBeNull();
    expect(deriveDeclaredProject('Legacy/SCAN0007.TXT')).toBeNull();
    expect(deriveDeclaredProject('todo.txt')).toBeNull();
  });

  it('ignores folders that do not start with a job-number key', () => {
    expect(deriveDeclaredProject('Projects/Miscellaneous/notes.md')).toBeNull();
  });
});
