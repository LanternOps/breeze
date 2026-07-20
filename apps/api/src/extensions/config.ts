import { readFileSync } from 'node:fs';
import path from 'node:path';
import { load as loadYaml } from 'js-yaml';
import { z } from 'zod';
import { canonicalNodeEnv } from '../config/normalizeNodeEnv';

/**
 * Deployment configuration for signed runtime extensions (`extensions.yaml`).
 *
 * This module is a trust boundary: it decides which signed artifacts the stock
 * Breeze API image is willing to install and which publishers are trusted to
 * sign them. Two entry points:
 *
 *  - {@link parseExtensionDeploymentConfig} — the pure core. Strict validation
 *    of YAML text against explicit rules, parameterized by whether we run in
 *    production and whether unsigned extensions are permitted. No I/O, no env.
 *  - {@link loadExtensionDeploymentConfig} — the file wrapper. Reads the file,
 *    derives `production`/`allowUnsigned` from the environment, resolves public
 *    key paths relative to the config file, then delegates to the core.
 *
 * Nothing here logs file contents, config values, or raw parser exceptions.
 */

/** A pinned artifact digest: `sha256:` followed by 64 lowercase hex chars. */
export type ArtifactDigest = `sha256:${string}`;

export interface ExtensionSelection {
  name: string;
  uri: string;
  version?: string;
  digest?: ArtifactDigest;
  publisher: string;
  required: boolean;
  rollout: 'rolling' | 'replace';
}

export interface ExtensionDeploymentConfig {
  publishers: Record<string, { publicKeyFile: string }>;
  extensions: ExtensionSelection[];
}

export interface ExtensionDeploymentConfigOptions {
  /** Whether the host is running in production (stricter trust rules apply). */
  production: boolean;
  /** Whether unsigned extensions are permitted (development escape hatch). */
  allowUnsigned: boolean;
}

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const NAME_RE = /^[a-z][a-z0-9-]{1,31}$/;

const nonemptyString = z.string().trim().min(1);

const publisherSchema = z.object({
  publicKeyFile: nonemptyString,
}).strict();

// The base structural schema keeps `publisher` and `digest` lenient so that the
// semantic pass below can emit precise, context-aware messages (e.g. surfacing
// the missing-digest rule even when the publisher is also absent) instead of a
// generic "required" error masking the security-relevant one.
const selectionSchema = z.object({
  name: z.string().regex(NAME_RE, 'extension name must be a lowercase kebab-case identifier'),
  uri: nonemptyString,
  version: nonemptyString.optional(),
  digest: z.string().optional(),
  publisher: nonemptyString.optional(),
  required: z.boolean().default(false),
  rollout: z.enum(['rolling', 'replace']).default('rolling'),
}).strict();

const deploymentSchema = z.object({
  publishers: z.record(z.string().regex(NAME_RE), publisherSchema).default({}),
  extensions: z.array(selectionSchema).default([]),
}).strict();

type ParsedDeployment = z.infer<typeof deploymentSchema>;

function structuralParse(yamlText: string): ParsedDeployment {
  let raw: unknown;
  try {
    raw = loadYaml(yamlText);
  } catch {
    // Never surface the raw parser exception (it can echo file contents).
    throw new Error('extensions.yaml is not valid YAML');
  }
  try {
    return deploymentSchema.parse(raw ?? {});
  } catch (error) {
    if (error instanceof z.ZodError) throw new Error(z.prettifyError(error));
    throw error;
  }
}

/**
 * Pure core: validate deployment configuration YAML under the given trust mode.
 * Throws an Error whose message contains every violation (never file contents).
 */
export function parseExtensionDeploymentConfig(
  yamlText: string,
  opts: ExtensionDeploymentConfigOptions,
): ExtensionDeploymentConfig {
  // Fail closed before touching the document: unsigned mode is never allowed in
  // production, regardless of what the file says.
  if (opts.production && opts.allowUnsigned) {
    throw new Error(
      'BREEZE_EXTENSIONS_ALLOW_UNSIGNED=true is not permitted when NODE_ENV normalizes to production',
    );
  }

  const parsed = structuralParse(yamlText);
  const errors: string[] = [];
  const seenNames = new Set<string>();

  for (const selection of parsed.extensions) {
    const label = `extension "${selection.name}"`;

    if (seenNames.has(selection.name)) {
      errors.push(`${label}: duplicate extension name (names must be unique)`);
    }
    seenNames.add(selection.name);

    if (!selection.publisher) {
      errors.push(`${label}: a publisher is required`);
    } else if (!Object.prototype.hasOwnProperty.call(parsed.publishers, selection.publisher)) {
      // hasOwnProperty, not `in`: `in` walks the prototype chain, so a publisher
      // named "constructor"/"toString"/"__proto__" would spuriously validate as
      // "declared" against an inherited Object.prototype member.
      errors.push(`${label}: publisher "${selection.publisher}" is not declared in the publishers map`);
    }

    if (selection.digest !== undefined && !DIGEST_RE.test(selection.digest)) {
      errors.push(`${label}: digest must be "sha256:" followed by 64 lowercase hex characters`);
    }

    if (opts.production && selection.digest === undefined) {
      errors.push(`${label}: a sha256: digest is required in production`);
    }

    if (selection.version === undefined && selection.digest === undefined) {
      errors.push(`${label}: a version or a digest is required to select an artifact`);
    }
  }

  if (errors.length > 0) {
    throw new Error(errors.join('; '));
  }

  const extensions: ExtensionSelection[] = parsed.extensions.map((selection) => Object.freeze({
    name: selection.name,
    uri: selection.uri,
    ...(selection.version !== undefined ? { version: selection.version } : {}),
    ...(selection.digest !== undefined ? { digest: selection.digest as ArtifactDigest } : {}),
    // publisher is guaranteed present here (validated above).
    publisher: selection.publisher as string,
    required: selection.required,
    rollout: selection.rollout,
  }));

  return Object.freeze({
    publishers: Object.freeze({ ...parsed.publishers }),
    extensions: Object.freeze(extensions) as unknown as ExtensionSelection[],
  });
}

/**
 * File wrapper: read the config file, derive the trust mode from the process
 * environment, resolve public key paths relative to the config file directory,
 * and delegate to {@link parseExtensionDeploymentConfig}.
 */
export function loadExtensionDeploymentConfig(configPath: string): ExtensionDeploymentConfig {
  const resolvedPath = path.resolve(configPath);
  const yamlText = readFileSync(resolvedPath, 'utf8');

  // An UNKNOWN NODE_ENV can never reach here and quietly canonicalize to
  // non-production: `validateConfig()` (validate.ts, a `z.enum` over the allowed
  // values) runs at index.ts startup BEFORE `reconcileExtensions`, so a typo'd
  // NODE_ENV aborts boot rather than downgrading this trust decision.
  const production = canonicalNodeEnv(process.env.NODE_ENV ?? 'development') === 'production';
  const allowUnsigned = process.env.BREEZE_EXTENSIONS_ALLOW_UNSIGNED === 'true';

  const config = parseExtensionDeploymentConfig(yamlText, { production, allowUnsigned });

  const baseDir = path.dirname(resolvedPath);
  const publishers: Record<string, { publicKeyFile: string }> = {};
  for (const [id, publisher] of Object.entries(config.publishers)) {
    publishers[id] = Object.freeze({
      publicKeyFile: path.resolve(baseDir, publisher.publicKeyFile),
    });
  }

  return Object.freeze({
    publishers: Object.freeze(publishers),
    extensions: config.extensions,
  });
}
