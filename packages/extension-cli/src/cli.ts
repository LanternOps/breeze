#!/usr/bin/env node
import { Command } from 'commander';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInspect } from './commands/inspect';
import { runPack } from './commands/pack';
import { runSign } from './commands/sign';
import { runValidate } from './commands/validate';

/**
 * Builds a fresh `breeze-ext` Commander program. A factory (rather than a
 * module-level singleton) so tests can construct and exercise the program
 * without mutating shared state across test cases.
 *
 * Command bodies are minimal stubs for now — see `src/commands/*.ts`. This
 * task only fixes the CLI surface (commands, arguments, flags); packing,
 * signing, and inspection logic land in later tasks.
 */
export function createProgram(): Command {
  const program = new Command();

  program
    .name('breeze-ext')
    .description('Pack and sign .breeze-ext extension bundles for the Breeze RMM runtime extension platform')
    .version('1.0.0');

  program
    .command('validate')
    .description('Validate an extension source directory against the manifest schema')
    .argument('<path>', 'path to the extension source directory')
    .option('--json', 'emit machine-readable JSON output')
    .action(async (path: string, options: { json?: boolean }) => {
      await runValidate({ path, json: options.json });
    });

  program
    .command('pack')
    .description('Pack an extension source directory into a deterministic .breeze-ext bundle')
    .argument('<path>', 'path to the extension source directory')
    .requiredOption('-o, --out <file>', 'output path for the .breeze-ext bundle')
    .action(async (path: string, options: { out: string }) => {
      await runPack({ path, out: options.out });
    });

  program
    .command('sign')
    .description('Sign a .breeze-ext bundle with an Ed25519 private key')
    .argument('<artifact>', 'path to the .breeze-ext artifact to sign')
    // The key value is NEVER accepted on argv — process arguments are
    // world-readable via `ps`. Supply the key as a file path (--key) or as the
    // NAME of an environment variable holding it (--key-env). Exactly one is
    // required; Commander cannot express "exactly one of" natively, so it is
    // enforced in the action.
    .option('-k, --key <path>', 'path to the Ed25519 private key file')
    .option('--key-env <var>', 'name of an environment variable holding the Ed25519 private key')
    .option('-o, --out <file>', 'output path for the signed bundle (defaults to signing in place)')
    .action(async (artifact: string, options: { key?: string; keyEnv?: string; out?: string }) => {
      if ((options.key === undefined) === (options.keyEnv === undefined)) {
        throw new Error('breeze-ext sign: provide exactly one of --key or --key-env');
      }
      await runSign({ artifact, key: options.key, keyEnv: options.keyEnv, out: options.out });
    });

  program
    .command('inspect')
    .description('Print a .breeze-ext artifact\'s manifest, integrity inventory, and signature status')
    .argument('<artifact>', 'path to the .breeze-ext artifact to inspect')
    .option('--json', 'emit machine-readable JSON output')
    .option('--public-key <path>', 'path to an Ed25519 public key file to check the signature against')
    .action(async (artifact: string, options: { json?: boolean; publicKey?: string }) => {
      await runInspect({ artifact, json: options.json, publicKey: options.publicKey });
    });

  return program;
}

/**
 * True when this module is the process entry point.
 *
 * Compares REALPATHS, not the raw URL against `pathToFileURL(argv[1])`. When
 * the CLI is launched through a pnpm-installed bin, `process.argv[1]` is the
 * `node_modules/.bin` (or `.pnpm`) *symlink*, while `import.meta.url` already
 * reflects the module's *realpath* (Node resolves symlinks when loading ESM).
 * A raw comparison therefore never matches under pnpm, `isMainModule()` returns
 * false, and the binary exits 0 having parsed nothing — a silent no-op, the
 * worst failure shape for a signing/packing pipeline. Resolving both sides to
 * their realpath makes the comparison hold regardless of symlink indirection.
 *
 * `realpathSync` throws if a path does not exist (e.g. a synthetic `argv[1]`);
 * a throw here just means "not the entry point", so it is swallowed.
 */
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const program = createProgram();
  program.parseAsync(process.argv).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
