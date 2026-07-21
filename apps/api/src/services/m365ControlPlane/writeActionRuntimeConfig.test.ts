import {
  chmodSync,
  constants,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isM365GraphActionsEnabledForOrg,
  loadM365CustomerGraphActionsRuntimeConfig,
  validateM365CustomerGraphActionsRuntimeConfigAtBoot,
} from './writeActionRuntimeConfig';

vi.mock('node:fs', { spy: true });

const ORG_ID = '44444444-4444-4444-8444-444444444444';
const OTHER_ORG_ID = '55555555-5555-4555-8555-555555555555';
const CLIENT_ID = 'c3333333-3333-4333-8333-333333333333';
const CREDENTIAL_VERSION = '0123456789abcdef0123456789abcdef';
const REQUIRED_ENABLED_SETTINGS = [
  'M365_CUSTOMER_GRAPH_ACTIONS_CLIENT_ID',
  'M365_CUSTOMER_GRAPH_ACTIONS_VAULT_REF',
  'M365_CUSTOMER_GRAPH_ACTIONS_CREDENTIAL_VERSION',
  'M365_GRAPH_ACTIONS_EXECUTOR_URL',
  'M365_GRAPH_ACTIONS_EXECUTOR_AUDIENCE',
  'M365_GRAPH_ACTIONS_EXECUTOR_SIGNING_PRIVATE_JWK_FILE',
  'M365_GRAPH_ACTIONS_EXECUTOR_SIGNING_KID',
] as const;

let tempDir: string;
let signingJwkFile: string;

function validPrivateJwk() {
  return {
    kty: 'OKP',
    crv: 'Ed25519',
    alg: 'EdDSA',
    use: 'sig',
    kid: 'graph-actions-api-1',
    x: Buffer.alloc(32, 1).toString('base64url'),
    d: Buffer.alloc(32, 2).toString('base64url'),
  };
}

function writeSigningJwk(value: unknown = validPrivateJwk(), mode = 0o600): string {
  writeFileSync(signingJwkFile, JSON.stringify(value), { mode: 0o600 });
  chmodSync(signingJwkFile, mode);
  return signingJwkFile;
}

function validEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    NODE_ENV: 'production',
    M365_CUSTOMER_GRAPH_ACTIONS_CLIENT_ID: CLIENT_ID,
    M365_CUSTOMER_GRAPH_ACTIONS_VAULT_REF:
      `akv://customer-vault.vault.azure.net/m365-customer-graph-actions/${CREDENTIAL_VERSION}`,
    M365_CUSTOMER_GRAPH_ACTIONS_CREDENTIAL_VERSION: CREDENTIAL_VERSION,
    M365_GRAPH_ACTIONS_EXECUTOR_URL: 'https://m365-graph-actions.internal.example.test',
    M365_GRAPH_ACTIONS_EXECUTOR_AUDIENCE: 'm365-graph-actions-executor',
    M365_GRAPH_ACTIONS_EXECUTOR_SIGNING_PRIVATE_JWK_FILE: signingJwkFile,
    M365_GRAPH_ACTIONS_EXECUTOR_SIGNING_KID: 'graph-actions-api-1',
    ...overrides,
  };
}

