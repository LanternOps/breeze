import { describe, it, expect } from 'vitest';
import { createTemplates } from './BackupProfilesTab';

/**
 * #5493: a whole-machine profile must be ONE system_image selection that
 * also walks the OS root (wholeMachine:true), not a system_image selection
 * PLUS a separate file selection. Before the fix these templates built
 * `file: { enabled: true, ... }` alongside `system_image: { enabled: true }`,
 * which fanned out into two jobs and two incomplete snapshots — the
 * system_image snapshot had layout.json + system-state but zero files, and
 * the file snapshot had the files but no layout/state.
 */
describe('createTemplates — whole-machine presets (#5493)', () => {
  it('builds a single system_image selection with wholeMachine + the preset excludes, file disabled', () => {
    const templates = createTemplates();
    const linux = templates.find((t) => t.id === 'whole-machine-linux')!;
    const windows = templates.find((t) => t.id === 'whole-machine-windows')!;
    expect(linux).toBeDefined();
    expect(windows).toBeDefined();

    for (const template of [linux, windows]) {
      const built = template.build();
      expect(built.file.enabled).toBe(false);
      expect(built.file.paths).toEqual([]);
      expect(built.system_image.enabled).toBe(true);
      expect(built.system_image.wholeMachine).toBe(true);
      expect(built.system_image.excludes.length).toBeGreaterThan(0);
    }
  });
});
