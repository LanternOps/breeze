import type { M365CredentialDomain } from '../../../services/m365ControlPlane/profiles';

export type M365CredentialMaterial =
  | { kind: 'delegated-refresh-token'; refreshToken: string }
  | { kind: 'certificate'; certificatePem: string; privateKeyPem: string; thumbprint: string };

export interface StoredCredentialReference {
  reference: string;
  version: string;
}

export interface CredentialProvider {
  put(input: {
    connectionId: string;
    domain: M365CredentialDomain;
    material: M365CredentialMaterial;
  }): Promise<StoredCredentialReference>;
  get(reference: string, expectedDomain: M365CredentialDomain): Promise<M365CredentialMaterial>;
}
