/**
 * Boot upsert of the built-in YARA pack (#6263 W03b, spec §5 step 5, D7).
 *
 * The release workflow builds `breeze-yara-builtin.json` from a pinned YARA
 * Forge release (scripts/security/yara-pack/) and lists it in the Ed25519-signed
 * release-artifact-manifest.json. At boot every API replica calls
 * `syncBuiltinYaraPack()`, the ONLY writer of the built-in `yara_rule_sets` row
 * (routes 403 it; RLS gives tenants SELECT only):
 *
 *  1. load the pack and verify its sha256 + size against the signed manifest —
 *     BINARY_SOURCE=github: the server's own GitHub release;
 *     BINARY_SOURCE=local:  the binaries volume, next to a staged signed
 *     manifest pair (self-host falls back to GitHub when nothing is staged;
 *     hosted never fetches the public release). No trust root, no pack;
 *  2. parse it and re-derive the canonical W02 §C2 bytes with the SAME builder
 *     custom sets publish with (`buildYaraBundleJson`); a pack that is not
 *     byte-identical is refused — so publishing "the bytes exactly as shipped"
 *     and Part A's "the published bundle is the canonical build" are one
 *     invariant, not two;
 *  3. compare with the published row: only a STRICTLY newer version is applied
 *     (an older or equal pack — a rollback, a second replica — is a no-op);
 *  4. run the same `breeze-yarac validate` pre-check as custom sets (Open
 *     Decision 9: in production an unavailable pre-check REFUSES; lint-only only
 *     under NODE_ENV development/test + BREEZE_YARA_LINT_ONLY=1). Any rule error
 *     refuses the whole pack — the release already validated it with the same
 *     compiler, so an error here means this image's engine disagrees;
 *  5. apply under an advisory lock in one system-scope transaction
 *     (yaraBuiltinPackStore.ts), re-checking the version inside the lock.
 *
 * Never throws and never blocks boot (index.ts does not await it): every
 * failure is logged and returns 'skipped' with the existing row untouched.
 *
 * Kill switch: BREEZE_YARA_BUILTIN_PACK_DISABLED=1 disables the built-in set
 * on the next boot (scan dispatch then reports it `disabled` and the agent
 * fetch route 404s it) and loads nothing. The pack auto-quarantines (D7) and
 * an older release can never roll it back, so this is how an operator stops a
 * bad pack before a fixed one ships. Unsetting it re-enables the set. The env
 * var is the only thing that ever disables the built-in row.
 */
import { readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  buildYaraBundleJson,
  YARA_BUILTIN_RULE_SET_ID,
  YARA_BUNDLE_FORMAT,
  YARA_BUNDLE_FORMAT_VERSION,
  YARA_MAX_RULE_SOURCE_BYTES,
  YARA_MAX_RULES_PER_SET,
  YARA_RULE_NAME_PATTERN,
  YARA_RULE_SEVERITIES,
  type YaraBundleRuleInput,
  type YaraRuleSeverity,
} from '@breeze/shared';
import {
  getBinarySource,
  getGithubExpectedReleaseTag,
  getGithubReleaseArtifactManifestSignatureUrl,
  getGithubReleaseArtifactManifestUrl,
  getGithubReleaseRepository,
  getGithubYaraBuiltinPackUrl,
  YARA_BUILTIN_PACK_ASSET_NAME,
} from './binarySource';
import { getBinaryEdition } from './binaryEdition';
import { binaryStoreDir } from './binaryStores';
import {
  fetchVerifiedGithubReleaseArtifact,
  isReleaseArtifactManifestVerificationConfigured,
  ReleaseManifestAssetAbsentError,
  verifyReleaseArtifactBuffer,
} from './releaseArtifactManifest';
import { assertGithubFetchableEdition } from './releaseAssetTrust';
import { applyBuiltinPack, readBuiltinPackRow, setBuiltinPackEnabled, type BuiltinPackRow } from './yaraBuiltinPackStore';
import { precheckYaraBundle, yaraLintOnlyAllowed, yaracVersion } from './yaraPrecheck';

export type BuiltinYaraPackOutcome = 'unchanged' | 'updated' | 'skipped';

