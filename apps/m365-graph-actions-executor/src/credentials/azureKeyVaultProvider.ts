import { SecretClient } from '@azure/keyvault-secrets';
import { z } from 'zod';
import {
  createAzureCredential,
  type AzureCredentialMode,
} from '../config';
import type { PinnedCertificateProvider } from './types';

const SECRET_NAME = 'm365-customer-graph-actions';
const KEY_VAULT_VERSION = /^[0-9a-f]{32}$/;

const certificateEnvelopeSchema = z.object({
  schemaVersion: z.literal(1),
  domain: z.literal('customer-graph-actions'),
  material: z.object({
    kind: z.literal('certificate'),
    certificatePem: z.string().min(1),
    privateKeyPem: z.string().min(1),
  }).strict(),
}).strict();

export interface SecretClientPort {
  getSecret(name: string, options: { version: string }): Promise<{ value?: string }>;
}

export interface AzureKeyVaultCertificateProviderConfig {
  vaultUrl: string;
  vaultRef: string;
  credentialVersion: string;
}

export class CredentialUnavailableError extends Error {
  readonly code = 'credential_unavailable' as const;

  constructor() {
    super('credential_unavailable');
    this.name = 'CredentialUnavailableError';
  }
}

function unavailable(): CredentialUnavailableError {
  return new CredentialUnavailableError();
}

function parsePinnedReference(config: AzureKeyVaultCertificateProviderConfig): {
  name: typeof SECRET_NAME;
  version: string;
} {
  try {
    const vaultUrl = new URL(config.vaultUrl);
    const reference = new URL(config.vaultRef);
    const path = reference.pathname.split('/');
    const name = path[1];
    const version = path[2];
    if (
      vaultUrl.protocol !== 'https:'
      || !vaultUrl.hostname
      || vaultUrl.username
      || vaultUrl.password
      || vaultUrl.pathname !== '/'
      || vaultUrl.search
      || vaultUrl.hash
      || config.vaultUrl !== vaultUrl.origin
      || reference.protocol !== 'akv:'
      || reference.host !== vaultUrl.host
      || reference.username
      || reference.password
      || reference.search
      || reference.hash
      || path.length !== 3
      || name !== SECRET_NAME
      || !version
      || !KEY_VAULT_VERSION.test(version)
      || version !== config.credentialVersion
      || config.vaultRef !== `akv://${vaultUrl.host}/${SECRET_NAME}/${version}`
    ) {
      throw unavailable();
    }
    return { name, version };
  } catch {
    throw unavailable();
  }
}

function parseEnvelope(value: string | undefined): z.infer<typeof certificateEnvelopeSchema> {
  if (!value) throw unavailable();
  try {
    return certificateEnvelopeSchema.parse(JSON.parse(value));
  } catch {
    throw unavailable();
  }
}

export class AzureKeyVaultCertificateProvider implements PinnedCertificateProvider {
  constructor(
    private readonly config: AzureKeyVaultCertificateProviderConfig,
    private readonly client: SecretClientPort,
  ) {}

  static fromConfig(
    config: AzureKeyVaultCertificateProviderConfig & { azureCredentialMode: AzureCredentialMode },
  ): AzureKeyVaultCertificateProvider {
    return new AzureKeyVaultCertificateProvider(
      config,
      new SecretClient(
        config.vaultUrl,
        createAzureCredential(config.azureCredentialMode),
      ) as unknown as SecretClientPort,
    );
  }

  async getConfiguredCertificate(): Promise<{
    certificatePem: string;
    privateKeyPem: string;
  }> {
    const { name, version } = parsePinnedReference(this.config);
    let secret: { value?: string };
    try {
      secret = await this.client.getSecret(name, { version });
    } catch {
      throw unavailable();
    }
    const envelope = parseEnvelope(secret.value);
    return {
      certificatePem: envelope.material.certificatePem,
      privateKeyPem: envelope.material.privateKeyPem,
    };
  }
}
