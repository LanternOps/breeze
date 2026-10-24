import { describe, expect, it } from 'vitest';
import { folderCheckState, selectedFolderFileTotal } from './folderSelection';

describe('folderCheckState', () => {
  it('is checked when the folder itself is selected', () => {
    expect(folderCheckState('/Finance', new Set(['/Finance', '/Finance/a.txt']))).toBe('checked');
  });

  it('is checked when an ancestor folder is selected', () => {
    expect(folderCheckState('/Finance/2026', new Set(['/Finance']))).toBe('checked');
  });

  it('is partial when only a descendant is selected', () => {
    expect(folderCheckState('/Finance', new Set(['/Finance/2026/q1.xlsx']))).toBe('partial');
  });

  it('does not treat a sibling sharing a name prefix as related', () => {
    expect(folderCheckState('/Fin', new Set(['/Finance', '/Finance/a.txt']))).toBe('unchecked');
    expect(folderCheckState('/Finance', new Set(['/Fin']))).toBe('unchecked');
  });

  it('lines up tree paths with stored Windows file paths', () => {
    expect(folderCheckState('/C:/Users/x', new Set(['C:\\Users\\x\\a.txt']))).toBe('partial');
    expect(folderCheckState('/C:/Users/x', new Set(['C:/Users/x']))).toBe('checked');
  });

  it('is unchecked for an empty selection', () => {
    expect(folderCheckState('/Finance', new Set())).toBe('unchecked');
  });
});

describe('selectedFolderFileTotal', () => {
  it('sums known folder counts plus the one being added, ignoring files and unknown paths', () => {
    const counts = new Map([['/A', 600]]);
    expect(selectedFolderFileTotal(new Set(['/A', '/A/f.txt', '/unknown']), counts, 500)).toBe(1100);
  });
});