/** W02 §C2 bundle ceiling. */
export const BUILTIN_PACK_MAX_BYTES = 16 * 1024 * 1024;
/** 500 rules compile far longer than one edit; this runs off the request path. */
export const BUILTIN_PACK_PRECHECK_TIMEOUT_MS = 180_000;
const BUILTIN_PACK_FETCH_TIMEOUT_MS = 60_000;
/** Every asset release.yml produces itself is recorded with this trust level. */
const PACK_PLATFORM_TRUST = 'release-workflow-produced';
/** The pack is built only by the public release, identical for both editions. */
const PACK_EDITION = 'self-host';
const MAX_INT4 = 2_147_483_647;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LOG = '[yara-builtin]';

export class BuiltinPackRejectedError extends Error {
  constructor(reason: string) {
    super(`built-in YARA pack rejected: ${reason}`);
    this.name = 'BuiltinPackRejectedError';
  }
}

export interface LoadedBuiltinPack {
  bytes: Buffer;
  /** sha256 of `bytes`, equal to the signed manifest entry. */
  sha256: string;
  release: string;
  origin: 'github' | 'local';
}

export interface ParsedBuiltinPack {
  version: number;
  rules: YaraBundleRuleInput[];
  /** The canonical bundle text, identical to the loaded bytes. */
  json: string;
}

// ---- parse + canonical check ----------------------------------------------

const fatalUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export function parseBuiltinPack(bytes: Buffer): ParsedBuiltinPack {
  if (bytes.length === 0 || bytes.length > BUILTIN_PACK_MAX_BYTES) {
    throw new BuiltinPackRejectedError(`size ${bytes.length} outside 1..${BUILTIN_PACK_MAX_BYTES}`);
  }
  let text: string;
  try {
    text = fatalUtf8.decode(bytes);
  } catch {
    throw new BuiltinPackRejectedError('not valid UTF-8');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new BuiltinPackRejectedError('not valid JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new BuiltinPackRejectedError('not a JSON object');
  }
  const b = raw as Record<string, unknown>;
  if (b.format !== YARA_BUNDLE_FORMAT || b.v !== YARA_BUNDLE_FORMAT_VERSION) {
    throw new BuiltinPackRejectedError(`unsupported format ${String(b.format)} v${String(b.v)}`);
  }
  if (b.ruleSetId !== YARA_BUILTIN_RULE_SET_ID) {
    throw new BuiltinPackRejectedError(`ruleSetId ${String(b.ruleSetId)} is not the built-in id`);
  }
  const version = b.version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1 || version > MAX_INT4) {
    throw new BuiltinPackRejectedError(`version ${String(version)} is not an integer in 1..${MAX_INT4}`);
  }
  if (b.autoQuarantine !== true) {
    throw new BuiltinPackRejectedError('autoQuarantine must be true for the built-in pack (spec D7)');
  }
  if (!Array.isArray(b.rules) || b.rules.length === 0 || b.rules.length > YARA_MAX_RULES_PER_SET) {
    throw new BuiltinPackRejectedError(`rules must hold 1..${YARA_MAX_RULES_PER_SET} entries`);
  }
  const names = new Set<string>();
  const ids = new Set<string>();
  const rules: YaraBundleRuleInput[] = [];
  for (const r of b.rules as unknown[]) {
    if (typeof r !== 'object' || r === null) throw new BuiltinPackRejectedError('a rule is not an object');
    const { id, name, severity, source } = r as Record<string, unknown>;
    if (typeof id !== 'string' || !UUID_PATTERN.test(id)) throw new BuiltinPackRejectedError(`rule id ${String(id)} is not a UUID`);
    if (typeof name !== 'string' || !YARA_RULE_NAME_PATTERN.test(name)) throw new BuiltinPackRejectedError(`rule name ${String(name)} is invalid`);
    if (typeof severity !== 'string' || !(YARA_RULE_SEVERITIES as readonly string[]).includes(severity)) {
      throw new BuiltinPackRejectedError(`rule ${name}: severity ${String(severity)} is invalid`);
    }
    if (typeof source !== 'string' || source.length === 0 || Buffer.byteLength(source, 'utf8') > YARA_MAX_RULE_SOURCE_BYTES) {
      throw new BuiltinPackRejectedError(`rule ${name}: source is empty or over ${YARA_MAX_RULE_SOURCE_BYTES} bytes`);
    }
    if (names.has(name)) throw new BuiltinPackRejectedError(`duplicate rule name ${name}`);
    if (ids.has(id)) throw new BuiltinPackRejectedError(`duplicate rule id ${id}`);
    names.add(name);
    ids.add(id);
    rules.push({ id, name, severity: severity as YaraRuleSeverity, source });
  }
  const canonical = buildYaraBundleJson({ ruleSetId: YARA_BUILTIN_RULE_SET_ID, version, autoQuarantine: true, rules });
  if (canonical !== text) {
    throw new BuiltinPackRejectedError('bytes are not the canonical W02 §C2 serialization');
  }
  return { version, rules, json: text };
}

