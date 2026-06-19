import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeDescriptor, readDescriptor, type StackDescriptor } from './descriptor';

let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'wt-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const sample: StackDescriptor = {
  project: 'breeze-wt-feat-x',
  baseUrl: 'http://localhost:53421',
  apiUrl: 'http://localhost:53421/api',
  portalUrl: 'http://localhost:53421/portal',
  webPort: 53421,
  pgContainer: 'breeze-wt-feat-x-postgres-1',
  redisContainer: 'breeze-wt-feat-x-redis-1',
  admin: { email: 'admin@breeze.local', password: 'BreezeAdmin123!' },
};

describe('descriptor round-trip', () => {
  it('writes and reads back identical data', () => {
    writeDescriptor(dir, sample);
    expect(readDescriptor(dir)).toEqual(sample);
  });

  it('throws a clear error when the descriptor is missing', () => {
    expect(() => readDescriptor(dir)).toThrow(/No stack descriptor.*wt-stack up/);
  });
});
