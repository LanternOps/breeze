import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeDescriptor, readDescriptor, readRecordedProject, removeDescriptor, type StackDescriptor } from './descriptor';
import { descriptorPath } from './project';

let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'wt-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const sample: StackDescriptor = {
  project: 'breeze-wt-feat-x',
  baseUrl: 'http://localhost:53421',
  apiUrl: 'http://localhost:53421/api',
  portalUrl: 'http://localhost:53421/portal',
  webPort: 53421,
  caddyPortPinned: true,
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

describe('readRecordedProject (#9864)', () => {
  it('returns the project up recorded', () => {
    writeDescriptor(dir, sample);
    expect(readRecordedProject(dir)).toBe('breeze-wt-feat-x');
  });

  it('returns null when there is no descriptor', () => {
    expect(readRecordedProject(dir)).toBeNull();
  });

  it('throws on a corrupt descriptor rather than guessing a project', () => {
    writeFileSync(descriptorPath(dir), '{nope', 'utf8');
    expect(() => readRecordedProject(dir)).toThrow(/not valid JSON/);
  });

  it('throws when the descriptor has no project', () => {
    writeFileSync(descriptorPath(dir), '{}', 'utf8');
    expect(() => readRecordedProject(dir)).toThrow(/no "project"/);
  });
});

describe('removeDescriptor', () => {
  it('deletes the descriptor and tolerates it already being gone', () => {
    writeDescriptor(dir, sample);
    removeDescriptor(dir);
    expect(existsSync(descriptorPath(dir))).toBe(false);
    expect(() => removeDescriptor(dir)).not.toThrow();
  });
});
