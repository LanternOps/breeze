import { ManagedIdentityCredential, WorkloadIdentityCredential } from '@azure/identity';
import { describe, expect, it } from 'vitest';
import { createAzureCredential, loadExecutorConfig } from './config';

const CLIENT_ID = 'c3333333-3333-4333-8333-333333333333';
const CREDENTIAL_VERSION = '0123456789abcdef0123456789abcdef';
const PUBLIC_JWK = {
  kty: 'OKP',
  crv: 'Ed25519',
  alg: 'EdDSA',
  use: 'sig',
  key_ops: ['verify'],
  kid: 'graph-read-api-1',
  x: Buffer.alloc(32, 1).toString('base64url'),
};

function validEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    NODE_ENV: 'production',
    M365_CUSTOMER_GRAPH_READ_CLIENT_ID: CLIENT_ID,
    M365_CUSTOMER_GRAPH_READ_CALLBACK_URL:
      'https://console.example.test/api/v1/m365/consent/callback',
    M365_CUSTOMER_GRAPH_READ_VAULT_URL: 'https://customer-vault.vault.azure.net',
    M365_CUSTOMER_GRAPH_READ_VAULT_REF:
      `akv://customer-vault.vault.azure.net/m365-customer-graph-read/${CREDENTIAL_VERSION}`,
    M365_CUSTOMER_GRAPH_READ_CREDENTIAL_VERSION: CREDENTIAL_VERSION,
    M365_GRAPH_READ_EXECUTOR_SIGNING_PUBLIC_JWK: JSON.stringify(PUBLIC_JWK),
    M365_GRAPH_READ_EXECUTOR_SIGNING_KID: 'graph-read-api-1',
    M365_GRAPH_READ_EXECUTOR_ISSUER: 'breeze-api',
    M365_GRAPH_READ_EXECUTOR_AUDIENCE: 'm365-graph-read-executor',
    M365_GRAPH_READ_EXECUTOR_AZURE_CREDENTIAL_MODE: 'managed-identity',
    ...overrides,
  };
}

