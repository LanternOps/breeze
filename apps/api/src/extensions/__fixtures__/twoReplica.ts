/**
 * Fixture authoring for the two-replica reconcile integration test (Task 8,
 * issue #2619). Builds REAL signed `.breeze-ext` bundles with the REAL
 * `@breeze/extension-cli` (mirroring `packerConformance.test.ts`'s
 * `buildSignedFixture`), writes a real `extensions.yaml` + PEM publisher
 * public key, and hands back everything
 * `twoReplicaReconcile.integration.test.ts` needs to fork two children
 * against the same on-disk deployment config.
 *
 * Nothing here runs in the CHILD process — only the parent test authors
 * fixtures; the child (`reconcileChild.ts`) only ever reads the paths this
 * module writes.
 */
import { generateKeyPairSync } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { dump as dumpYaml } from 'js-yaml';
import { packExtension, signArtifact } from '@breeze/extension-cli';

/** One extension to author, pack, and sign for a scenario. */
export interface FixtureExtensionSpec {
  /** Must be a valid lowercase kebab-ish extension name (NAME_RE in config.ts). */
  name: string;
  required: boolean;
  /**
   * Raw SQL for `migrations/0001_init.sql`. Deliberately authored by the
   * CALLER (not this module) so each scenario controls its own
   * idempotency/failure shape — e.g. the happy path uses a non-idempotent
   * `CREATE TABLE` (no `IF NOT EXISTS`) so a genuine second execution would
   * throw, which is half of the exactly-once proof.
   */
  migrationSql: string;
  /**
   * Tables to declare in the manifest's `tenancy.nonTenantTables`. MUST be
   * prefixed `${name}_` (the manifest schema enforces this) and MUST cover
   * every table `migrationSql` creates — otherwise the reconciler's
   * boot-time tenancy tripwire (`tenancyTripwire.ts`,
   * `assertNoUnaccountedPublicTables`) fails BOTH extensions in the
   * scenario, not just this one.
   */
  nonTenantTables: string[];
}

/** A single packed+signed extension, ready to reference from `extensions.yaml`. */
export interface BuiltFixtureExtension {
  name: string;
  required: boolean;
  artifactPath: string;
  digest: `sha256:${string}`;
}

/** Everything the parent test needs to fork children against this scenario. */
export interface ScenarioFixture {
  /** Absolute path to the scenario's `extensions.yaml`. */
  configPath: string;
  extensions: BuiltFixtureExtension[];
}

function manifestFor(spec: FixtureExtensionSpec): Record<string, unknown> {
  return {
    apiVersion: 'breeze.extensions/v1',
    name: spec.name,
    version: '1.0.0',
    routeNamespace: spec.name,
    requires: {
      // The host descriptor (hostDescriptor.ts) advertises breezeVersion
      // '0.1.0' / serverSdkVersion '1.0.0' — these ranges must be satisfied
      // against THOSE numbers, not the artifact's own version.
      breeze: '^0.1.0',
      serverSdk: '^1.0.0',
      capabilities: [],
    },
    server: { entry: 'server/index.cjs' },
    schemaCompatibilityFloor: '1.0.0',
    jobs: [],
    aiTools: [],
    tenancy: {
      orgCascadeDeleteTables: [],
      deviceCascadeDeleteTables: [],
      deviceOrgDenormalizedTables: [],
      nonTenantTables: spec.nonTenantTables,
    },
  };
}

/** Write a minimal, SDK-valid extension source tree that `collectPayload` accepts. */
async function writeExtensionSourceTree(dir: string, spec: FixtureExtensionSpec): Promise<void> {
  await mkdir(join(dir, 'server'), { recursive: true });
  await mkdir(join(dir, 'migrations'), { recursive: true });
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifestFor(spec)));
  await writeFile(join(dir, 'server/index.cjs'), 'module.exports = { register() {} };\n');
  await writeFile(join(dir, 'migrations/0001_init.sql'), spec.migrationSql);
}

/** Pack + sign one extension with the real CLI, under `<root>/<name>/...`. */
async function buildSignedExtension(
  root: string,
  spec: FixtureExtensionSpec,
  privateKeyPath: string,
): Promise<BuiltFixtureExtension> {
  const sourceDir = join(root, spec.name, 'src');
  const outDir = join(root, spec.name, 'out');
  await mkdir(sourceDir, { recursive: true });
  await mkdir(outDir, { recursive: true });
  await writeExtensionSourceTree(sourceDir, spec);

  const packResult = await packExtension({
    path: sourceDir,
    out: join(outDir, 'unsigned.breeze-ext'),
    sourceDateEpoch: 0,
  });
  const signResult = await signArtifact({
    artifact: packResult.artifactPath,
    key: privateKeyPath,
    out: join(outDir, 'signed.breeze-ext'),
  });

  return {
    name: spec.name,
    required: spec.required,
    artifactPath: signResult.artifactPath,
    digest: signResult.digest as `sha256:${string}`,
  };
}

/**
 * Build a full scenario under `root`: generate ONE Ed25519 keypair for the
 * scenario's publisher, pack + sign every extension in `specs` with it, and
 * write `extensions.yaml` + the publisher's PEM public key to disk. No key
 * material is committed anywhere — everything lives under the caller's temp
 * `root`, generated fresh per test run.
 */
export async function buildScenarioFixture(
  root: string,
  publisherId: string,
  specs: readonly FixtureExtensionSpec[],
): Promise<ScenarioFixture> {
  const keyDir = join(root, 'keys');
  await mkdir(keyDir, { recursive: true });
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const privateKeyPath = join(keyDir, 'signing-key.pem');
  const publicKeyPath = join(keyDir, 'publisher.pem');
  await writeFile(privateKeyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  await writeFile(publicKeyPath, publicKey.export({ type: 'spki', format: 'pem' }));

  const built: BuiltFixtureExtension[] = [];
  for (const spec of specs) {
    // Sequential on purpose: pack/sign is cheap, and sequencing keeps each
    // extension's temp subtree fully written before the next starts, which
    // makes any failure's error message unambiguous about which extension it
    // came from.
    built.push(await buildSignedExtension(root, spec, privateKeyPath));
  }

  const config = {
    publishers: {
      [publisherId]: { publicKeyFile: publicKeyPath },
    },
    extensions: built.map((ext) => ({
      name: ext.name,
      uri: pathToFileURL(ext.artifactPath).href,
      version: '1.0.0',
      digest: ext.digest,
      publisher: publisherId,
      required: ext.required,
      rollout: 'rolling' as const,
    })),
  };

  const configDir = join(root, 'config');
  await mkdir(configDir, { recursive: true });
  const configPath = join(configDir, 'extensions.yaml');
  await writeFile(configPath, dumpYaml(config));

  return { configPath, extensions: built };
}