describe('M365 customer Graph-actions runtime config', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'breeze-m365-actions-runtime-'));
    signingJwkFile = join(tempDir, 'executor-signing.jwk');
    writeSigningJwk();
    vi.clearAllMocks();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('loads the fixed non-secret descriptor and file-backed API signing key', () => {
    const config = loadM365CustomerGraphActionsRuntimeConfig(validEnv());

    expect(config).toMatchObject({
      clientId: CLIENT_ID,
      vaultRef: `akv://customer-vault.vault.azure.net/m365-customer-graph-actions/${CREDENTIAL_VERSION}`,
      credentialVersion: CREDENTIAL_VERSION,
      executorUrl: 'https://m365-graph-actions.internal.example.test',
      executorAudience: 'm365-graph-actions-executor',
      executorSigningKid: 'graph-actions-api-1',
    });
    expect(config.executorSigningPrivateJwk).toEqual(validPrivateJwk());
    expect(config).not.toHaveProperty('callbackUrl');
    expect(config).not.toHaveProperty('onboardingOrgIds');
    expect(config).not.toHaveProperty('certificate');
    expect(config).not.toHaveProperty('vaultCredential');
  });

  it('opens without following symlinks and validates, reads, and closes the same file descriptor', () => {
    loadM365CustomerGraphActionsRuntimeConfig(validEnv());

    expect(fs.openSync).toHaveBeenCalledWith(
      signingJwkFile,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const fd = vi.mocked(fs.openSync).mock.results[0]?.value;
    expect(fd).toEqual(expect.any(Number));
    expect(fs.fstatSync).toHaveBeenCalledWith(fd);
    expect(fs.readFileSync).toHaveBeenCalledWith(fd, 'utf8');
    expect(fs.closeSync).toHaveBeenCalledWith(fd);
  });

  it.each(REQUIRED_ENABLED_SETTINGS)(
    'requires %s',
    (name) => {
      expect(() => loadM365CustomerGraphActionsRuntimeConfig(validEnv({
        [name]: undefined,
      }))).toThrow(name);
    },
  );

  it.each([
    ['uppercase client UUID', { M365_CUSTOMER_GRAPH_ACTIONS_CLIENT_ID: CLIENT_ID.toUpperCase() }, /CLIENT_ID/],
    ['non-canonical client UUID', { M365_CUSTOMER_GRAPH_ACTIONS_CLIENT_ID: CLIENT_ID.replaceAll('-', '') }, /CLIENT_ID/],
    ['wrong vault profile path', { M365_CUSTOMER_GRAPH_ACTIONS_VAULT_REF: `akv://customer-vault.vault.azure.net/other/${CREDENTIAL_VERSION}` }, /VAULT_REF/],
    ['non-hex credential version', { M365_CUSTOMER_GRAPH_ACTIONS_CREDENTIAL_VERSION: 'version-1' }, /CREDENTIAL_VERSION/],
    ['mismatched vault version', { M365_CUSTOMER_GRAPH_ACTIONS_CREDENTIAL_VERSION: 'f'.repeat(32) }, /VAULT_REF.*CREDENTIAL_VERSION|CREDENTIAL_VERSION.*VAULT_REF/],
    ['non-HTTPS executor URL', { M365_GRAPH_ACTIONS_EXECUTOR_URL: 'http://m365-graph-actions.internal.example.test' }, /EXECUTOR_URL/],
    ['executor base path', { M365_GRAPH_ACTIONS_EXECUTOR_URL: 'https://m365-graph-actions.internal.example.test/internal' }, /EXECUTOR_URL/],
    ['executor trailing path', { M365_GRAPH_ACTIONS_EXECUTOR_URL: 'https://m365-graph-actions.internal.example.test/v1/' }, /EXECUTOR_URL/],
    ['executor repeated slash path', { M365_GRAPH_ACTIONS_EXECUTOR_URL: 'https://m365-graph-actions.internal.example.test//' }, /EXECUTOR_URL/],
    ['executor query', { M365_GRAPH_ACTIONS_EXECUTOR_URL: 'https://m365-graph-actions.internal.example.test/?route=other' }, /EXECUTOR_URL/],
    ['executor fragment', { M365_GRAPH_ACTIONS_EXECUTOR_URL: 'https://m365-graph-actions.internal.example.test/#other' }, /EXECUTOR_URL/],
    ['executor credentials', { M365_GRAPH_ACTIONS_EXECUTOR_URL: 'https://user:password@m365-graph-actions.internal.example.test/' }, /EXECUTOR_URL/],
    ['wrong executor audience', { M365_GRAPH_ACTIONS_EXECUTOR_AUDIENCE: 'another-service' }, /EXECUTOR_AUDIENCE/],
    ['empty signing kid', { M365_GRAPH_ACTIONS_EXECUTOR_SIGNING_KID: ' ' }, /SIGNING_KID/],
  ])('rejects %s', (_label, overrides, error) => {
    expect(() => loadM365CustomerGraphActionsRuntimeConfig(validEnv(overrides))).toThrow(error);
  });

  it('stores the executor as a normalized HTTPS origin with no path suffix', () => {
    const config = loadM365CustomerGraphActionsRuntimeConfig(validEnv({
      M365_GRAPH_ACTIONS_EXECUTOR_URL: 'https://M365-GRAPH-ACTIONS.INTERNAL.EXAMPLE.TEST:443/',
    }));

    expect(config.executorUrl).toBe('https://m365-graph-actions.internal.example.test');
  });

  it('requires an absolute signing JWK file path', () => {
    expect(() => loadM365CustomerGraphActionsRuntimeConfig(validEnv({
      M365_GRAPH_ACTIONS_EXECUTOR_SIGNING_PRIVATE_JWK_FILE: './executor-signing.jwk',
    }))).toThrow(/SIGNING_PRIVATE_JWK_FILE.*absolute/);
  });

  it('rejects a signing JWK file readable by group or other users', () => {
    writeSigningJwk(validPrivateJwk(), 0o640);

    expect(() => loadM365CustomerGraphActionsRuntimeConfig(validEnv())).toThrow(
      /SIGNING_PRIVATE_JWK_FILE.*permissions|permissions.*SIGNING_PRIVATE_JWK_FILE/,
    );
    const fd = vi.mocked(fs.openSync).mock.results[0]?.value;
    expect(fs.closeSync).toHaveBeenCalledWith(fd);
  });

  it('rejects a symlink without following it', () => {
    const symlink = join(tempDir, 'signing-link.jwk');
    symlinkSync(signingJwkFile, symlink);

    expect(() => loadM365CustomerGraphActionsRuntimeConfig(validEnv({
      M365_GRAPH_ACTIONS_EXECUTOR_SIGNING_PRIVATE_JWK_FILE: symlink,
    }))).toThrow(/SIGNING_PRIVATE_JWK_FILE/);
    expect(fs.fstatSync).not.toHaveBeenCalled();
    expect(fs.readFileSync).not.toHaveBeenCalled();
  });

  it('rejects a non-regular signing JWK file', () => {
    expect(() => loadM365CustomerGraphActionsRuntimeConfig(validEnv({
      M365_GRAPH_ACTIONS_EXECUTOR_SIGNING_PRIVATE_JWK_FILE: tempDir,
    }))).toThrow(/SIGNING_PRIVATE_JWK_FILE.*regular file/);
  });

  it('rejects malformed signing JWK JSON', () => {
    writeFileSync(signingJwkFile, '{not-json', { mode: 0o600 });

    expect(() => loadM365CustomerGraphActionsRuntimeConfig(validEnv())).toThrow(
      /SIGNING_PRIVATE_JWK_FILE.*valid JWK JSON/,
    );
  });

  it.each([
    ['public-only JWK', () => ({ ...validPrivateJwk(), d: undefined })],
    ['wrong curve', () => ({ ...validPrivateJwk(), crv: 'X25519' })],
    ['mismatched kid', () => ({ ...validPrivateJwk(), kid: 'other-kid' })],
  ])('rejects a %s in the signing file', (_label, makeJwk) => {
    writeSigningJwk(makeJwk());
    expect(() => loadM365CustomerGraphActionsRuntimeConfig(validEnv())).toThrow(
      /SIGNING_PRIVATE_JWK_FILE|SIGNING_KID/,
    );
  });

  describe('validateM365CustomerGraphActionsRuntimeConfigAtBoot', () => {
    it('is a no-op when the tools flag is disabled', () => {
      expect(() => validateM365CustomerGraphActionsRuntimeConfigAtBoot({
        M365_GRAPH_ACTIONS_TOOLS_ENABLED: 'false',
      })).not.toThrow();
      expect(fs.openSync).not.toHaveBeenCalled();
    });

    it('loads the full executor config when the tools flag is enabled', () => {
      const env = validEnv({
        M365_GRAPH_ACTIONS_TOOLS_ENABLED: 'true',
        M365_GRAPH_ACTIONS_TOOLS_ORG_IDS: ORG_ID,
      });
      expect(() => validateM365CustomerGraphActionsRuntimeConfigAtBoot(env)).not.toThrow();
      expect(() => validateM365CustomerGraphActionsRuntimeConfigAtBoot({
        ...env,
        M365_CUSTOMER_GRAPH_ACTIONS_CLIENT_ID: undefined,
      })).toThrow(/CLIENT_ID/);
    });

    it('throws at boot when the tools flag is enabled without an org allowlist configured', () => {
      const env = validEnv({
        M365_GRAPH_ACTIONS_TOOLS_ENABLED: 'true',
        M365_GRAPH_ACTIONS_TOOLS_ORG_IDS: undefined,
      });
      expect(() => validateM365CustomerGraphActionsRuntimeConfigAtBoot(env)).toThrow(
        /M365_GRAPH_ACTIONS_TOOLS_ORG_IDS is required/,
      );
    });

    it('throws at boot when the tools allowlist contains a malformed org id', () => {
      const env = validEnv({
        M365_GRAPH_ACTIONS_TOOLS_ENABLED: 'true',
        M365_GRAPH_ACTIONS_TOOLS_ORG_IDS: `${ORG_ID},not-a-uuid`,
      });
      expect(() => validateM365CustomerGraphActionsRuntimeConfigAtBoot(env)).toThrow(
        /M365_GRAPH_ACTIONS_TOOLS_ORG_IDS must be literal \* or comma-separated canonical UUIDs/,
      );
    });
  });
});

