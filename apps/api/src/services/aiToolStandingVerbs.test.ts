import { describe, expect, it } from 'vitest';
import { standingVerbsFor } from './aiToolStandingVerbs';

const DEVICE = '00000000-0000-4000-8000-000000000001';

describe('standingVerbsFor', () => {
  it('a patch install can reboot under the default if_required policy: exact patch_install + reboot', () => {
    expect(standingVerbsFor('manage_patches', { action: 'install', deviceIds: [DEVICE], patchIds: [] })).toEqual({
      exact: ['patch_install', 'reboot', 'any_change'],
      possible: [],
    });
  });

  it('a patch rollback is a patch change that may reboot', () => {
    expect(standingVerbsFor('manage_patches', { action: 'rollback', deviceId: DEVICE })).toEqual({
      exact: ['patch_install', 'any_change'],
      possible: ['reboot'],
    });
  });

  it('run_script is exactly run_script, and only possibly a reboot or shutdown (opaque)', () => {
    expect(standingVerbsFor('run_script', { deviceIds: [DEVICE] })).toEqual({
      exact: ['run_script', 'any_change'],
      possible: ['reboot', 'shutdown'],
    });
  });

  it('execute_command changes are any_change, reboot/shutdown only possible; its reads are none', () => {
    expect(standingVerbsFor('execute_command', { commandType: 'stop_service', deviceId: DEVICE })).toEqual({
      exact: ['any_change'],
      possible: ['reboot', 'shutdown'],
    });
    expect(standingVerbsFor('execute_command', { commandType: 'file_read', deviceId: DEVICE })).toEqual({ exact: [], possible: [] });
  });

  it('a read action of a change tool is none (byAction)', () => {
    expect(standingVerbsFor('manage_services', { action: 'list', deviceId: DEVICE })).toEqual({ exact: [], possible: [] });
    expect(standingVerbsFor('manage_services', { action: 'restart', deviceId: DEVICE })).toEqual({ exact: ['any_change'], possible: [] });
  });

  it('a multiplexed tool with no action falls back to the tool-level rule (never to none)', () => {
    expect(standingVerbsFor('manage_services', { deviceId: DEVICE })).toEqual({ exact: ['any_change'], possible: [] });
  });

  it('a tool that changes nothing on the device is none', () => {
    expect(standingVerbsFor('take_screenshot', { deviceId: DEVICE })).toEqual({ exact: [], possible: [] });
  });

  it('an unmapped tool never matches', () => {
    expect(standingVerbsFor('query_devices', {})).toEqual({ exact: [], possible: [] });
    expect(standingVerbsFor('not_a_tool', { deviceId: DEVICE })).toEqual({ exact: [], possible: [] });
  });
});
