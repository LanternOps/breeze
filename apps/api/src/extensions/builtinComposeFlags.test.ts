import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { builtinEnableFlags } from './builtinExtensions';
import { BUILTINS } from './builtinRegistry';

// apps/api/src/extensions -> repo root is 4 levels up.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

/**
 * Compose interpolates ONLY the variables the API service's environment block
 * names — a flag set in `.env` alone never reaches the container. So every
 * built-in enable flag, canonical name AND alias (Wisp W08:
 * BREEZE_WISP_CONNECTOR_ENABLED), must be mapped in both runtime composes, or
 * the alias documented in .env.example silently switches nothing.
 */
const RUNTIME_COMPOSE_FILES = ['docker-compose.yml', 'deploy/docker-compose.prod.yml'];

describe('built-in enable flags reach the API container', () => {
  const flags = BUILTINS.flatMap((builtin) => builtinEnableFlags(builtin));

  it('covers the canonical flag and the Wisp connector alias', () => {
    expect(flags).toEqual(expect.arrayContaining(['BREEZE_WORKSPACE_ENABLED', 'BREEZE_WISP_CONNECTOR_ENABLED']));
  });

  it.each(RUNTIME_COMPOSE_FILES)('%s maps every built-in enable flag, defaulting off', (file) => {
    const compose = readFileSync(path.join(REPO_ROOT, file), 'utf8');
    for (const flag of flags) {
      expect(compose, `${file} must map ${flag}`).toContain(`${flag}: \${${flag}:-false}`);
    }
  });
});
