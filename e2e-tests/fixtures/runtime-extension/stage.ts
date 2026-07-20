#!/usr/bin/env tsx
/**
 * Build + pack + sign the Task 6 (Plan 03) runtime-extension fixture, using
 * the REAL `@breeze/extension-cli` (the Plan 02 packer/signer) — the same
 * `pack`/`sign` commands `apps/api/src/extensions/__fixtures__/twoReplica.ts`
 * drives (via its library entry points) to build fixtures for the
 * two-replica reconcile integration test.
 *
 * WHAT THIS SCRIPT DOES NOT DO, AND WHY
 * --------------------------------------
 * It does not install the artifact into a running server's `extensions.yaml`,
 * and it does not enable it. `reconcileExtensions()` — the only code path
 * that turns a `extensions.yaml` entry into an active, contribution-bearing
 * extension — runs ONLY at API boot (`apps/api/src/index.ts:1601`), not on a
 * file-watch or a request. So finishing the "stage" half of "stage+enable"
 * necessarily requires an operator action this script cannot perform on its
 * own: editing `extensions.yaml` (via `breezectl extensions install`, printed
 * below) AND RESTARTING the API process. Only after that restart does
 * `GET /api/v1/admin/extensions/e2e-fixture` (and thus the enable/disable
 * flow the Playwright spec drives) resolve to anything.
 *
 * Usage:
 *   pnpm --filter @breeze/e2e-tests exec tsx fixtures/runtime-extension/stage.ts
 *
 * Output (all under fixtures/runtime-extension/build/):
 *   keys/signing-key.pem   — Ed25519 private key (generated fresh every run;
 *                            never commit this)
 *   keys/publisher.pem     — matching public key (goes in extensions.yaml's
 *                            `publishers.<id>.publicKeyFile`)
 *   signed.breeze-ext      — the packed + signed artifact
 *   digest.txt             — its `sha256:<hex>` digest (also printed)
 *
 * It then prints the exact `breezectl extensions install` invocation for
 * this artifact, and the restart requirement, so an operator can copy/paste
 * the rest of the setup against their own dev stack's `extensions.yaml` path.
 */
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const BUILD_DIR = join(HERE, 'build');

/**
 * `e2e-tests` is a standalone npm project (its own `package-lock.json`), NOT
 * a member of the root `pnpm-workspace.yaml` (`apps/*`, `packages/*`,
 * `extensions/*` only) — so it cannot `import` `@breeze/extension-cli` as an
 * ordinary node-resolved dependency without adding a `file:` link and an
 * `npm install` this script shouldn't require just to build a fixture.
 * Instead this shells out to the REAL CLI exactly the way an operator would:
 * `pnpm --filter @breeze/extension-cli exec tsx src/cli.ts <command>`, which
 * this repo's root `tsx` devDependency (hoisted to the workspace root's
 * `node_modules/.bin`, resolvable via the parent-directory PATH walk `pnpm
 * exec` performs) runs directly against the CLI's TypeScript source — no
 * build step, no new dependency, no lockfile change anywhere.
 */