describe('isM365GraphActionsEnabledForOrg', () => {
  it('is false when the flag is off', () => {
    expect(isM365GraphActionsEnabledForOrg(ORG_ID, { M365_GRAPH_ACTIONS_TOOLS_ENABLED: 'false' })).toBe(false);
    expect(isM365GraphActionsEnabledForOrg(ORG_ID, {})).toBe(false);
  });

  it('is true for a listed org when enabled', () => {
    expect(isM365GraphActionsEnabledForOrg(ORG_ID, {
      M365_GRAPH_ACTIONS_TOOLS_ENABLED: 'true',
      M365_GRAPH_ACTIONS_TOOLS_ORG_IDS: ORG_ID,
    })).toBe(true);
  });

  it('is true for any org with wildcard', () => {
    expect(isM365GraphActionsEnabledForOrg(ORG_ID, {
      M365_GRAPH_ACTIONS_TOOLS_ENABLED: 'true',
      M365_GRAPH_ACTIONS_TOOLS_ORG_IDS: '*',
    })).toBe(true);
  });

  it('is false for an unlisted org', () => {
    expect(isM365GraphActionsEnabledForOrg(ORG_ID, {
      M365_GRAPH_ACTIONS_TOOLS_ENABLED: 'true',
      M365_GRAPH_ACTIONS_TOOLS_ORG_IDS: OTHER_ORG_ID,
    })).toBe(false);
  });

  it('rejects a non-canonical org id even with a star allowlist', () => {
    expect(isM365GraphActionsEnabledForOrg('not-a-uuid', {
      M365_GRAPH_ACTIONS_TOOLS_ENABLED: 'true',
      M365_GRAPH_ACTIONS_TOOLS_ORG_IDS: '*',
    })).toBe(false);
  });

  it('throws when enabled without an org allowlist configured', () => {
    expect(() => isM365GraphActionsEnabledForOrg(ORG_ID, {
      M365_GRAPH_ACTIONS_TOOLS_ENABLED: 'true',
    })).toThrow(/M365_GRAPH_ACTIONS_TOOLS_ORG_IDS is required/);
  });

  it('never requires executor settings to evaluate (no executor envs provided)', () => {
    expect(() => isM365GraphActionsEnabledForOrg(ORG_ID, {
      M365_GRAPH_ACTIONS_TOOLS_ENABLED: 'true',
      M365_GRAPH_ACTIONS_TOOLS_ORG_IDS: ORG_ID,
    })).not.toThrow();
  });
});
