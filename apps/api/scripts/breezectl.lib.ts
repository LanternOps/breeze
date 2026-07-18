/**
 * `breezectl extensions` — the operator CLI for runtime extensions.
 *
 * ── SOURCE OF TRUTH ─────────────────────────────────────────────────────────
 * `extensions.yaml` is the ONLY store of DESIRED state: which artifact, which
 * version, which digest, which publisher, whether it is required. `install` and
 * `upgrade` edit that file and nothing else. This module deliberately imports
 * NO database module — not the Drizzle client, not the state store, not the
 * reconciler — so it is structurally incapable of writing desired state into
 * PostgreSQL even by mistake. (A test asserts that property over this file's
 * import list.)
 *
 * Runtime state that DOES live in PostgreSQL — the `enabled` on/off switch — is
 * changed through the authenticated platform-admin API rather than by writing
 * the row directly, because flipping the flag is only half the job: the running
 * server must also update its in-process contribution registry and re-sync the
 * BullMQ repeatable schedules. A direct database write would leave both stale
 * until the next restart. The CLI never mints credentials; the operator supplies
 * an existing platform-admin access token.
 *
 * ── COMMENT PRESERVATION ────────────────────────────────────────────────────
 * The only YAML library in this image is `js-yaml`, which parses to plain data
 * and cannot round-trip comments. Rather than silently destroying an operator's
 * annotations, every edit prints a unified diff AND states plainly that comments
 * and formatting are normalized. Adopting a comment-preserving parser (the
 * `yaml` package) would remove this caveat; it is not a dependency today.
 */
import {
  closeSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';
import { dump as dumpYaml } from 'js-yaml';
import {
  parseExtensionDeploymentConfig,
  type ExtensionDeploymentConfig,
  type ExtensionSelection,
} from '../src/extensions/config';
import { verifyExtensionBundle } from '../src/extensions/bundleVerifier';
import { resolveTrustedPublisher } from '../src/extensions/trust';

/** Suffix of the advisory lockfile held while an edit is in flight. */
export const LOCK_SUFFIX = '.breezectl.lock';

/** A lock older than this is assumed abandoned by a crashed process. */
const LOCK_STALE_MS = 15 * 60 * 1000;

export interface BreezectlOptions {
  /** Path to extensions.yaml. */
  configPath: string;
  log: (line: string) => void;
  /** Process environment (injected so tests need not mutate process.env). */
  env: Record<string, string | undefined>;
  fetch: typeof fetch;
}

export function defaultOptions(): BreezectlOptions {
  return {
    configPath:
      process.env.BREEZE_EXTENSIONS_CONFIG?.trim() ||
      path.join(process.env.BREEZE_EXTENSIONS_ROOT?.trim() || '/etc/breeze/extensions', 'extensions.yaml'),
    log: (line) => console.log(line),
    env: process.env,
    fetch: globalThis.fetch,
  };
}

const USAGE = `Usage: breezectl extensions <command>

Desired state (edits extensions.yaml on this host):
  install --name <n> --uri <u> [--version <v>] [--digest sha256:<hex>]
          --publisher <p> [--required] [--rollout rolling|replace] [--dry-run]
  upgrade --name <n> [--version <v>] [--digest sha256:<hex>] [--uri <u>]
          [--required] [--rollout rolling|replace] [--dry-run]
  verify  --name <n> --archive <path/to/bundle.zip>

Runtime state (calls the platform-admin API):
  list
  doctor  <name>
  enable  <name>
  disable <name>

Environment:
  BREEZE_EXTENSIONS_CONFIG  path to extensions.yaml (default:
                            $BREEZE_EXTENSIONS_ROOT/extensions.yaml)
  BREEZE_ADMIN_TOKEN        platform-admin access token (list/doctor/enable/disable)
  PUBLIC_API_URL            server origin (falls back to PUBLIC_APP_URL, BREEZE_SERVER)
`;

// ── argv parsing ────────────────────────────────────────────────────────────
// Manual, dependency-free: this repo carries no commander/yargs, and the stock
// image should not gain one for four flags.

interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
}

const BOOLEAN_FLAGS = new Set(['required', 'dry-run']);

