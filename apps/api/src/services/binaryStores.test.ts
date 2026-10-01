import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { binaryS3Key, binaryStoreDir, s3SyncTargets } from './binaryStores';

const KEYS = ['AGENT_BINARY_DIR', 'VIEWER_BINARY_DIR', 'HELPER_BINARY_DIR'] as const;

describe('binaryStores', () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('compose layout: three stores, three prefixes', () => {
    process.env.AGENT_BINARY_DIR = '/data/binaries/agent';
    process.env.VIEWER_BINARY_DIR = '/data/binaries/viewer';
    process.env.HELPER_BINARY_DIR = '/data/binaries/helper';
    expect(s3SyncTargets().map((t) => [t.dir, t.s3Prefix])).toEqual([
      ['/data/binaries/agent', 'agent'],
      ['/data/binaries/viewer', 'viewer'],
      ['/data/binaries/helper', 'helper'],
    ]);
    expect(binaryS3Key('agent', 'breeze-backup-linux-amd64')).toBe('agent/breeze-backup-linux-amd64');
    expect(binaryS3Key('helper', 'h.msi')).toBe('helper/h.msi');
  });

  it('an unset HELPER_BINARY_DIR follows AGENT_BINARY_DIR and shares its prefix', () => {
    process.env.AGENT_BINARY_DIR = '/srv/breeze/agent';
    expect(binaryStoreDir('helper')).toBe('/srv/breeze/agent');
    expect(binaryS3Key('helper', 'h.msi')).toBe('agent/h.msi');
    expect(s3SyncTargets().map((t) => t.s3Prefix)).toEqual(['agent', 'viewer']);
  });

  it('defaults resolve relative to the working directory', () => {
    expect(binaryStoreDir('agent')).toBe(resolve('./agent/bin'));
    expect(binaryStoreDir('viewer')).toBe(resolve('./viewer/bin'));
    expect(binaryStoreDir('helper')).toBe(resolve('./agent/bin'));
  });

  it('a helper dir equal to the agent dir (trailing slash) is synced once under agent/', () => {
    process.env.AGENT_BINARY_DIR = '/data/binaries/agent';
    process.env.HELPER_BINARY_DIR = '/data/binaries/agent/';
    expect(s3SyncTargets().map((t) => t.store)).toEqual(['agent', 'viewer']);
    expect(binaryS3Key('helper', 'h.msi')).toBe('agent/h.msi');
  });
});
