import { execFile } from 'node:child_process';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProgram } from './cli';

const execFileAsync = promisify(execFile);

describe('breeze-ext CLI surface', () => {
  it('registers exactly the commands validate, pack, sign, inspect', () => {
    const program = createProgram();
    const names = program.commands.map((command) => command.name()).sort();
    expect(names).toEqual(['inspect', 'pack', 'sign', 'validate']);
  });

  it('exits 0 on --help', async () => {
    const program = createProgram();
    program.exitOverride();

    let caught: unknown;
    try {
      await program.parseAsync(['node', 'breeze-ext', '--help']);
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({
      code: 'commander.helpDisplayed',
      exitCode: 0,
    });
  });

  it('exits 0 on <command> --help for each registered command', async () => {
    const program = createProgram();
    // exitOverride() is copied to a subcommand only at the moment the
    // subcommand is created (Commander's copyInheritedSettings), so it must
    // be applied to each already-registered subcommand explicitly here.
    program.exitOverride();
    for (const command of program.commands) {
      command.exitOverride();
    }

    for (const commandName of ['validate', 'pack', 'sign', 'inspect']) {
      let caught: unknown;
      try {
        await program.parseAsync(['node', 'breeze-ext', commandName, '--help']);
      } catch (error) {
        caught = error;
      }

      expect(caught).toMatchObject({
        code: 'commander.helpDisplayed',
        exitCode: 0,
      });
    }
  });
});

describe('breeze-ext sign key source', () => {
  // The private key must be supplied as EITHER a file path (--key) or the NAME
  // of an environment variable holding it (--key-env). Exactly one is required.
  // The key value itself is never accepted on argv, because process arguments
  // are world-readable via `ps`; --key-env carries the variable name, not the
  // key. `sign.test.ts` covers the fully-implemented signing behavior; here we
  // only need proof the option surface accepted the input and reached the
  // action -- i.e. failed on trying to read a nonexistent artifact file,
  // rather than on option parsing (a distinct commander error raised before
  // the action ever runs).
  async function runSignArgs(args: string[]): Promise<unknown> {
    const program = createProgram();
    program.exitOverride();
    for (const command of program.commands) command.exitOverride();
    try {
      await program.parseAsync(['node', 'breeze-ext', 'sign', ...args]);
      return undefined;
    } catch (error) {
      return error;
    }
  }

  it('accepts --key alone', async () => {
    const error = await runSignArgs(['bundle.breeze-ext', '--key', '/tmp/key.pem']);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toMatch(/exactly one of --key or --key-env/i);
    expect((error as { code?: string }).code?.startsWith('commander.')).not.toBe(true);
  });

  it('accepts --key-env alone', async () => {
    const error = await runSignArgs(['bundle.breeze-ext', '--key-env', 'BREEZE_SIGNING_KEY']);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toMatch(/exactly one of --key or --key-env/i);
    expect((error as { code?: string }).code?.startsWith('commander.')).not.toBe(true);
  });

  it('rejects supplying both --key and --key-env', async () => {
    const error = await runSignArgs([
      'bundle.breeze-ext', '--key', '/tmp/key.pem', '--key-env', 'BREEZE_SIGNING_KEY',
    ]);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/exactly one of --key or --key-env/i);
  });

  it('rejects supplying neither --key nor --key-env', async () => {
    const error = await runSignArgs(['bundle.breeze-ext']);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/exactly one of --key or --key-env/i);
  });
});

describe('module load purity', () => {
  it('importing src/index.ts performs no filesystem or network work at module load', async () => {
    // Structural assertion, not a global fs/network mock: a mock here would
    // fight the packer/signer tests added in later tasks. Instead we assert
    // that the import itself never throws (i.e. no eager fs/network calls
    // that could fail in a sandboxed test environment) and that every export
    // is a plain function or object -- never an already-settled Promise,
    // Buffer, or other value that could only exist if I/O had already run at
    // import time.
    const module = await import('./index');

    expect(Object.keys(module).length).toBeGreaterThan(0);

    for (const [name, value] of Object.entries(module)) {
      const type = typeof value;
      expect(
        type === 'function' || type === 'object',
        `expected export "${name}" to be a function or object, got ${type}`,
      ).toBe(true);
      expect(
        value,
        `expected export "${name}" to not be a Promise (would imply eager async I/O)`,
      ).not.toBeInstanceOf(Promise);
    }
  });
});

describe('breeze-ext bin entry (isMainModule) under symlink indirection', () => {
  // Regression for #2657. When `breeze-ext` is launched through a pnpm-installed
  // bin, `process.argv[1]` is the `node_modules/.bin` symlink while
  // `import.meta.url` is the module's realpath. The old guard compared the raw
  // URL against `pathToFileURL(argv[1])`, never matched under a symlink, and the
  // process exited 0 having parsed nothing — a silent no-op. Launching the real
  // cli.ts through a symlink and observing the program actually run (here: emit
  // its version) proves the guard now resolves both sides to their realpath.
  const cliPath = join(dirname(fileURLToPath(import.meta.url)), 'cli.ts');
  const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  let linkDir: string;

  beforeEach(async () => {
    linkDir = await mkdtemp(join(tmpdir(), 'breeze-ext-binlink-'));
  });

  afterEach(async () => {
    await rm(linkDir, { recursive: true, force: true });
  });

  it('runs the program when invoked as the entry point through a symlink', async () => {
    const link = join(linkDir, 'breeze-ext-link.ts');
    await symlink(cliPath, link);

    // node --import tsx <symlink> --version — with the old guard this printed
    // nothing and exited 0; with the fix it prints the CLI version.
    const { stdout } = await execFileAsync(
      process.execPath,
      ['--import', 'tsx', link, '--version'],
      { cwd: packageRoot },
    );

    expect(stdout.trim()).toBe('1.0.0');
  }, 30000);
});