function parseArgs(argv: readonly string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const key = token.slice(2);
    if (BOOLEAN_FLAGS.has(key)) {
      flags[key] = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`flag --${key} requires a value`);
    }
    flags[key] = value;
    i++;
  }
  return { positional, flags };
}

function requireFlag(args: ParsedArgs, name: string): string {
  const value = args.flags[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`--${name} is required`);
  }
  return value.trim();
}

function optionalFlag(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags[name];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

// ── extensions.yaml editing ─────────────────────────────────────────────────

/**
 * The raw document shape we edit. We re-serialize from the VALIDATED selection
 * list rather than mutating the parsed-but-unvalidated blob, so an edit can
 * never smuggle an unknown key past the config schema.
 */
interface EditableDocument {
  publishers: Record<string, { publicKeyFile: string }>;
  extensions: ExtensionSelection[];
}

/**
 * Parse and validate the current file. Validation runs in NON-production mode on
 * purpose: an operator must be able to inspect and repair a config on a
 * workstation, and the server re-validates under real production rules at boot
 * (where a missing digest is fatal). `install`/`upgrade` still warn about a
 * missing digest below.
 */
function loadEditable(configPath: string): EditableDocument {
  const yamlText = readFileSync(configPath, 'utf8');
  const config: ExtensionDeploymentConfig = parseExtensionDeploymentConfig(yamlText, {
    production: false,
    allowUnsigned: false,
  });
  return {
    publishers: { ...config.publishers },
    extensions: config.extensions.map((selection) => ({ ...selection })),
  };
}

/** Serialize a document to normalized YAML with a stable key order. */
function serialize(doc: EditableDocument): string {
  const ordered = {
    publishers: doc.publishers,
    extensions: doc.extensions.map((selection) => ({
      name: selection.name,
      uri: selection.uri,
      ...(selection.version !== undefined ? { version: selection.version } : {}),
      ...(selection.digest !== undefined ? { digest: selection.digest } : {}),
      publisher: selection.publisher,
      required: selection.required,
      rollout: selection.rollout,
    })),
  };
  return dumpYaml(ordered, { lineWidth: 120, noRefs: true, sortKeys: false });
}

/** A minimal unified-ish line diff — enough for an operator to eyeball a change. */
function diff(before: string, after: string): string[] {
  const beforeLines = new Set(before.split('\n'));
  const afterLines = new Set(after.split('\n'));
  const lines: string[] = [];
  for (const line of before.split('\n')) {
    if (line.trim() !== '' && !afterLines.has(line)) lines.push(`-${line}`);
  }
  for (const line of after.split('\n')) {
    if (line.trim() !== '' && !beforeLines.has(line)) lines.push(`+${line}`);
  }
  return lines;
}

/**
 * Fail early and legibly when the config cannot be rewritten on this host.
 *
 * The common cause is a correctly-locked-down deployment: the file arrives from
 * a ConfigMap, a baked image layer, or a read-only mount. That is not a CLI bug
 * to work around — desired state belongs in the deployment pipeline — so the
 * message points the operator there rather than suggesting chmod.
 */
function assertWritable(configPath: string): void {
  const immutable = () =>
    new Error(
      `${configPath} is not writable, so breezectl cannot change deployment configuration on this host. ` +
        'Extension selections are desired state: change them in your deployment configuration ' +
        '(Helm values, ConfigMap, or image build) and redeploy.',
    );

  let fd: number;
  try {
    // Open for append rather than write: proves write permission without
    // truncating the file if some later step throws.
    fd = openSync(configPath, 'a');
  } catch {
    throw immutable();
  }
  closeSync(fd);

  // A writable file in a read-only DIRECTORY still cannot be replaced, and we
  // replace via a temp file + rename to make the write atomic. Probe the
  // directory too, or the failure would surface much later as a raw EROFS.
  const probe = path.join(path.dirname(configPath), `.breezectl-probe-${process.pid}`);
  try {
    writeFileSync(probe, '');
    unlinkSync(probe);
  } catch {
    throw immutable();
  }
}

/**
 * Acquire an advisory lock via `O_EXCL` so two operators (or an operator and a
 * config-management run) cannot interleave read-modify-write cycles and silently
 * drop one another's selection. This is advisory and single-host — it protects
 * against concurrent breezectl invocations, not against a deployment pipeline
 * overwriting the file wholesale.
 */
function withLock<T>(configPath: string, log: (line: string) => void, fn: () => T): T {
  const lockPath = `${configPath}${LOCK_SUFFIX}`;

  const acquire = (): number => openSync(lockPath, 'wx');

  let fd: number;
  try {
    fd = acquire();
  } catch {
    // Someone holds it — or a crashed run left it behind. Break it only when it
    // is provably old, so a live concurrent edit is never stomped.
    let age = 0;
    try {
      age = Date.now() - statSync(lockPath).mtimeMs;
    } catch {
      age = Number.POSITIVE_INFINITY; // vanished between open and stat: retry.
    }
    if (age < LOCK_STALE_MS) {
      throw new Error(
        `another breezectl run holds the lock at ${lockPath}. ` +
          'Wait for it to finish, or remove the lockfile if you are certain no other run is active.',
      );
    }
    log(`[breezectl] breaking stale lock at ${lockPath} (held for ${Math.round(age / 1000)}s)`);
    try {
      unlinkSync(lockPath);
    } catch {
      /* raced with the holder's release — the acquire below decides */
    }
    try {
      fd = acquire();
    } catch {
      throw new Error(`could not acquire the lock at ${lockPath}`);
    }
  }

  try {
    writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    closeSync(fd);
    return fn();
  } finally {
    try {
      unlinkSync(lockPath);
    } catch {
      /* already released */
    }
  }
}

/** Write the document atomically (temp file + rename within the same dir). */
function commit(configPath: string, text: string): void {
  const tmp = `${configPath}.breezectl-${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o644 });
  renameSync(tmp, configPath);
}

/**
 * Apply exactly ONE selection change. `mode` decides whether the name must be
 * absent (install) or present (upgrade); either way precisely one entry of the
 * extensions list is added or replaced and every other entry is carried through
 * untouched.
 */
function editSelection(
  args: ParsedArgs,
  options: BreezectlOptions,
  mode: 'install' | 'upgrade',
): void {
  const name = requireFlag(args, 'name');
  const dryRun = args.flags['dry-run'] === true;

  if (!dryRun) assertWritable(options.configPath);

  withLock(options.configPath, options.log, () => {
    const doc = loadEditable(options.configPath);
    const before = serialize(doc);
    const index = doc.extensions.findIndex((selection) => selection.name === name);

    if (mode === 'install' && index !== -1) {
      throw new Error(
        `extension "${name}" is already selected in ${options.configPath}; use "breezectl extensions upgrade" instead`,
      );
    }
    if (mode === 'upgrade' && index === -1) {
      throw new Error(
        `extension "${name}" is not selected in ${options.configPath}; use "breezectl extensions install" instead`,
      );
    }

    const current = index === -1 ? undefined : doc.extensions[index];
    const next: ExtensionSelection = {
      name,
      uri: optionalFlag(args, 'uri') ?? current?.uri ?? requireFlag(args, 'uri'),
      publisher: optionalFlag(args, 'publisher') ?? current?.publisher ?? requireFlag(args, 'publisher'),
      required: args.flags.required === true ? true : (current?.required ?? false),
      rollout: (optionalFlag(args, 'rollout') ?? current?.rollout ?? 'rolling') as 'rolling' | 'replace',
      ...(optionalFlag(args, 'version') ?? current?.version
        ? { version: optionalFlag(args, 'version') ?? current?.version }
        : {}),
      ...(optionalFlag(args, 'digest') ?? current?.digest
        ? { digest: (optionalFlag(args, 'digest') ?? current?.digest) as ExtensionSelection['digest'] }
        : {}),
    };

    if (index === -1) doc.extensions.push(next);
    else doc.extensions[index] = next;

    // Re-validate the WHOLE document through the same schema the server uses, so
    // a bad flag combination is rejected here rather than at the next boot.
    const after = serialize(doc);
    parseExtensionDeploymentConfig(after, { production: false, allowUnsigned: false });

    options.log(`[breezectl] ${mode} "${name}" in ${options.configPath}`);
    for (const line of diff(before, after)) options.log(line);

    if (next.digest === undefined) {
      options.log(
        '[breezectl] WARNING: no --digest pinned. A digest is REQUIRED in production; ' +
          'this configuration will be rejected at boot.',
      );
    }

    if (dryRun) {
      options.log('[breezectl] dry run — no changes written.');
      return;
    }

    options.log(
      '[breezectl] NOTE: js-yaml cannot round-trip comments; the file is rewritten as ' +
        'normalized YAML and any comments or custom formatting are lost. Review the diff above.',
    );
    commit(options.configPath, after);
    options.log('[breezectl] Wrote extensions.yaml. Redeploy or restart the API to reconcile.');
  });
}

// ── verify ──────────────────────────────────────────────────────────────────

/**
 * Verify a bundle locally, using the SAME trust resolution and verifier the
 * server runs at boot — so a green `verify` means the server will accept the
 * artifact, not merely that the zip is well-formed.
 */
async function verifyCommand(args: ParsedArgs, options: BreezectlOptions): Promise<void> {
  const name = requireFlag(args, 'name');
  const archive = requireFlag(args, 'archive');

  const yamlText = readFileSync(options.configPath, 'utf8');
  const config = parseExtensionDeploymentConfig(yamlText, {
    production: false,
    allowUnsigned: false,
  });
  const resolvedConfig = resolveKeyPaths(config, options.configPath);

  const selection = resolvedConfig.extensions.find((entry) => entry.name === name);
  if (!selection) {
    throw new Error(`extension "${name}" is not selected in ${options.configPath}`);
  }

  const trust = resolveTrustedPublisher(resolvedConfig, selection.publisher);
  const bundle = await verifyExtensionBundle(path.resolve(archive), selection, trust);

  options.log(`[breezectl] verified "${bundle.manifest.name}" ${bundle.manifest.version}`);
  options.log(`  publisher:      ${selection.publisher}`);
  options.log(`  artifactDigest: ${bundle.artifactDigest}`);
  options.log(`  apiVersion:     ${bundle.manifest.apiVersion}`);
  options.log(`  requires:       breeze ${bundle.manifest.requires.breeze}, serverSdk ${bundle.manifest.requires.serverSdk}`);
  if (selection.digest && selection.digest !== bundle.artifactDigest) {
    throw new Error('pinned digest does not match the bundle');
  }
}

/**
 * Resolve publisher key paths relative to the config file, mirroring
 * `loadExtensionDeploymentConfig`. We cannot call that helper directly because
 * it derives production/allowUnsigned from the CLI's own environment, which is
 * the operator's workstation rather than the server.
 */
function resolveKeyPaths(
  config: ExtensionDeploymentConfig,
  configPath: string,
): ExtensionDeploymentConfig {
  const baseDir = path.dirname(path.resolve(configPath));
  const publishers: Record<string, { publicKeyFile: string }> = {};
  for (const [id, publisher] of Object.entries(config.publishers)) {
    publishers[id] = { publicKeyFile: path.resolve(baseDir, publisher.publicKeyFile) };
  }
  return { publishers, extensions: config.extensions };
}

// ── admin API verbs ─────────────────────────────────────────────────────────

function serverOrigin(env: BreezectlOptions['env']): string {
  const candidate =
    env.PUBLIC_API_URL?.trim() || env.PUBLIC_APP_URL?.trim() || env.BREEZE_SERVER?.trim();
  if (!candidate) {
    throw new Error(
      'Cannot determine the server origin: set PUBLIC_API_URL (or PUBLIC_APP_URL / BREEZE_SERVER) ' +
        'to the Breeze API origin, e.g. https://breeze.example.com',
    );
  }
  return candidate.replace(/\/+$/, '');
}

function adminToken(env: BreezectlOptions['env']): string {
  const token = env.BREEZE_ADMIN_TOKEN?.trim();
  if (!token) {
    throw new Error(
      'BREEZE_ADMIN_TOKEN is not set. breezectl does not mint credentials: supply a platform-admin ' +
        'access token, e.g. BREEZE_ADMIN_TOKEN=$(...) breezectl extensions disable <name>',
    );
  }
  return token;
}

/**
 * Call the platform-admin API. The response body is NEVER echoed on failure —
 * an error body can carry request context, and the operator's shell history and
 * CI logs are not a place to spill it. The status code plus the path is enough
 * to act on; the server's own logs hold the detail.
 */
async function adminRequest(
  options: BreezectlOptions,
  method: 'GET' | 'POST',
  pathSuffix: string,
): Promise<unknown> {
  const url = `${serverOrigin(options.env)}/api/v1/admin/extensions${pathSuffix}`;
  const response = await options.fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${adminToken(options.env)}`,
      accept: 'application/json',
    },
  });
  if (!response.ok) {
    throw new Error(
      `admin API ${method} ${pathSuffix || '/'} failed with HTTP ${response.status}. ` +
        (response.status === 401 || response.status === 403
          ? 'Check that BREEZE_ADMIN_TOKEN is a current platform-admin access token.'
          : 'See the API server logs for detail.'),
    );
  }
  return response.json();
}