// ---- version decision ------------------------------------------------------

export type BuiltinPackDecision = 'apply' | 'current' | 'older' | 'same_version_conflict' | 'not_builtin';

export function decideBuiltinPackAction(
  row: BuiltinPackRow | null,
  pack: { version: number; sha256: string },
): BuiltinPackDecision {
  if (!row) return 'apply';
  if (!row.isBuiltin) return 'not_builtin';
  if (pack.version > row.publishedVersion) return 'apply';
  if (pack.version < row.publishedVersion) return 'older';
  return row.publishedSha256 === pack.sha256 ? 'current' : 'same_version_conflict';
}

// ---- load + verify ---------------------------------------------------------

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === 'ENOENT';
}

function envTrim(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v ? v : undefined;
}

/**
 * The release the pack is read from: the server's OWN release. A BYO-signing
 * BINARY_VERSION override wins (its repository is the one releaseSource
 * resolves); the server-only binaries pairing deliberately does NOT — the pack
 * is server content and the server-only release rebuilds it.
 */
function packReleaseVersion(): string {
  return envTrim('BINARY_VERSION') ?? envTrim('BREEZE_VERSION') ?? 'latest';
}

async function readStagedPack(path: string): Promise<Buffer | null> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }
  if (size <= 0 || size > BUILTIN_PACK_MAX_BYTES) {
    throw new Error(`staged ${YARA_BUILTIN_PACK_ASSET_NAME} is ${size} bytes`);
  }
  return readFile(path);
}

async function readManifestPair(dir: string): Promise<{ manifestBytes: Buffer; signatureBytes: Buffer } | null> {
  const manifestPath = join(dir, 'release-artifact-manifest.json');
  let manifestBytes: Buffer;
  try {
    manifestBytes = await readFile(manifestPath);
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }
  try {
    return { manifestBytes, signatureBytes: await readFile(`${manifestPath}.ed25519`) };
  } catch (err) {
    if (isEnoent(err)) throw new Error(`${dir}: signed manifest pair is incomplete (no .ed25519)`);
    throw err;
  }
}

async function loadLocalPack(): Promise<LoadedBuiltinPack | null> {
  const agentDir = binaryStoreDir('agent');
  const bytes = await readStagedPack(join(agentDir, YARA_BUILTIN_PACK_ASSET_NAME));
  if (!bytes) return null;

  // Any staged pair signed by the release key may vouch for the pack; every
  // candidate is held to the same signature, sha256, size, platform-trust and
  // self-host-edition checks, so trying several never widens trust. The
  // hosted volume root carries the hosted build's own manifest, which does not
  // list the pack (edition would be refused anyway); the public pair sits next
  // to the public assets (agent or helper dir), as for the Helper installers.
  const candidates = [...new Set([agentDir, binaryStoreDir('helper'), dirname(agentDir)])];
  const failures: string[] = [];
  for (const dir of candidates) {
    let pair: { manifestBytes: Buffer; signatureBytes: Buffer } | null;
    try {
      pair = await readManifestPair(dir);
    } catch (err) {
      failures.push(errMessage(err));
      continue;
    }
    if (!pair) continue;
    try {
      const verified = await verifyReleaseArtifactBuffer({
        assetName: YARA_BUILTIN_PACK_ASSET_NAME,
        assetBuffer: bytes,
        manifestBytes: pair.manifestBytes,
        signatureBytes: pair.signatureBytes,
        expectedPlatformTrust: PACK_PLATFORM_TRUST,
        expectedEdition: PACK_EDITION,
      });
      return { bytes, sha256: verified.sha256, release: verified.release, origin: 'local' };
    } catch (err) {
      failures.push(`${dir}: ${errMessage(err)}`);
    }
  }
  throw new Error(
    `staged ${YARA_BUILTIN_PACK_ASSET_NAME} does not verify against a signed release manifest: ${
      failures.length > 0 ? failures.join('; ') : 'no signed manifest pair is staged'
    }`,
  );
}

