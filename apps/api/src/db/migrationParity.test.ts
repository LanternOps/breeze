import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * migrationParity — read-only ledger parity check (wave 3.5d-b, #4086).
 *
 * `pollIntervalMs`/`timeoutMs` are kept tiny (single-digit ms) throughout so
 * the "keeps polling" cases run fast without fake timers.
 */

const { executeMock, readFileMock, discoverMock, planMock, hashMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
  readFileMock: vi.fn(),
  discoverMock: vi.fn(),
  planMock: vi.fn(),
  hashMock: vi.fn((content: string) => `hash:${content}`),
}));

vi.mock('../db', () => ({
  db: { execute: executeMock },
}));

vi.mock('node:fs/promises', () => ({
  readFile: readFileMock,
}));

vi.mock('./autoMigrate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./autoMigrate')>();
  return {
    ...actual,
    // partitionLedgerRows / MIGRATION_TABLE stay real (pure, cheap) —
    // discovery/planning/hashing are the file-system-and-content-dependent
    // parts that need mocking.
    discoverCoreMigrationFilenames: discoverMock,
    planMigrations: planMock,
    hashSql: hashMock,
  };
});

import { waitForMigrationParity } from './migrationParity';

function setup(filenames: string[]) {
  discoverMock.mockResolvedValue(filenames);
  planMock.mockReturnValue(filenames.map((f) => ({ ledgerName: f, filePath: `/fake/${f}` })));
}

describe('waitForMigrationParity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hashMock.mockImplementation((content: string) => `hash:${content}`);
    readFileMock.mockImplementation(async (path: unknown) => `content-for-${String(path)}`);
  });

  it('resolves immediately when every on-disk filename is present with a matching checksum', async () => {
    setup(['0001-foo.sql']);
    readFileMock.mockResolvedValue('content-A');
    executeMock.mockResolvedValue([{ filename: '0001-foo.sql', checksum: 'hash:content-A' }]);

    await expect(
      waitForMigrationParity({ timeoutMs: 50, pollIntervalMs: 5, log: vi.fn() })
    ).resolves.toBeUndefined();
    expect(executeMock).toHaveBeenCalledTimes(1);
  });

  it('keeps polling, then throws naming the missing filename once the deadline passes', async () => {
    setup(['0001-foo.sql', '0002-bar.sql']);
    // 0002-bar.sql never shows up in the ledger across any poll.
    executeMock.mockResolvedValue([
      { filename: '0001-foo.sql', checksum: 'hash:content-for-/fake/0001-foo.sql' },
    ]);

    await expect(
      waitForMigrationParity({ timeoutMs: 30, pollIntervalMs: 5, log: vi.fn() })
    ).rejects.toThrow(/0002-bar\.sql/);
    // More than one attempt proves it actually polled rather than failing fast.
    expect(executeMock.mock.calls.length).toBeGreaterThan(1);
  });

  it('throws naming a checksum-mismatched filename', async () => {
    setup(['0001-foo.sql']);
    executeMock.mockResolvedValue([{ filename: '0001-foo.sql', checksum: 'stale-checksum' }]);

    await expect(
      waitForMigrationParity({ timeoutMs: 20, pollIntervalMs: 5, log: vi.fn() })
    ).rejects.toThrow(/0001-foo\.sql/);
  });

  it('resolves with a warning when the ledger has extra core rows this binary does not ship on disk', async () => {
    setup(['0001-foo.sql']);
    executeMock.mockResolvedValue([
      { filename: '0001-foo.sql', checksum: 'hash:content-for-/fake/0001-foo.sql' },
      { filename: '0002-newer.sql', checksum: 'whatever-a-newer-binary-wrote' },
    ]);
    const log = vi.fn();

    await expect(
      waitForMigrationParity({ timeoutMs: 50, pollIntervalMs: 5, log })
    ).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('0002-newer.sql'));
  });

  it('ignores namespaced extension ledger rows entirely (not "extra", not "missing")', async () => {
    setup(['0001-foo.sql']);
    executeMock.mockResolvedValue([
      { filename: '0001-foo.sql', checksum: 'hash:content-for-/fake/0001-foo.sql' },
      { filename: 'workspace/0001-init.sql', checksum: 'whatever' },
    ]);
    const log = vi.fn();

    await expect(
      waitForMigrationParity({ timeoutMs: 50, pollIntervalMs: 5, log })
    ).resolves.toBeUndefined();
    for (const call of log.mock.calls) {
      expect(String(call[0])).not.toContain('workspace/0001-init.sql');
    }
  });

  it('treats a not-yet-created ledger table (42P01) as an empty ledger rather than crashing', async () => {
    setup(['0001-foo.sql']);
    const err = Object.assign(new Error('relation "breeze_migrations" does not exist'), {
      code: '42P01',
    });
    executeMock.mockRejectedValue(err);

    await expect(
      waitForMigrationParity({ timeoutMs: 20, pollIntervalMs: 5, log: vi.fn() })
    ).rejects.toThrow(/0001-foo\.sql/);
  });

  it('propagates a non-42P01 DB error immediately rather than treating it as "still pending"', async () => {
    setup(['0001-foo.sql']);
    executeMock.mockRejectedValue(new Error('connection refused'));

    await expect(
      waitForMigrationParity({ timeoutMs: 50, pollIntervalMs: 5, log: vi.fn() })
    ).rejects.toThrow('connection refused');
    expect(executeMock).toHaveBeenCalledTimes(1);
  });
});
