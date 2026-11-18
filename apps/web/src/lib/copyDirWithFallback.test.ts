import { describe, expect, it, vi } from 'vitest';
import { copyDirWithFallback } from './copyDirWithFallback';

const eacces = () => Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });

describe('copyDirWithFallback', () => {
  it('uses the native recursive copy when it succeeds', () => {
    const cpSync = vi.fn();
    const rmSync = vi.fn();
    const execCp = vi.fn();
    copyDirWithFallback('/src', '/dest', { cpSync, rmSync, execCp });
    expect(cpSync).toHaveBeenCalledWith('/src', '/dest', { recursive: true });
    expect(rmSync).not.toHaveBeenCalled();
    expect(execCp).not.toHaveBeenCalled();
  });

  it('on EACCES removes the partial copy and falls back to cp -R src dest', () => {
    const calls: string[] = [];
    const cpSync = vi.fn(() => { calls.push('cpSync'); throw eacces(); });
    const rmSync = vi.fn(() => { calls.push('rmSync'); });
    const execCp = vi.fn(() => { calls.push('execCp'); });
    copyDirWithFallback('/src', '/dest', { cpSync, rmSync, execCp });
    expect(rmSync).toHaveBeenCalledWith('/dest', { recursive: true, force: true });
    expect(execCp).toHaveBeenCalledWith('/src', '/dest');
    expect(calls).toEqual(['cpSync', 'rmSync', 'execCp']);
  });

  it('rethrows non-EACCES errors without falling back', () => {
    const boom = Object.assign(new Error('nope'), { code: 'ENOENT' });
    const execCp = vi.fn();
    expect(() =>
      copyDirWithFallback('/src', '/dest', {
        cpSync: () => { throw boom; },
        rmSync: vi.fn(),
        execCp,
      }),
    ).toThrow(boom);
    expect(execCp).not.toHaveBeenCalled();
  });
});
