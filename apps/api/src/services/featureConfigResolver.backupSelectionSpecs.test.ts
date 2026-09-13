import { describe, it, expect } from 'vitest';
import { backupSelectionSpecs } from './featureConfigResolver';

/**
 * #5493: a whole-machine profile is ONE system_image selection with files +
 * layout.json + system state, not a system_image + file fan-out into two
 * snapshots. backupSelectionSpecs must pass wholeMachine/excludes through to
 * the system_image job spec so backupWorker.resolveBackupTargets can build
 * the single-snapshot payload.
 */
describe('backupSelectionSpecs — system_image', () => {
  it('defaults wholeMachine to false and excludes to [] when absent', () => {
    const specs = backupSelectionSpecs({ system_image: { enabled: true } });
    expect(specs).toEqual([
      {
        backupMode: 'system_image',
        targets: { includeSystemState: true, wholeMachine: false, excludes: [] },
      },
    ]);
  });

  it('passes wholeMachine=true and excludes through', () => {
    const specs = backupSelectionSpecs({
      system_image: {
        enabled: true,
        includeSystemState: true,
        wholeMachine: true,
        excludes: ['/proc/**', '/sys/**'],
      },
    });
    expect(specs).toEqual([
      {
        backupMode: 'system_image',
        targets: {
          includeSystemState: true,
          wholeMachine: true,
          excludes: ['/proc/**', '/sys/**'],
        },
      },
    ]);
  });

  it('ignores a non-array excludes value and falls back to []', () => {
    const specs = backupSelectionSpecs({
      system_image: { enabled: true, wholeMachine: true, excludes: 'not-an-array' },
    });
    expect(specs).toEqual([
      {
        backupMode: 'system_image',
        targets: { includeSystemState: true, wholeMachine: true, excludes: [] },
      },
    ]);
  });

  it('coerces a non-true wholeMachine value to false', () => {
    const specs = backupSelectionSpecs({
      system_image: { enabled: true, wholeMachine: 'yes' },
    });
    expect(specs).toEqual([
      {
        backupMode: 'system_image',
        targets: { includeSystemState: true, wholeMachine: false, excludes: [] },
      },
    ]);
  });

  it('returns null when nothing is enabled', () => {
    expect(backupSelectionSpecs({ system_image: { enabled: false } })).toBeNull();
  });
});
