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
  isM365CustomerGraphReadOnboardingEnabledForOrg,
  isM365GraphReadToolsEnabledForOrg,
  loadM365CustomerGraphReadRuntimeConfig,
  validateM365CustomerGraphReadRuntimeConfigAtBoot,
} from './runtimeConfig';

vi.mock('node:fs', { spy: true });

const ORG_ID = 'a1111111-1111-4111-8111-111111111111';
const OTHER_ORG_ID = 'b2222222-2222-4222-8222-222222222222';
const CLIENT_ID = 'c3333333-3333-4333-8333-333333333333';
const CREDENTIAL_VERSION = '0123456789abcdef0123456789abcdef';
const REQUIRED_ENABLED_SETTINGS = [
  'M365_CUSTOMER_GRAPH_READ_CLIENT_ID',
  'M365_CUSTOMER_GRAPH_READ_VAULT_REF',
  'M365_CUSTOMER_GRAPH_READ_CREDENTIAL_VERSION',
  'M365_CUSTOMER_GRAPH_READ_ONBOARDING_ORG_IDS',
  'M365_GRAPH_READ_EXECUTOR_URL',
  'M365_GRAPH_READ_EXECUTOR_AUDIENCE',
  'M365_GRAPH_READ_EXECUTOR_SIGNING_PRIVATE_JWK_FILE',
  'M365_GRAPH_READ_EXECUTOR_SIGNING_KID',
] as const;

let tempDir: string;
let signingJwkFile: string;

function validPrivateJwk() {
  return {
    kty: 'OKP',
    crv: 'Ed25519',
    alg: 'EdDSA',
    use: 'sig',
    kid: 'graph-read-api-1',
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
    PUBLIC_URL: 'https://console.example.test/app/path',
    M365_CUSTOMER_GRAPH_READ_ONBOARDING_ENABLED: 'true',
    M365_CUSTOMER_GRAPH_READ_CLIENT_ID: CLIENT_ID,
    M365_CUSTOMER_GRAPH_READ_VAULT_REF:
      `akv://customer-vault.vault.azure.net/m365-customer-graph-read/${CREDENTIAL_VERSION}`,
    M365_CUSTOMER_GRAPH_READ_CREDENTIAL_VERSION: CREDENTIAL_VERSION,
    M365_CUSTOMER_GRAPH_READ_ONBOARDING_ORG_IDS: ORG_ID,
    M365_GRAPH_READ_EXECUTOR_URL: 'https://m365-graph-read.internal.example.test',
    M365_GRAPH_READ_EXECUTOR_AUDIENCE: 'm365-graph-read-executor',
    M365_GRAPH_READ_EXECUTOR_SIGNING_PRIVATE_JWK_FILE: signingJwkFile,
    M365_GRAPH_READ_EXECUTOR_SIGNING_KID: 'graph-read-api-1',
    ...overrides,
  };
}