describe('M365 Graph-read executor config', () => {
  it('loads the fixed Graph-read profile and public internal-auth key', () => {
    expect(loadExecutorConfig(validEnv())).toEqual({
      clientId: CLIENT_ID,
      callbackUrl: 'https://console.example.test/api/v1/m365/consent/callback',
      vaultUrl: 'https://customer-vault.vault.azure.net',
      vaultRef: `akv://customer-vault.vault.azure.net/m365-customer-graph-read/${CREDENTIAL_VERSION}`,
      credentialVersion: CREDENTIAL_VERSION,
      internalAuthPublicJwk: PUBLIC_JWK,
      internalAuthKid: 'graph-read-api-1',
      internalAuthIssuer: 'breeze-api',
      internalAuthAudience: 'm365-graph-read-executor',
      azureCredentialMode: 'managed-identity',
    });
  });

  it.each([
    'M365_CUSTOMER_GRAPH_READ_CLIENT_ID',
    'M365_CUSTOMER_GRAPH_READ_CALLBACK_URL',
    'M365_CUSTOMER_GRAPH_READ_VAULT_URL',
    'M365_CUSTOMER_GRAPH_READ_VAULT_REF',
    'M365_CUSTOMER_GRAPH_READ_CREDENTIAL_VERSION',
    'M365_GRAPH_READ_EXECUTOR_SIGNING_PUBLIC_JWK',
    'M365_GRAPH_READ_EXECUTOR_SIGNING_KID',
    'M365_GRAPH_READ_EXECUTOR_ISSUER',
    'M365_GRAPH_READ_EXECUTOR_AUDIENCE',
    'M365_GRAPH_READ_EXECUTOR_AZURE_CREDENTIAL_MODE',
  ])('requires %s', (name) => {
    expect(() => loadExecutorConfig(validEnv({ [name]: undefined }))).toThrow(name);
  });

  it.each([
    ['an uppercase client UUID', { M365_CUSTOMER_GRAPH_READ_CLIENT_ID: CLIENT_ID.toUpperCase() }, /CLIENT_ID/],
    ['a callback on the wrong path', { M365_CUSTOMER_GRAPH_READ_CALLBACK_URL: 'https://console.example.test/other' }, /CALLBACK_URL/],
    ['a callback query', { M365_CUSTOMER_GRAPH_READ_CALLBACK_URL: 'https://console.example.test/api/v1/m365/consent/callback?next=1' }, /CALLBACK_URL/],
    ['a non-HTTPS callback', { M365_CUSTOMER_GRAPH_READ_CALLBACK_URL: 'http://console.example.test/api/v1/m365/consent/callback' }, /CALLBACK_URL/],
    ['a non-HTTPS vault URL', { M365_CUSTOMER_GRAPH_READ_VAULT_URL: 'http://customer-vault.vault.azure.net' }, /VAULT_URL/],
    ['a vault URL with a path', { M365_CUSTOMER_GRAPH_READ_VAULT_URL: 'https://customer-vault.vault.azure.net/secrets' }, /VAULT_URL/],
    ['a per-customer secret name', { M365_CUSTOMER_GRAPH_READ_VAULT_REF: `akv://customer-vault.vault.azure.net/m365-customer-graph-read-${CLIENT_ID}/${CREDENTIAL_VERSION}` }, /VAULT_REF/],
    ['a different vault host', { M365_CUSTOMER_GRAPH_READ_VAULT_REF: `akv://another-vault.vault.azure.net/m365-customer-graph-read/${CREDENTIAL_VERSION}` }, /VAULT_REF.*VAULT_URL|VAULT_URL.*VAULT_REF/],
    ['a mismatched secret version', { M365_CUSTOMER_GRAPH_READ_CREDENTIAL_VERSION: 'f'.repeat(32) }, /VAULT_REF.*CREDENTIAL_VERSION|CREDENTIAL_VERSION.*VAULT_REF/],
    ['an arbitrary internal issuer', { M365_GRAPH_READ_EXECUTOR_ISSUER: 'another-api' }, /ISSUER/],
    ['an arbitrary internal audience', { M365_GRAPH_READ_EXECUTOR_AUDIENCE: 'another-executor' }, /AUDIENCE/],
    ['Azure CLI fallback mode', { M365_GRAPH_READ_EXECUTOR_AZURE_CREDENTIAL_MODE: 'azure-cli' }, /AZURE_CREDENTIAL_MODE/],
    ['default Azure fallback mode', { M365_GRAPH_READ_EXECUTOR_AZURE_CREDENTIAL_MODE: 'default' }, /AZURE_CREDENTIAL_MODE/],
  ])('rejects %s', (_label, overrides, error) => {
    expect(() => loadExecutorConfig(validEnv(overrides))).toThrow(error);
  });

  it.each([
    ['malformed JSON', '{not-json'],
    ['a private JWK', JSON.stringify({ ...PUBLIC_JWK, d: Buffer.alloc(32, 2).toString('base64url') })],
    ['the wrong curve', JSON.stringify({ ...PUBLIC_JWK, crv: 'X25519' })],
    ['signing-only operations', JSON.stringify({ ...PUBLIC_JWK, key_ops: ['sign'] })],
    ['a mismatched key id', JSON.stringify({ ...PUBLIC_JWK, kid: 'other-key' })],
  ])('rejects %s as the public internal-auth JWK', (_label, value) => {
    expect(() => loadExecutorConfig(validEnv({
      M365_GRAPH_READ_EXECUTOR_SIGNING_PUBLIC_JWK: value,
    }))).toThrow(/SIGNING_PUBLIC_JWK|SIGNING_KID/);
  });

  it('supports only explicit managed identity and workload identity credentials', () => {
    expect(createAzureCredential('managed-identity')).toBeInstanceOf(ManagedIdentityCredential);
    expect(createAzureCredential('workload-identity', {
      AZURE_TENANT_ID: 'a1111111-1111-4111-8111-111111111111',
      AZURE_CLIENT_ID: 'b2222222-2222-4222-8222-222222222222',
      AZURE_FEDERATED_TOKEN_FILE: '/var/run/secrets/azure/tokens/identity-token',
    })).toBeInstanceOf(WorkloadIdentityCredential);
  });

  it.each([
    'AZURE_TENANT_ID',
    'AZURE_CLIENT_ID',
    'AZURE_FEDERATED_TOKEN_FILE',
  ])('requires %s for explicit workload identity', (name) => {
    expect(() => createAzureCredential('workload-identity', {
      AZURE_TENANT_ID: 'a1111111-1111-4111-8111-111111111111',
      AZURE_CLIENT_ID: 'b2222222-2222-4222-8222-222222222222',
      AZURE_FEDERATED_TOKEN_FILE: '/var/run/secrets/azure/tokens/identity-token',
      [name]: undefined,
    })).toThrow(name);
  });

  it('loads workload identity mode without falling back to another credential source', () => {
    expect(loadExecutorConfig(validEnv({
      M365_GRAPH_READ_EXECUTOR_AZURE_CREDENTIAL_MODE: 'workload-identity',
    })).azureCredentialMode).toBe('workload-identity');
  });
});
