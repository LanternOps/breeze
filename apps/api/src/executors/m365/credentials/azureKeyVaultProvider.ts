import { DefaultAzureCredential } from '@azure/identity';
import { SecretClient } from '@azure/keyvault-secrets';
import {
  M365_CREDENTIAL_DOMAINS,
  type M365CredentialDomain,
} from '../../../services/m365ControlPlane/profiles';
import type { CredentialProvider, M365CredentialMaterial, StoredCredentialReference } from './types';

interface CredentialEnvelope {
  schemaVersion: 1;
  domain: M365CredentialDomain;
  material: M365CredentialMaterial;
}

export interface SecretClientPort {
  setSecret(name: string, value: string, options?: unknown): Promise<{ properties: { version?: string } }>;
  getSecret(name: string, options?: { version?: string }): Promise<{ value?: string }>;
  beginDeleteSecret(name: string): Promise<{ pollUntilDone(): Promise<unknown> }>;
}

interface ParsedReference {
  host: string;
  name: string;
  domain: M365CredentialDomain;
  version: string;
}

const CONNECTION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Azure-generated secret versions are 32 hexadecimal characters. `version-1`
// remains valid for the provider port contract used by the foundation plan.
// This is syntax validation for a pinned reference, not an authorization check.
const KEY_VAULT_VERSION_RE = /^(?:[0-9a-f]{32}|version-1)$/i;

function isCredentialDomain(value: unknown): value is M365CredentialDomain {
  return typeof value === 'string'
    && M365_CREDENTIAL_DOMAINS.includes(value as M365CredentialDomain);
}

function assertCredentialDomain(value: unknown): asserts value is M365CredentialDomain {
  if (!isCredentialDomain(value)) throw new Error('Unsupported M365 credential domain');
}

function parseCredentialName(name: string): M365CredentialDomain | undefined {
  for (const domain of M365_CREDENTIAL_DOMAINS) {
    const prefix = `m365-${domain}-`;
    if (name.startsWith(prefix) && CONNECTION_ID_RE.test(name.slice(prefix.length))) {
      return domain;
    }
  }
  return undefined;
}

