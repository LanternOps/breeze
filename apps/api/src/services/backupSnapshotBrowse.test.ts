import { describe, expect, it } from 'vitest';
import { shapeBrowseRows } from './backupSnapshotBrowse';

describe('shapeBrowseRows fileCount (#9628)', () => {
  it('reports the number of files beneath each directory entry, never on files', () => {
    const page = shapeBrowseRows(
      [
        { name: 'docs', is_dir: true, source_path: '/a/docs/x', size: null, modified_at: null, file_count: '42' },
        { name: 'a.txt', is_dir: false, source_path: '/a/a.txt', size: 3, modified_at: null, file_count: 1 },
      ],
      ['a'],
      10
    );
    expect(page.entries[0]).toEqual({ name: 'docs', path: '/a/docs', type: 'directory', fileCount: 42 });
    expect(page.entries[1]).not.toHaveProperty('fileCount');
  });
});