interface ListedExtension {
  name: string;
  enabled: boolean;
  lifecycleState: string;
  activeVersion: string | null;
  configuredVersion: string | null;
  errorCategory: string | null;
}

async function listCommand(options: BreezectlOptions): Promise<void> {
  const body = (await adminRequest(options, 'GET', '')) as { extensions: ListedExtension[] };
  if (body.extensions.length === 0) {
    options.log('No extensions installed.');
    return;
  }
  options.log('NAME                 ENABLED  LIFECYCLE     ACTIVE      CONFIGURED  ERROR');
  for (const entry of body.extensions) {
    options.log(
      [
        entry.name.padEnd(20),
        String(entry.enabled).padEnd(7),
        entry.lifecycleState.padEnd(13),
        (entry.activeVersion ?? '-').padEnd(11),
        (entry.configuredVersion ?? '-').padEnd(11),
        entry.errorCategory ?? '-',
      ].join(' '),
    );
  }
}

async function doctorCommand(name: string, options: BreezectlOptions): Promise<void> {
  const body = await adminRequest(options, 'GET', `/${encodeURIComponent(name)}/doctor`);
  options.log(JSON.stringify(body, null, 2));
}

async function toggleCommand(
  name: string,
  enabled: boolean,
  options: BreezectlOptions,
): Promise<void> {
  const verb = enabled ? 'enable' : 'disable';
  const body = (await adminRequest(
    options,
    'POST',
    `/${encodeURIComponent(name)}/${verb}`,
  )) as { scheduleSyncDeferred?: boolean };
  options.log(`[breezectl] ${verb}d "${name}".`);
  if (body?.scheduleSyncDeferred) {
    options.log(
      '[breezectl] WARNING: the flag is applied, but the server could not re-sync job schedules ' +
        '(Redis unreachable). Requests and job ticks already honor the flag; schedules reconcile at ' +
        'the next restart.',
    );
  }
}

// ── entry point ─────────────────────────────────────────────────────────────

export async function runBreezectl(
  argv: readonly string[],
  options: BreezectlOptions,
): Promise<void> {
  const args = parseArgs(argv);
  const [noun, verb, ...rest] = args.positional;

  if (noun !== 'extensions') {
    throw new Error(`unknown command "${noun ?? ''}"\n\n${USAGE}`);
  }

  const target = () => {
    const name = rest[0] ?? optionalFlag(args, 'name');
    if (!name) throw new Error(`"${verb}" requires an extension name`);
    return name;
  };

  switch (verb) {
    case 'list':
      return listCommand(options);
    case 'doctor':
      return doctorCommand(target(), options);
    case 'enable':
      return toggleCommand(target(), true, options);
    case 'disable':
      return toggleCommand(target(), false, options);
    case 'verify':
      return verifyCommand(args, options);
    case 'install':
      return editSelection(args, options, 'install');
    case 'upgrade':
      return editSelection(args, options, 'upgrade');
    default:
      throw new Error(`unknown extensions command "${verb ?? ''}"\n\n${USAGE}`);
  }
}
