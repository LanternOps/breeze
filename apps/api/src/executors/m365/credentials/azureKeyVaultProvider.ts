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
  version: string;
}

const CONNECTION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    const [name, version, extra] = url.pathname.split('/').filter(Boolean);
    if (
      url.protocol !== 'akv:'
      || !url.hostname
      || url.username
      || url.password
      || url.search
      || url.hash
      || !name
      || !version
      || extra
    ) {
      throw new Error('invalid');
    }
    return { host: url.host, name, version };
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
    if (!CONNECTION_ID_RE.test(input.connectionId)) throw new Error('Connection id must be a UUID');
    if (!materialMatchesDomain(input.domain, input.material)) {
      throw new Error('Credential material does not match credential domain');
    }
    const name = `m365-${input.domain}-${input.connectionId}`;
    const envelope: CredentialEnvelope = { schemaVersion: 1, domain: input.domain, material: input.material };
    const stored = await this.client.setSecret(name, JSON.stringify(envelope), {
      contentType: 'application/vnd.breeze.m365-credential+json',
      tags: { domain: input.domain, connectionId: input.connectionId },
    });
    const version = stored.properties.version;
    if (!version) throw new Error('Azure Key Vault did not return a secret version');
    return { reference: `akv://${this.vaultHost}/${name}/${version}`, version };
  }

  async get(reference: string, expectedDomain: M365CredentialDomain): Promise<M365CredentialMaterial> {
    const parsed = parseReference(reference);
    if (parsed.host !== this.vaultHost) throw new Error('Credential reference vault mismatch');
    if (!parsed.name.startsWith(`m365-${expectedDomain}-`)) throw new Error('Credential domain mismatch');
    const secret = await this.client.getSecret(parsed.name, { version: parsed.version });
    const envelope = parseEnvelope(secret.value);
    if (envelope.domain !== expectedDomain) throw new Error('Credential domain mismatch');
    if (!materialMatchesDomain(expectedDomain, envelope.material)) {
      throw new Error('Credential material does not match credential domain');
    }
    return envelope.material;
  }

  async delete(reference: string, expectedDomain: M365CredentialDomain): Promise<void> {
    const parsed = parseReference(reference);
    if (parsed.host !== this.vaultHost) throw new Error('Credential reference vault mismatch');
    if (!parsed.name.startsWith(`m365-${expectedDomain}-`)) throw new Error('Credential domain mismatch');
    const poller = await this.client.beginDeleteSecret(parsed.name);
    await poller.pollUntilDone();
  }
}
