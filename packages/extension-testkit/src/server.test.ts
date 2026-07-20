import { describe, expect, it } from 'vitest';
import type { BreezeExtensionV1 } from '@breeze/extension-sdk';
import { stageExtensionForTest } from './server';

function manifest(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { name: 'acme', jobs: [], aiTools: [], ...over };
}

const noopJob = (name: string) => ({ name, cron: '* * * * *', handler: async () => {} });

describe('stageExtensionForTest', () => {
  it('rejects contributions not declared in the manifest', async () => {
    const extension: BreezeExtensionV1 = {
      register(registrar) {
        registrar.registerJob(noopJob('ghost'));
      },
    };
    const result = await stageExtensionForTest(extension, manifest());
    expect(result.ok).toBe(false);
    expect(result.issues[0].code).toBe('undeclared_contribution');
  });

  it('accepts contributions that are declared', async () => {
    const extension: BreezeExtensionV1 = {
      register(registrar) {
        registrar.registerJob(noopJob('sync'));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        registrar.registerAiTool('lookup', {} as any);
      },
    };
    const result = await stageExtensionForTest(
      extension,
      manifest({ jobs: [{ name: 'sync' }], aiTools: [{ name: 'lookup' }] }),
    );
    expect(result.ok).toBe(true);
    expect(result.recorded.jobs).toEqual(['sync']);
    expect(result.recorded.aiTools).toEqual(['lookup']);
  });

  it('flags a job the manifest declares but the extension never registers', async () => {
    const extension: BreezeExtensionV1 = { register() {} };
    const result = await stageExtensionForTest(extension, manifest({ jobs: [{ name: 'sync' }] }));
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.code === 'declared_not_registered')).toBe(true);
  });

  it('throws when the extension touches the db without a supplied adapter', async () => {
    // Load-bearing: replacing the throwing db with a permissive stub makes this pass, which it must not.
    const extension: BreezeExtensionV1 = {
      async register(_registrar, context) {
        await context.db.execute('SELECT 1');
      },
    };
    const result = await stageExtensionForTest(extension, manifest());
    expect(result.ok).toBe(false);
    expect(result.issues[0].code).toBe('register_threw');
  });

  it('exercises db code when an adapter is supplied', async () => {
    const queries: unknown[] = [];
    const extension: BreezeExtensionV1 = {
      async register(_registrar, context) {
        await context.db.execute('SELECT 1');
      },
    };
    const result = await stageExtensionForTest(extension, manifest(), {
      db: {
        execute: async (query) => {
          queries.push(query);
          return [];
        },
      },
    });
    expect(queries).toEqual(['SELECT 1']);
    expect(result.ok).toBe(true);
  });

  it('leaves the recorder empty when registration throws', async () => {
    const extension: BreezeExtensionV1 = {
      register(registrar) {
        registrar.registerJob(noopJob('half'));
        throw new Error('boom during registration');
      },
    };
    const result = await stageExtensionForTest(extension, manifest());
    expect(result.issues[0].code).toBe('register_threw');
    expect(result.recorded.jobs).toEqual([]);
  });
});