async function loadGithubPack(): Promise<LoadedBuiltinPack | null> {
  if (!isReleaseArtifactManifestVerificationConfigured()) {
    const log = process.env.NODE_ENV === 'production' ? console.error : console.warn;
    log(`${LOG} no release-manifest trust root (RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS); the built-in pack is never loaded unverified`);
    return null;
  }
  const version = packReleaseVersion();
  try {
    const { buffer, verified } = await fetchVerifiedGithubReleaseArtifact({
      assetName: YARA_BUILTIN_PACK_ASSET_NAME,
      assetUrl: getGithubYaraBuiltinPackUrl(version),
      manifestUrl: getGithubReleaseArtifactManifestUrl(version),
      signatureUrl: getGithubReleaseArtifactManifestSignatureUrl(version),
      expectedRepository: getGithubReleaseRepository(),
      expectedRelease: getGithubExpectedReleaseTag(version),
      expectedPlatformTrust: PACK_PLATFORM_TRUST,
      expectedEdition: PACK_EDITION,
      maxAssetBytes: BUILTIN_PACK_MAX_BYTES,
      signal: AbortSignal.timeout(BUILTIN_PACK_FETCH_TIMEOUT_MS),
    });
    assertGithubFetchableEdition({ assetName: YARA_BUILTIN_PACK_ASSET_NAME, edition: verified.edition });
    return { bytes: buffer, sha256: verified.sha256, release: verified.release, origin: 'github' };
  } catch (err) {
    if (err instanceof ReleaseManifestAssetAbsentError) {
      console.log(`${LOG} release ${version} does not ship a built-in pack; nothing to load`);
      return null;
    }
    throw err;
  }
}

/**
 * The verified pack bytes, or null when this deployment has none to load
 * (release predates the pack, nothing staged on hosted, no trust root).
 * Throws when a pack IS present but does not verify — that is a tamper or a
 * misconfiguration, never a reason to trust the bytes.
 */
export async function loadVerifiedBuiltinPack(): Promise<LoadedBuiltinPack | null> {
  if (getBinarySource() === 'local') {
    const local = await loadLocalPack();
    if (local) return local;
    if (getBinaryEdition() === 'hosted') {
      // Loud in every NODE_ENV (#9166): a hosted boot with no pack means the
      // built-in YARA set is never published, which must not pass unnoticed.
      const agentDir = binaryStoreDir('agent');
      const manifestPath = join(agentDir, 'release-artifact-manifest.json');
      console.error(
        `${LOG} built-in YARA pack NOT loaded: BINARY_SOURCE=local and BINARY_EDITION=hosted select the binaries volume, ` +
          `and hosted deployments never fetch the pack from the public release. Expected staged files: ` +
          `${join(agentDir, YARA_BUILTIN_PACK_ASSET_NAME)}, ${manifestPath}, ${manifestPath}.ed25519 ` +
          `(the signed manifest pair may instead sit in ${binaryStoreDir('helper')} or ${dirname(agentDir)}). ` +
          `Stage them in the hosted binaries image; the built-in YARA set stays unpublished until then.`,
      );
      return null;
    }
    console.log(`${LOG} ${YARA_BUILTIN_PACK_ASSET_NAME} is not staged locally; fetching it from the signed GitHub release`);
  }
  return loadGithubPack();
}

// ---- orchestration ---------------------------------------------------------

function builtinPackDisabled(): boolean {
  const v = process.env.BREEZE_YARA_BUILTIN_PACK_DISABLED?.trim().toLowerCase();
  return v === '1' || v === 'true';
}