describe('M365 customer Graph-read runtime config', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'breeze-m365-runtime-'));
    signingJwkFile = join(tempDir, 'executor-signing.jwk');
    writeSigningJwk();
    vi.clearAllMocks();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('loads the fixed non-secret descriptor and file-backed API signing key', () => {
    const config = loadM365CustomerGraphReadRuntimeConfig(validEnv());

    expect(config).toMatchObject({
      clientId: CLIENT_ID,
      vaultRef: `akv://customer-vault.vault.azure.net/m365-customer-graph-read/${CREDENTIAL_VERSION}`,
      credentialVersion: CREDENTIAL_VERSION,
      callbackUrl: 'https://console.example.test/api/v1/m365/consent/callback',
      executorUrl: 'https://m365-graph-read.internal.example.test',
      executorAudience: 'm365-graph-read-executor',
      executorSigningKid: 'graph-read-api-1',
      onboardingOrgIds: [ORG_ID],
    });
    expect(config.executorSigningPrivateJwk).toEqual(validPrivateJwk());
    expect(config).not.toHaveProperty('certificate');
    expect(config).not.toHaveProperty('vaultCredential');
  });

  it('opens without following symlinks and validates, reads, and closes the same file descriptor', () => {
    loadM365CustomerGraphReadRuntimeConfig(validEnv());

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

  it.each([
    [{ PUBLIC_URL: 'https://public.example.test/base', PUBLIC_APP_URL: 'https://app.example.test', PUBLIC_API_URL: 'https://api.example.test' }, 'https://public.example.test/api/v1/m365/consent/callback'],
    [{ PUBLIC_URL: '', PUBLIC_APP_URL: 'https://app.example.test/base', PUBLIC_API_URL: 'https://api.example.test' }, 'https://app.example.test/api/v1/m365/consent/callback'],
    [{ PUBLIC_URL: '', PUBLIC_APP_URL: '', PUBLIC_API_URL: 'https://api.example.test/base' }, 'https://api.example.test/api/v1/m365/consent/callback'],
  ])('uses the required callback-origin precedence', (origins, expected) => {
    expect(loadM365CustomerGraphReadRuntimeConfig(validEnv(origins)).callbackUrl).toBe(expected);
  });

  it('has no localhost callback fallback in production', () => {
    expect(() => loadM365CustomerGraphReadRuntimeConfig(validEnv({
      PUBLIC_URL: '',
      PUBLIC_APP_URL: '',
      PUBLIC_API_URL: '',
    }))).toThrow(/PUBLIC_URL.*PUBLIC_APP_URL.*PUBLIC_API_URL/);
  });

  it('uses the API localhost callback fallback outside production', () => {
    const config = loadM365CustomerGraphReadRuntimeConfig(validEnv({
      NODE_ENV: 'development',
      PUBLIC_URL: '',
      PUBLIC_APP_URL: '',
      PUBLIC_API_URL: '',
    }));
    expect(config.callbackUrl).toBe('http://localhost:3001/api/v1/m365/consent/callback');
  });

  it.each(REQUIRED_ENABLED_SETTINGS)(
    'requires %s when onboarding is enabled',
    (name) => {
      expect(() => loadM365CustomerGraphReadRuntimeConfig(validEnv({
        [name]: undefined,
      }))).toThrow(name);
    },
  );

  it.each([
    ['uppercase client UUID', { M365_CUSTOMER_GRAPH_READ_CLIENT_ID: CLIENT_ID.toUpperCase() }, /CLIENT_ID/],
    ['non-canonical client UUID', { M365_CUSTOMER_GRAPH_READ_CLIENT_ID: CLIENT_ID.replaceAll('-', '') }, /CLIENT_ID/],
    ['wrong vault profile path', { M365_CUSTOMER_GRAPH_READ_VAULT_REF: `akv://customer-vault.vault.azure.net/other/${CREDENTIAL_VERSION}` }, /VAULT_REF/],
    ['non-hex credential version', { M365_CUSTOMER_GRAPH_READ_CREDENTIAL_VERSION: 'version-1' }, /CREDENTIAL_VERSION/],
    ['mismatched vault version', { M365_CUSTOMER_GRAPH_READ_CREDENTIAL_VERSION: 'f'.repeat(32) }, /VAULT_REF.*CREDENTIAL_VERSION|CREDENTIAL_VERSION.*VAULT_REF/],
    ['non-HTTPS executor URL', { M365_GRAPH_READ_EXECUTOR_URL: 'http://m365-graph-read.internal.example.test' }, /EXECUTOR_URL/],
    ['executor base path', { M365_GRAPH_READ_EXECUTOR_URL: 'https://m365-graph-read.internal.example.test/internal' }, /EXECUTOR_URL/],
    ['executor trailing path', { M365_GRAPH_READ_EXECUTOR_URL: 'https://m365-graph-read.internal.example.test/v1/' }, /EXECUTOR_URL/],
    ['executor repeated slash path', { M365_GRAPH_READ_EXECUTOR_URL: 'https://m365-graph-read.internal.example.test//' }, /EXECUTOR_URL/],
    ['executor query', { M365_GRAPH_READ_EXECUTOR_URL: 'https://m365-graph-read.internal.example.test/?route=other' }, /EXECUTOR_URL/],
    ['executor fragment', { M365_GRAPH_READ_EXECUTOR_URL: 'https://m365-graph-read.internal.example.test/#other' }, /EXECUTOR_URL/],
    ['executor credentials', { M365_GRAPH_READ_EXECUTOR_URL: 'https://user:password@m365-graph-read.internal.example.test/' }, /EXECUTOR_URL/],
    ['wrong executor audience', { M365_GRAPH_READ_EXECUTOR_AUDIENCE: 'another-service' }, /EXECUTOR_AUDIENCE/],
    ['empty signing kid', { M365_GRAPH_READ_EXECUTOR_SIGNING_KID: ' ' }, /SIGNING_KID/],
  ])('rejects %s', (_label, overrides, error) => {
    expect(() => loadM365CustomerGraphReadRuntimeConfig(validEnv(overrides))).toThrow(error);
  });

  it('stores the executor as a normalized HTTPS origin with no path suffix', () => {
    const config = loadM365CustomerGraphReadRuntimeConfig(validEnv({
      M365_GRAPH_READ_EXECUTOR_URL: 'https://M365-GRAPH-READ.INTERNAL.EXAMPLE.TEST:443/',
    }));

    expect(config.executorUrl).toBe('https://m365-graph-read.internal.example.test');
  });

  it('requires an absolute signing JWK file path', () => {
    expect(() => loadM365CustomerGraphReadRuntimeConfig(validEnv({
      M365_GRAPH_READ_EXECUTOR_SIGNING_PRIVATE_JWK_FILE: './executor-signing.jwk',
    }))).toThrow(/SIGNING_PRIVATE_JWK_FILE.*absolute/);
  });

  it('rejects a signing JWK file readable by group or other users', () => {
    writeSigningJwk(validPrivateJwk(), 0o640);

    expect(() => loadM365CustomerGraphReadRuntimeConfig(validEnv())).toThrow(
      /SIGNING_PRIVATE_JWK_FILE.*permissions|permissions.*SIGNING_PRIVATE_JWK_FILE/,
    );
    const fd = vi.mocked(fs.openSync).mock.results[0]?.value;
    expect(fs.closeSync).toHaveBeenCalledWith(fd);
  });

  it('rejects a symlink without following it', () => {
    const symlink = join(tempDir, 'signing-link.jwk');
    symlinkSync(signingJwkFile, symlink);

    expect(() => loadM365CustomerGraphReadRuntimeConfig(validEnv({
      M365_GRAPH_READ_EXECUTOR_SIGNING_PRIVATE_JWK_FILE: symlink,
    }))).toThrow(/SIGNING_PRIVATE_JWK_FILE/);
    expect(fs.fstatSync).not.toHaveBeenCalled();
    expect(fs.readFileSync).not.toHaveBeenCalled();
  });

  it('rejects a non-regular signing JWK file', () => {
    expect(() => loadM365CustomerGraphReadRuntimeConfig(validEnv({
      M365_GRAPH_READ_EXECUTOR_SIGNING_PRIVATE_JWK_FILE: tempDir,
    }))).toThrow(/SIGNING_PRIVATE_JWK_FILE.*regular file/);
  });

  it('rejects malformed signing JWK JSON', () => {
    writeFileSync(signingJwkFile, '{not-json', { mode: 0o600 });

    expect(() => loadM365CustomerGraphReadRuntimeConfig(validEnv())).toThrow(
      /SIGNING_PRIVATE_JWK_FILE.*valid JWK JSON/,
    );
  });

  it.each([
    ['public-only JWK', () => ({ ...validPrivateJwk(), d: undefined })],
    ['wrong curve', () => ({ ...validPrivateJwk(), crv: 'X25519' })],
    ['mismatched kid', () => ({ ...validPrivateJwk(), kid: 'other-kid' })],
  ])('rejects a %s in the signing file', (_label, makeJwk) => {
    writeSigningJwk(makeJwk());
    expect(() => loadM365CustomerGraphReadRuntimeConfig(validEnv())).toThrow(
      /SIGNING_PRIVATE_JWK_FILE|SIGNING_KID/,
    );
  });

  it('matches onboarding only when the global flag and canonical org allowlist both match', () => {
    expect(isM365CustomerGraphReadOnboardingEnabledForOrg(ORG_ID, validEnv())).toBe(true);
    expect(isM365CustomerGraphReadOnboardingEnabledForOrg(OTHER_ORG_ID, validEnv())).toBe(false);
    expect(isM365CustomerGraphReadOnboardingEnabledForOrg(ORG_ID, validEnv({
      M365_CUSTOMER_GRAPH_READ_ONBOARDING_ENABLED: 'false',
    }))).toBe(false);
    expect(isM365CustomerGraphReadOnboardingEnabledForOrg(ORG_ID.toUpperCase(), validEnv())).toBe(false);
  });

  it('supports only literal star or comma-separated canonical org UUIDs', () => {
    expect(isM365CustomerGraphReadOnboardingEnabledForOrg(OTHER_ORG_ID, validEnv({
      M365_CUSTOMER_GRAPH_READ_ONBOARDING_ORG_IDS: '*',
    }))).toBe(true);
    expect(isM365CustomerGraphReadOnboardingEnabledForOrg(OTHER_ORG_ID, validEnv({
      M365_CUSTOMER_GRAPH_READ_ONBOARDING_ORG_IDS: `${ORG_ID}, ${OTHER_ORG_ID}`,
    }))).toBe(true);
    expect(() => loadM365CustomerGraphReadRuntimeConfig(validEnv({
      M365_CUSTOMER_GRAPH_READ_ONBOARDING_ORG_IDS: `${ORG_ID},*`,
    }))).toThrow(/ONBOARDING_ORG_IDS/);
    expect(() => loadM365CustomerGraphReadRuntimeConfig(validEnv({
      M365_CUSTOMER_GRAPH_READ_ONBOARDING_ORG_IDS: ORG_ID.toUpperCase(),
    }))).toThrow(/ONBOARDING_ORG_IDS/);
  });

  it('does not parse descriptor fields when the global rollout is disabled', () => {
    expect(isM365CustomerGraphReadOnboardingEnabledForOrg(ORG_ID, {
      M365_CUSTOMER_GRAPH_READ_ONBOARDING_ENABLED: 'false',
    })).toBe(false);
  });

  describe('validateM365CustomerGraphReadRuntimeConfigAtBoot', () => {
    it('is a no-op when neither rollout flag is enabled', () => {
      expect(() => validateM365CustomerGraphReadRuntimeConfigAtBoot({
        M365_CUSTOMER_GRAPH_READ_ONBOARDING_ENABLED: 'false',
        M365_GRAPH_READ_TOOLS_ENABLED: 'false',
      })).not.toThrow();
      expect(fs.openSync).not.toHaveBeenCalled();
    });

    it('loads the full executor config when only the onboarding flag is enabled', () => {
      expect(() => validateM365CustomerGraphReadRuntimeConfigAtBoot(validEnv({
        M365_GRAPH_READ_TOOLS_ENABLED: 'false',
      }))).not.toThrow();
      expect(() => validateM365CustomerGraphReadRuntimeConfigAtBoot(validEnv({
        M365_GRAPH_READ_TOOLS_ENABLED: 'false',
        M365_CUSTOMER_GRAPH_READ_CLIENT_ID: undefined,
      }))).toThrow(/CLIENT_ID/);
    });

    it('loads the full executor config when only the tools flag is enabled', () => {
      const env = validEnv({
        M365_CUSTOMER_GRAPH_READ_ONBOARDING_ENABLED: 'false',
        M365_GRAPH_READ_TOOLS_ENABLED: 'true',
        M365_GRAPH_READ_TOOLS_ORG_IDS: ORG_ID,
      });
      expect(() => validateM365CustomerGraphReadRuntimeConfigAtBoot(env)).not.toThrow();
      expect(() => validateM365CustomerGraphReadRuntimeConfigAtBoot({
        ...env,
        M365_CUSTOMER_GRAPH_READ_CLIENT_ID: undefined,
      })).toThrow(/CLIENT_ID/);
    });

    it('throws at boot when the tools flag is enabled without an org allowlist configured', () => {
      const env = validEnv({
        M365_CUSTOMER_GRAPH_READ_ONBOARDING_ENABLED: 'false',
        M365_GRAPH_READ_TOOLS_ENABLED: 'true',
        M365_GRAPH_READ_TOOLS_ORG_IDS: undefined,
      });
      expect(() => validateM365CustomerGraphReadRuntimeConfigAtBoot(env)).toThrow(
        /M365_GRAPH_READ_TOOLS_ORG_IDS is required/,
      );
    });

    it('throws at boot when the tools allowlist contains a malformed org id', () => {
      const env = validEnv({
        M365_CUSTOMER_GRAPH_READ_ONBOARDING_ENABLED: 'false',
        M365_GRAPH_READ_TOOLS_ENABLED: 'true',
        M365_GRAPH_READ_TOOLS_ORG_IDS: `${ORG_ID},not-a-uuid`,
      });
      expect(() => validateM365CustomerGraphReadRuntimeConfigAtBoot(env)).toThrow(
        /M365_GRAPH_READ_TOOLS_ORG_IDS must be literal \* or comma-separated canonical UUIDs/,
      );
    });
  });
});

