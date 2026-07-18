export interface PinnedCertificateProvider {
  getConfiguredCertificate(): Promise<{
    certificatePem: string;
    privateKeyPem: string;
  }>;
}
