import { describe, expect, it } from 'vitest';
import {
  buildSafeBlockedRecord,
  canonicalJsonStringify,
  computePartnerExportRevision,
  inspectDefinitionForSecrets,
  safelyExportDefinition,
} from './exportSafety';

const ID = '11111111-1111-4111-8111-111111111111';
const ORG_ID = '22222222-2222-4222-8222-222222222222';

describe('canonical partner export revisions', () => {
  it('orders object keys recursively and produces stable SHA-256 revisions', () => {
    const first = {
      z: true,
      nested: { beta: 2, alpha: 1 },
      list: [{ right: 'r', left: 'l' }],
    };
    const reordered = {
      list: [{ left: 'l', right: 'r' }],
      nested: { alpha: 1, beta: 2 },
      z: true,
    };

    expect(canonicalJsonStringify(first)).toBe(canonicalJsonStringify(reordered));
    expect(computePartnerExportRevision(first)).toBe(computePartnerExportRevision(reordered));
    expect(computePartnerExportRevision(first)).toMatch(/^[a-f0-9]{64}$/);
    expect(computePartnerExportRevision({ ...first, list: [...first.list].reverse() }))
      .toBe(computePartnerExportRevision(first));
    expect(computePartnerExportRevision({ list: [1, 2] }))
      .not.toBe(computePartnerExportRevision({ list: [2, 1] }));
  });
});