describe('M365 Graph read tools rollout flag', () => {
  it('is off by default', () => {
    expect(isM365GraphReadToolsEnabledForOrg(ORG_ID, {})).toBe(false);
    expect(isM365GraphReadToolsEnabledForOrg(ORG_ID, {
      M365_GRAPH_READ_TOOLS_ENABLED: 'false',
      M365_GRAPH_READ_TOOLS_ORG_IDS: ORG_ID,
    })).toBe(false);
  });

  it('enables any canonical org id when the allowlist is the literal star', () => {
    const env = {
      M365_GRAPH_READ_TOOLS_ENABLED: 'true',
      M365_GRAPH_READ_TOOLS_ORG_IDS: '*',
    };
    expect(isM365GraphReadToolsEnabledForOrg(ORG_ID, env)).toBe(true);
    expect(isM365GraphReadToolsEnabledForOrg(OTHER_ORG_ID, env)).toBe(true);
  });

  it('restricts to allowlist membership when the allowlist is a UUID list', () => {
    const env = {
      M365_GRAPH_READ_TOOLS_ENABLED: 'true',
      M365_GRAPH_READ_TOOLS_ORG_IDS: ORG_ID,
    };
    expect(isM365GraphReadToolsEnabledForOrg(ORG_ID, env)).toBe(true);
    expect(isM365GraphReadToolsEnabledForOrg(OTHER_ORG_ID, env)).toBe(false);
  });

  it('rejects a non-canonical org id even with a star allowlist', () => {
    expect(isM365GraphReadToolsEnabledForOrg('not-a-uuid', {
      M365_GRAPH_READ_TOOLS_ENABLED: 'true',
      M365_GRAPH_READ_TOOLS_ORG_IDS: '*',
    })).toBe(false);
  });

  it('throws when enabled without an org allowlist configured', () => {
    expect(() => isM365GraphReadToolsEnabledForOrg(ORG_ID, {
      M365_GRAPH_READ_TOOLS_ENABLED: 'true',
    })).toThrow(/M365_GRAPH_READ_TOOLS_ORG_IDS is required/);
  });

  it('never requires executor settings to evaluate (no executor envs provided)', () => {
    expect(() => isM365GraphReadToolsEnabledForOrg(ORG_ID, {
      M365_GRAPH_READ_TOOLS_ENABLED: 'true',
      M365_GRAPH_READ_TOOLS_ORG_IDS: ORG_ID,
    })).not.toThrow();
  });
});