function hasExactKeys(value: object, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function materialMatchesDomain(
  domain: M365CredentialDomain,
  material: M365CredentialMaterial,
): boolean {
  if (typeof material !== 'object' || material === null) return false;
  if (domain === 'communications-delegated') {
    return hasExactKeys(material, ['kind', 'refreshToken'])
      && material.kind === 'delegated-refresh-token'
      && typeof material.refreshToken === 'string'
      && material.refreshToken.length > 0;
  }
  return hasExactKeys(material, ['kind', 'certificatePem', 'privateKeyPem', 'thumbprint'])
    && material.kind === 'certificate'
    && typeof material.certificatePem === 'string'
    && material.certificatePem.length > 0
    && typeof material.privateKeyPem === 'string'
    && material.privateKeyPem.length > 0
    && typeof material.thumbprint === 'string'
    && material.thumbprint.length > 0;
}

function parseReference(reference: string): ParsedReference {
  try {
    const url = new URL(reference);
    const pathSegments = url.pathname.split('/');
    const name = pathSegments[1];
    const version = pathSegments[2];
    const domain = name ? parseCredentialName(name) : undefined;
    if (
      url.protocol !== 'akv:'
      || !url.hostname
      || url.username
      || url.password
      || url.search
      || url.hash
      || pathSegments.length !== 3
      || !name
      || !version
      || !domain
      || !KEY_VAULT_VERSION_RE.test(version)
      || reference !== `akv://${url.host}/${name}/${version}`
    ) {
      throw new Error('invalid');
    }
    return { host: url.host, name, domain, version };
  } catch {
    throw new Error('Invalid Azure Key Vault credential reference');
  }
}

function parseEnvelope(value: string | undefined): CredentialEnvelope {
  if (!value) throw new Error('Credential secret has no value');

  try {
    const parsed = JSON.parse(value) as Partial<CredentialEnvelope>;
    const domainValid = M365_CREDENTIAL_DOMAINS.includes(parsed.domain as M365CredentialDomain);
    const material = parsed.material;
    const delegatedValid = typeof material === 'object'
      && material !== null
      && hasExactKeys(material, ['kind', 'refreshToken'])
      && material.kind === 'delegated-refresh-token'
      && typeof material.refreshToken === 'string'
      && material.refreshToken.length > 0;
    const certificateValid = typeof material === 'object'
      && material !== null
      && hasExactKeys(material, ['kind', 'certificatePem', 'privateKeyPem', 'thumbprint'])
      && material.kind === 'certificate'
      && typeof material.certificatePem === 'string'
      && material.certificatePem.length > 0
      && typeof material.privateKeyPem === 'string'
      && material.privateKeyPem.length > 0
      && typeof material.thumbprint === 'string'
      && material.thumbprint.length > 0;
    if (parsed.schemaVersion !== 1 || !domainValid || (!delegatedValid && !certificateValid)) {
      throw new Error('invalid');
    }
    return parsed as CredentialEnvelope;
  } catch {
    throw new Error('Credential secret has an unsupported envelope');
  }
}

export class AzureKeyVaultCredentialProvider implements CredentialProvider {
  private readonly vaultHost: string;

  constructor(vaultUrl: string, private readonly client: SecretClientPort) {
    const parsed = new URL(vaultUrl);
    if (parsed.protocol !== 'https:' || !parsed.hostname) throw new Error('Azure Key Vault URL must use HTTPS');
    this.vaultHost = parsed.host;
  }

  static fromEnvironment(): AzureKeyVaultCredentialProvider {
    const vaultUrl = process.env.M365_AZURE_KEY_VAULT_URL;
    if (!vaultUrl) throw new Error('M365_AZURE_KEY_VAULT_URL is required');
    return new AzureKeyVaultCredentialProvider(
      vaultUrl,
      new SecretClient(vaultUrl, new DefaultAzureCredential()) as unknown as SecretClientPort,
    );
  }

  async put(input: {
    connectionId: string;
    domain: M365CredentialDomain;
    material: M365CredentialMaterial;
  }): Promise<StoredCredentialReference> {
    assertCredentialDomain(input.domain);
    if (!CONNECTION_ID_RE.test(input.connectionId)) throw new Error('Connection id must be a UUID');
    if (!materialMatchesDomain(input.domain, input.material)) {
      throw new Error('Credential material does not match credential domain');
    }
    const name = `m365-${input.domain}-${input.connectionId}`;
    const envelope: CredentialEnvelope = { schemaVersion: 1, domain: input.domain, material: input.material };
    let stored: Awaited<ReturnType<SecretClientPort['setSecret']>>;
    try {
      stored = await this.client.setSecret(name, JSON.stringify(envelope), {
        contentType: 'application/vnd.breeze.m365-credential+json',
        tags: { domain: input.domain, connectionId: input.connectionId },
      });
    } catch {
      throw new Error('Azure Key Vault credential write failed');
    }
    const version = stored.properties.version;
    if (!version || !KEY_VAULT_VERSION_RE.test(version)) {
      throw new Error('Azure Key Vault did not return a valid secret version');
    }
    return { reference: `akv://${this.vaultHost}/${name}/${version}`, version };
  }

  async get(reference: string, expectedDomain: M365CredentialDomain): Promise<M365CredentialMaterial> {
    assertCredentialDomain(expectedDomain);
    const parsed = parseReference(reference);
    if (parsed.host !== this.vaultHost) throw new Error('Credential reference vault mismatch');
    if (parsed.domain !== expectedDomain) throw new Error('Credential domain mismatch');
    let secret: Awaited<ReturnType<SecretClientPort['getSecret']>>;
    try {
      secret = await this.client.getSecret(parsed.name, { version: parsed.version });
    } catch {
      throw new Error('Azure Key Vault credential read failed');
    }
    const envelope = parseEnvelope(secret.value);
    if (envelope.domain !== expectedDomain) throw new Error('Credential domain mismatch');
    if (!materialMatchesDomain(expectedDomain, envelope.material)) {
      throw new Error('Credential material does not match credential domain');
    }
    return envelope.material;
  }

  async delete(reference: string, expectedDomain: M365CredentialDomain): Promise<void> {
    assertCredentialDomain(expectedDomain);
    const parsed = parseReference(reference);
    if (parsed.host !== this.vaultHost) throw new Error('Credential reference vault mismatch');
    if (parsed.domain !== expectedDomain) throw new Error('Credential domain mismatch');
    try {
      // Azure deletion is name-scoped and intentionally deletes the named secret
      // with all of its versions. Canonical host/domain/name/version validation
      // above must succeed before beginning that all-version operation.
      const poller = await this.client.beginDeleteSecret(parsed.name);
      await poller.pollUntilDone();
    } catch {
      throw new Error('Azure Key Vault credential delete failed');
    }
  }
}