describe('recursive export safety', () => {
  const embeddedCredential = 'QWxhZGRpbjpvcGVuIHNlc2FtZQ9xY7vK2mN4pR8sT6uV0wX3zA5bC7dE';

  it.each([
    ['password', { nested: { password: 'ordinary-looking-value' } }],
    ['providerConfig', { steps: [{ options: { providerConfig: {} } }] }],
    ['authorization', { headers: { Authorization: 'ordinary-looking-value' } }],
    ['privateKey', { private_key: 'ordinary-looking-value' }],
    ['token', { inputs: [{ apiToken: 'ordinary-looking-value' }] }],
    ['encryptionKey', { storage: { encryptionKey: 'ordinary-looking-value' } }],
  ])('rejects forbidden field name %s at arbitrary depth', (_name, definition) => {
    expect(inspectDefinitionForSecrets(definition)).toMatchObject({
      safe: false,
      reason: 'secret_detected',
    });
  });

  it.each([
    ['credential URL', { endpoint: 'https://operator:hunter2@example.test/api' }],
    ['bearer authorization', { command: 'curl -H "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456"' }],
    ['private key', { content: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----' }],
    ['provider token', { value: 'ghp_abcdefghijklmnopqrstuvwxyz1234567890' }],
    ['high entropy', { value: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP' }],
    ['bounded long high entropy', { value: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'.repeat(100) }],
  ])('rejects bounded secret pattern: %s', (_name, definition) => {
    expect(inspectDefinitionForSecrets(definition)).toMatchObject({
      safe: false,
      reason: 'secret_detected',
    });
  });

  it('trusts only the derived revision field instead of exempting arbitrary hashes', () => {
    const revision = 'a3f15d4c9e78b260a3f15d4c9e78b260a3f15d4c9e78b260a3f15d4c9e78b260';
    expect(inspectDefinitionForSecrets({
      id: ID,
      revision,
      definition: { enabled: true },
    })).toEqual({ safe: true });
    expect(inspectDefinitionForSecrets({
      id: ID,
      checksum: revision,
      definition: { enabled: true },
    })).toMatchObject({ safe: false, reason: 'secret_detected' });
    expect(inspectDefinitionForSecrets({
      id: ID,
      definition: { revision },
    })).toMatchObject({ safe: false, reason: 'secret_detected' });
  });

  it('allows a complete ordinary non-secret configuration definition', () => {
    const definition = {
      name: 'Workstation baseline',
      enabled: true,
      schedule: { timezone: 'America/Denver', days: ['monday', 'wednesday'] },
      endpoint: 'https://packages.example.test/v1',
      retention: { daily: 14, monthly: 6 },
      steps: [
        { type: 'shell', command: 'systemctl enable example-agent' },
        { type: 'verify', expectedExitCode: 0 },
      ],
    };
    expect(inspectDefinitionForSecrets(definition)).toEqual({ safe: true });
    expect(safelyExportDefinition({ resource: 'configuration-policies', id: ID, orgId: ORG_ID }, definition))
      .toEqual({ safe: true, definition });
  });

  it('finds high-entropy credentials embedded in bounded script windows', () => {
    expect(inspectDefinitionForSecrets({
      command: `printf 'starting backup'; curl -H 'X-Credential: ${embeddedCredential}' https://backup.example.test`,
    })).toMatchObject({ safe: false, reason: 'secret_detected' });

    expect(inspectDefinitionForSecrets({
      command: `${'# documentation padding\n'.repeat(300)}export CREDENTIAL=${embeddedCredential}`,
    })).toMatchObject({ safe: false, reason: 'secret_detected' });
  });

  it('does not classify ordinary script text as high-entropy credentials', () => {
    expect(inspectDefinitionForSecrets({
      command: [
        '# install and enable the ordinary monitoring package',
        'curl --fail --location https://packages.example.test/downloads/monitoring-agent.tar.gz',
        'tar -xzf monitoring-agent.tar.gz -C /opt/example-agent',
        'systemctl enable --now example-agent.service',
      ].join('\n'),
    })).toEqual({ safe: true });
  });

  it('stops immediately after a depth or visited-value limit violation', () => {
    let deep: Record<string, unknown> = { leaf: true };
    for (let depth = 0; depth < 34; depth += 1) deep = { next: deep };
    let lateGetterRead = false;
    const deepDefinition: Record<string, unknown> = { deep };
    Object.defineProperty(deepDefinition, 'mustNotRead', {
      enumerable: true,
      get() {
        lateGetterRead = true;
        throw new Error('traversal continued after the depth cap');
      },
    });

    expect(() => inspectDefinitionForSecrets(deepDefinition)).not.toThrow();
    expect(inspectDefinitionForSecrets(deepDefinition)).toMatchObject({ safe: false });
    expect(lateGetterRead).toBe(false);

    const sparse = new Array<unknown>(1_000_000);
    let indexedReads = 0;
    const guardedSparse = new Proxy(sparse, {
      get(target, property, receiver) {
        if (typeof property === 'string' && /^[0-9]+$/u.test(property)) {
          indexedReads += 1;
          if (indexedReads > 10_010) throw new Error('traversal continued after the visited-value cap');
        }
        return Reflect.get(target, property, receiver);
      },
    });

    expect(() => inspectDefinitionForSecrets(guardedSparse)).not.toThrow();
    expect(indexedReads).toBeLessThanOrEqual(10_001);
  });

  it('rejects the whole definition and emits only safe bounded blocked metadata', () => {
    const definition: Record<string, unknown> = {};
    for (let index = 0; index < 30; index += 1) {
      definition[`nested-${'x'.repeat(300)}-${index}`] = { password: `value-${index}` };
    }
    const result = safelyExportDefinition(
      { resource: 'scripts', id: ID, orgId: ORG_ID },
      definition,
    );

    expect(result.safe).toBe(false);
    if (result.safe) throw new Error('expected blocked result');
    expect(result).toEqual({
      safe: false,
      blocked: buildSafeBlockedRecord(
        { resource: 'scripts', id: ID, orgId: ORG_ID },
        inspectDefinitionForSecrets(definition),
      ),
    });
    expect(result.blocked).toMatchObject({
      resource: 'scripts',
      id: ID,
      orgId: ORG_ID,
      reason: 'secret_detected',
    });
    expect(result.blocked.fieldPaths.length).toBeLessThanOrEqual(20);
    expect(result.blocked.fieldPaths.every((path) => path.length <= 256)).toBe(true);
    expect(result).not.toHaveProperty('definition');
    expect(JSON.stringify(result)).not.toContain('value-');
  });
});