export async function syncBuiltinYaraPack(): Promise<BuiltinYaraPackOutcome> {
  try {
    if (builtinPackDisabled()) {
      const changed = await setBuiltinPackEnabled(false);
      console.warn(`${LOG} BREEZE_YARA_BUILTIN_PACK_DISABLED is set: the built-in set is disabled and no pack is loaded${changed ? ' (disabled now)' : ''}`);
      return changed ? 'updated' : 'unchanged';
    }

    const loaded = await loadVerifiedBuiltinPack();
    if (!loaded) return 'skipped';
    const pack = parseBuiltinPack(loaded.bytes);
    const ctx = { version: pack.version, sha256: loaded.sha256, release: loaded.release, origin: loaded.origin };

    const row = await readBuiltinPackRow();
    let reenabled = false;
    if (row && row.isBuiltin && !row.enabled) {
      // Only the kill switch disables the built-in row; it is no longer set.
      reenabled = await setBuiltinPackEnabled(true);
      if (reenabled) console.warn(`${LOG} kill switch lifted: built-in set re-enabled`, ctx);
    }
    const kept: BuiltinYaraPackOutcome = reenabled ? 'updated' : 'unchanged';
    const decision = decideBuiltinPackAction(row, { version: pack.version, sha256: loaded.sha256 });
    if (decision === 'not_builtin') {
      console.error(`${LOG} the built-in rule-set id is held by a non-built-in row; refusing to touch it`, ctx);
      return 'skipped';
    }
    if (decision === 'same_version_conflict') {
      console.warn(`${LOG} pack has the same version as the published built-in set but different bytes; keeping the published one (bump pack.lock version)`, ctx);
      return kept;
    }
    if (decision === 'older') {
      console.warn(`${LOG} pack is older than the published built-in set; keeping the newer one (a release rollback never downgrades it)`, {
        ...ctx,
        publishedVersion: row?.publishedVersion,
      });
      return kept;
    }
    if (decision === 'current') return kept;

    const check = await precheckYaraBundle(pack.json, { timeoutMs: BUILTIN_PACK_PRECHECK_TIMEOUT_MS });
    let engine: string | null = null;
    let policy: number | null = null;
    if (check.ok) {
      const v = await yaracVersion();
      if (!v) console.warn(`${LOG} breeze-yarac version probe failed after a clean pre-check; publishing without an engine stamp`, ctx);
      engine = v?.engine ?? null;
      policy = v?.policy ?? null;
    } else if ('errors' in check) {
      console.error(`${LOG} pre-check rejected the shipped pack; built-in set left on its published version`, {
        ...ctx,
        errorCount: check.errors.length,
        errors: check.errors.slice(0, 5).map((e) => `${e.name || '(bundle)'}: ${e.code}: ${e.message.slice(0, 200)}`),
      });
      return 'skipped';
    } else if (yaraLintOnlyAllowed()) {
      console.warn(`${LOG} pre-check unavailable (${check.unavailable}); publishing lint-only (dev/test BREEZE_YARA_LINT_ONLY=1)`, ctx);
      engine = 'lint-only';
    } else {
      console.error(`${LOG} pre-check unavailable (${check.unavailable}); refusing to publish the built-in pack`, ctx);
      return 'skipped';
    }

    const applied = await applyBuiltinPack(
      { bytes: loaded.bytes, sha256: loaded.sha256, version: pack.version, rules: pack.rules, engine, policy },
      // Re-decided inside the advisory lock: another replica may have won.
      (row) => decideBuiltinPackAction(row, { version: pack.version, sha256: loaded.sha256 }),
    );
    if (!applied.applied) {
      if (applied.decision === 'not_builtin') {
        console.error(`${LOG} the built-in rule-set id is held by a non-built-in row; refusing to touch it`, ctx);
        return 'skipped';
      }
      return 'unchanged';
    }
    console.log(`${LOG} published built-in pack v${pack.version} (${pack.rules.length} rules)`, ctx);
    return 'updated';
  } catch (err) {
    console.error(`${LOG} built-in pack sync skipped; the published built-in set is unchanged: ${errMessage(err)}`);
    return 'skipped';
  }
}