function runExtensionCli(args: string[]): string {
  return execFileSync(
    'pnpm',
    ['--filter', '@breeze/extension-cli', 'exec', 'tsx', 'src/cli.ts', ...args],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
}

/** `runPack`/`runSign` (packages/extension-cli/src/commands/{pack,sign}.ts)
 *  each print exactly two lines: the artifact path, then its `sha256:...`
 *  digest. Parse those back out rather than re-deriving the digest here. */
function parsePathAndDigest(cliOutput: string): { artifactPath: string; digest: string } {
  const lines = cliOutput.split('\n').map((line) => line.trim()).filter(Boolean);
  const digest = lines.at(-1);
  const artifactPath = lines.at(-2);
  if (!artifactPath || !digest || !digest.startsWith('sha256:')) {
    throw new Error(`unexpected breeze-ext CLI output:\n${cliOutput}`);
  }
  return { artifactPath, digest };
}

/**
 * The esbuild binary this repo already resolves (transitively, via vitest)
 * into `packages/extension-web-sdk`'s own `node_modules/.bin`. Shelling out
 * to this concrete path avoids adding a new `esbuild` dependency (and a
 * lockfile change) to `e2e-tests` just to bundle one fixture module.
 * `web/index.ts` imports `@breeze/extension-web-sdk`'s public API by
 * RELATIVE path (see its header comment for why), so no `--alias` or other
 * resolution override is needed here — esbuild follows the relative import
 * like any other local file.
 */
const ESBUILD_BIN = join(REPO_ROOT, 'packages', 'extension-web-sdk', 'node_modules', '.bin', 'esbuild');

async function bundleWebEntry(outFile: string): Promise<void> {
  execFileSync(
    ESBUILD_BIN,
    [
      join(HERE, 'web', 'index.ts'),
      '--bundle',
      '--format=esm',
      '--platform=browser',
      '--target=es2020',
      `--outfile=${outFile}`,
    ],
    { stdio: 'inherit' },
  );
}

async function main(): Promise<void> {
  await rm(BUILD_DIR, { recursive: true, force: true });
  const sourceDir = await mkdtemp(join(tmpdir(), 'breeze-e2e-fixture-src-'));

  try {
    // 1. Assemble the extension SOURCE tree `packExtension` will walk:
    //    manifest.json, server/index.cjs (copied as-is), web/index.js
    //    (bundled from web/index.ts — see bundleWebEntry above).
    await mkdir(join(sourceDir, 'server'), { recursive: true });
    await mkdir(join(sourceDir, 'web'), { recursive: true });
    execFileSync('cp', [join(HERE, 'manifest.json'), join(sourceDir, 'manifest.json')]);
    execFileSync('cp', [join(HERE, 'server', 'index.cjs'), join(sourceDir, 'server', 'index.cjs')]);
    await bundleWebEntry(join(sourceDir, 'web', 'index.js'));

    // 2. Pack + sign with the real CLI (same commands
    //    apps/api/src/extensions/__fixtures__/twoReplica.ts's
    //    `buildSignedExtension` drives via the library entry points; here we
    //    drive the CLI surface directly — see `runExtensionCli` above for why).
    const keyDir = join(BUILD_DIR, 'keys');
    await mkdir(keyDir, { recursive: true });
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const privateKeyPath = join(keyDir, 'signing-key.pem');
    const publicKeyPath = join(keyDir, 'publisher.pem');
    await writeFile(privateKeyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }));
    await writeFile(publicKeyPath, publicKey.export({ type: 'spki', format: 'pem' }));

    const unsignedPath = join(BUILD_DIR, 'unsigned.breeze-ext');
    const signedPath = join(BUILD_DIR, 'signed.breeze-ext');

    runExtensionCli(['pack', sourceDir, '-o', unsignedPath]);
    const signOutput = runExtensionCli(['sign', unsignedPath, '-k', privateKeyPath, '-o', signedPath]);
    const signResult = parsePathAndDigest(signOutput);

    await writeFile(join(BUILD_DIR, 'digest.txt'), `${signResult.digest}\n`);

    const artifactUri = pathToFileURL(signResult.artifactPath).href;

    console.log('');
    console.log('Fixture built and signed:');
    console.log(`  artifact: ${signResult.artifactPath}`);
    console.log(`  digest:   ${signResult.digest}`);
    console.log(`  pubkey:   ${publicKeyPath}`);
    console.log('');
    console.log('Next steps against a running dev stack (see runtime-extensions.spec.ts header):');
    console.log('');
    console.log('  1. Add a publisher entry pointing at the pubkey above to your');
    console.log('     extensions.yaml, e.g.:');
    console.log('       publishers:');
    console.log('         e2e-fixture-publisher:');
    console.log(`           publicKeyFile: ${publicKeyPath}`);
    console.log('');
    console.log('  2. Install the selection (adjust BREEZE_EXTENSIONS_CONFIG to your stack):');
    console.log('       BREEZE_EXTENSIONS_CONFIG=/path/to/extensions.yaml \\');
    console.log('       pnpm --filter @breeze/api run breezectl:dev -- extensions install \\');
    console.log('         --name e2e-fixture \\');
    console.log(`         --uri ${artifactUri} \\`);
    console.log('         --version 1.0.0 \\');
    console.log(`         --digest ${signResult.digest} \\`);
    console.log('         --publisher e2e-fixture-publisher');
    console.log('');
    console.log('  3. RESTART the API process — reconcileExtensions() only runs at boot.');
    console.log('');
    console.log('  4. Only then does GET /api/v1/admin/extensions/e2e-fixture (and the');
    console.log('     enable/disable flow the spec drives) resolve to anything.');
    console.log('');
  } finally {
    await rm(sourceDir, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
