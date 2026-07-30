import {
  chmodSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  loadM365CommsRuntimeConfig,
  isM365CommsOnboardingEnabledForUser,
  isM365CommsToolsEnabledForUser,
  validateM365CommunicationsRuntimeConfigAtBoot,
} from './commsRuntimeConfig';

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';

let tempDir: string;
let jwkCounter = 0;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'breeze-m365-comms-runtime-'));
  jwkCounter = 0;
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function validPrivateJwk(kid: string) {
  return {
    kty: 'OKP',
    crv: 'Ed25519',
    alg: 'EdDSA',
    use: 'sig',
    kid,
    x: Buffer.alloc(32, 1).toString('base64url'),
    d: Buffer.alloc(32, 2).toString('base64url'),
  };
}

/** Mirrors writeActionRuntimeConfig.test.ts's JWK fixture: a temp file with
 * mode 0600 (or the given mode) containing an Ed25519 private JWK. Returns
 * the absolute path. */
function writeJwkFixture(kid: string, mode = 0o600): string {
  const file = join(tempDir, `comms-signing-${jwkCounter++}.jwk`);
  writeFileSync(file, JSON.stringify(validPrivateJwk(kid)), { mode: 0o600 });
  chmodSync(file, mode);
  return file;
}

function baseEnv(jwkFile: string) {
  return {
    NODE_ENV: 'test',
    PUBLIC_URL: 'https://app.example.com',
    M365_COMMS_CLIENT_ID: '33333333-3333-4333-8333-333333333333',
    M365_COMMS_EXECUTOR_URL: 'https://comms-executor.internal/',
    M365_COMMS_EXECUTOR_AUDIENCE: 'm365-communications-executor',
    M365_COMMS_EXECUTOR_SIGNING_KID: 'comms-kid-1',
    M365_COMMS_EXECUTOR_SIGNING_PRIVATE_JWK_FILE: jwkFile,
    M365_COMMS_ONBOARDING_ENABLED: 'true',
    M365_COMMS_ONBOARDING_USER_IDS: `${USER_A},${USER_B}`,
  } as Record<string, string>;
}

describe('loadM365CommsRuntimeConfig', () => {
  it('loads a valid config with a USER allowlist', () => {
    const env = baseEnv(writeJwkFixture('comms-kid-1'));
    const cfg = loadM365CommsRuntimeConfig(env);
    expect(cfg.onboardingUserIds).toEqual([USER_A, USER_B]);
    expect(cfg.executorAudience).toBe('m365-communications-executor');
  });

  it('accepts the wildcard allowlist', () => {
    const env = { ...baseEnv(writeJwkFixture('comms-kid-1')), M365_COMMS_ONBOARDING_USER_IDS: '*' };
    expect(loadM365CommsRuntimeConfig(env).onboardingUserIds).toBe('*');
  });

  it('rejects a wrong audience', () => {
    const env = { ...baseEnv(writeJwkFixture('comms-kid-1')), M365_COMMS_EXECUTOR_AUDIENCE: 'm365-graph-actions-executor' };
    expect(() => loadM365CommsRuntimeConfig(env)).toThrow(/must equal m365-communications-executor/);
  });

  it('rejects a non-UUID in the allowlist rather than silently dropping it', () => {
    const env = { ...baseEnv(writeJwkFixture('comms-kid-1')), M365_COMMS_ONBOARDING_USER_IDS: `${USER_A},not-a-uuid` };
    expect(() => loadM365CommsRuntimeConfig(env)).toThrow(/M365_COMMS_ONBOARDING_USER_IDS/);
  });

  it('rejects a JWK file readable by group or other', () => {
    const env = baseEnv(writeJwkFixture('comms-kid-1', 0o644));
    expect(() => loadM365CommsRuntimeConfig(env)).toThrow(/permissions must deny group and other access/);
  });

  it('rejects a JWK whose kid does not match the configured kid', () => {
    const env = baseEnv(writeJwkFixture('some-other-kid'));
    expect(() => loadM365CommsRuntimeConfig(env)).toThrow(/M365_COMMS_EXECUTOR_SIGNING_PRIVATE_JWK_FILE/);
  });

  it('requires no vault vars — the API never touches the comms vault', () => {
    const env = baseEnv(writeJwkFixture('comms-kid-1'));
    expect(() => loadM365CommsRuntimeConfig(env)).not.toThrow();
    expect(Object.keys(env).some((k) => k.includes('VAULT'))).toBe(false);
  });
});

describe('per-user gates', () => {
  it('onboarding gate is false when the flag is off, regardless of allowlist', () => {
    const env = { ...baseEnv(writeJwkFixture('comms-kid-1')), M365_COMMS_ONBOARDING_ENABLED: 'false' };
    expect(isM365CommsOnboardingEnabledForUser(USER_A, env)).toBe(false);
  });

  it('onboarding gate admits an allowlisted user and refuses a non-listed one', () => {
    const env = baseEnv(writeJwkFixture('comms-kid-1'));
    expect(isM365CommsOnboardingEnabledForUser(USER_A, env)).toBe(true);
    expect(isM365CommsOnboardingEnabledForUser('99999999-9999-4999-8999-999999999999', env)).toBe(false);
  });

  it('tools gate does NOT require the executor envs (hot registration path)', () => {
    // Only the flag + the tools allowlist. Calling the full loader here would
    // make every tool registration depend on executor config being present.
    const env = {
      NODE_ENV: 'test',
      M365_COMMS_TOOLS_ENABLED: 'true',
      M365_COMMS_TOOLS_USER_IDS: USER_A,
    } as Record<string, string>;
    expect(isM365CommsToolsEnabledForUser(USER_A, env)).toBe(true);
    expect(isM365CommsToolsEnabledForUser(USER_B, env)).toBe(false);
  });

  it('both gates refuse a malformed user id', () => {
    const env = baseEnv(writeJwkFixture('comms-kid-1'));
    expect(isM365CommsOnboardingEnabledForUser('not-a-uuid', env)).toBe(false);
  });
});

describe('validateM365CommunicationsRuntimeConfigAtBoot', () => {
  it('is a no-op when both flags are off', () => {
    expect(() => validateM365CommunicationsRuntimeConfigAtBoot({ NODE_ENV: 'test' })).not.toThrow();
  });

  it('force-loads when the onboarding flag is on', () => {
    expect(() => validateM365CommunicationsRuntimeConfigAtBoot({
      NODE_ENV: 'test', M365_COMMS_ONBOARDING_ENABLED: 'true',
    })).toThrow(/M365_COMMS_CLIENT_ID is required/);
  });

  it('validates the TOOLS allowlist even though the loader does not read it', () => {
    const env = { ...baseEnv(writeJwkFixture('comms-kid-1')), M365_COMMS_TOOLS_ENABLED: 'true' };
    // M365_COMMS_TOOLS_USER_IDS deliberately absent.
    expect(() => validateM365CommunicationsRuntimeConfigAtBoot(env)).toThrow(/M365_COMMS_TOOLS_USER_IDS/);
  });
});
