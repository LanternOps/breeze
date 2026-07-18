#!/usr/bin/env node
import { Command } from 'commander';
import { pathToFileURL } from 'node:url';
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
    .argument('<bundle>', 'path to the .breeze-ext bundle to sign')
    .requiredOption('-k, --key <path>', 'path to the Ed25519 private key')
    .option('-o, --out <file>', 'output path for the signed bundle (defaults to signing in place)')
    .action(async (bundle: string, options: { key: string; out?: string }) => {
      await runSign({ bundle, key: options.key, out: options.out });
    });

  program
    .command('inspect')
    .description('Print a .breeze-ext bundle\'s manifest, integrity inventory, and signature status')
    .argument('<bundle>', 'path to the .breeze-ext bundle to inspect')
    .option('--json', 'emit machine-readable JSON output')
    .action(async (bundle: string, options: { json?: boolean }) => {
      await runInspect({ bundle, json: options.json });
    });

  return program;
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

if (isMainModule()) {
  const program = createProgram();
  program.parseAsync(process.argv).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
