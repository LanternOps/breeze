import { describe, expect, it } from 'vitest';
import {
  PARTNER_EXPORT_MAX_INSPECTABLE_STRING_LENGTH,
  buildSafeBlockedRecord,
  canonicalJsonStringify,
  computePartnerExportRevision,
  inspectCredentialSyntax,
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
  const maxInspectableStringLength = 12_288;

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

  it.each([
    ['shell password', { content: 'password=hunter2' }],
    ['compound database password', { content: 'DB_PASSWORD=hunter2' }],
    ['compound local admin password', { content: 'LOCAL_ADMIN_PASSWORD=Summer2026!' }],
    ['exported API key', { content: "export API_KEY='ordinary-low-entropy'" }],
    ['quoted CMD set', { content: 'set "PASSWORD=hunter2"' }],
    ['CMD setx', { content: 'setx PASSWORD hunter2' }],
    ['compound CMD setx', { content: 'setx DB_PASSWORD hunter2' }],
    ['machine CMD setx', { content: 'setx /M DB_PASSWORD hunter2' }],
    ['JSON password', { content: '{"password":"hunter2"}' }],
    ['compound JSON password', { content: '{"DB_PASSWORD": "hunter2"}' }],
    ['PowerShell password', { content: "$Password = 'Summer2026!'" }],
    ['PowerShell secure string', { content: "ConvertTo-SecureString 'Summer2026!' -AsPlainText -Force" }],
    ['PowerShell named secure string', { content: "ConvertTo-SecureString -String 'Summer2026!' -AsPlainText -Force" }],
    ['PowerShell reordered secure string', { content: "ConvertTo-SecureString -AsPlainText -Force -String 'Summer2026!'" }],
    ['database URI userinfo', { content: 'DATABASE_URL=postgres://admin:hunter2@db.example/app' }],
    ['recovery key assignment', { content: 'RECOVERY_KEY=ABC-123' }],
    ['authorization assignment', { content: 'Authorization = Basic dXNlcjpwYXNz' }],
    ['credential value suffix assignment', { content: 'PASSWORD_VALUE=hunter2' }],
    ['token backup suffix assignment', { content: 'TOKEN_BACKUP=hunter2' }],
    ['quoted credential token', { content: 'echo "PASSWORD=hunter2"' }],
    ['CLI credential assignment', { content: 'mysql --password=hunter2' }],
    ['CLI credential argument', { content: 'tool --password hunter2' }],
    ['compound CLI credential argument', { content: 'tool --api-key hunter2' }],
    ['PowerShell credential argument', { content: 'pwsh -Password hunter2' }],
  ])('rejects low-entropy credential assignment syntax: %s', (_name, definition) => {
    expect(inspectDefinitionForSecrets(definition)).toMatchObject({
      safe: false,
      reason: 'secret_detected',
    });
  });

  it.each([
    'echo rotate the local account every 90 days',
    'ACCOUNT_NAME',
    'setx INSTALL_MODE production',
    'ConvertTo-SecureString $encryptedBlob',
    'DATABASE_URL=postgres://db.example/app',
    '{"rotationPolicy":"rotate_every_90_days"}',
  ])('allows nearby benign script content: %s', (content) => {
    expect(inspectDefinitionForSecrets({ content })).toEqual({ safe: true });
  });

  it.each([
    'local_admin_password', 'backup-api-token', 'serviceCredential',
    'recovery_key', 'bitlocker_recovery_key', 'password_value',
    'credential_value', 'secret_note', 'token_backup',
  ])
    ('rejects a secret-semantic identifier value: %s', (fieldKey) => {
      expect(inspectDefinitionForSecrets({ fieldKey, value: 'Summer2026!' })).toMatchObject({
        safe: false,
        reason: 'secret_detected',
      });
    });

  it('keeps credential syntax inspection linear at the maximum inspectable size', () => {
    const content = 'echo ordinary setting; '.repeat(1000)
      .slice(0, PARTNER_EXPORT_MAX_INSPECTABLE_STRING_LENGTH)
      .padEnd(PARTNER_EXPORT_MAX_INSPECTABLE_STRING_LENGTH, '.');
    const result = inspectCredentialSyntax(content);
    expect(result.secretLike).toBe(false);
    expect(result.operations).toBeLessThanOrEqual(content.length * 3 + 10);
  });

  it('fails closed when the tokenizer budget is exhausted before a credential assignment', () => {
    const content = `${'='.repeat(10_001)}PASSWORD=hunter2`;
    expect(content.length).toBeLessThanOrEqual(PARTNER_EXPORT_MAX_INSPECTABLE_STRING_LENGTH);
    const result = inspectCredentialSyntax(content);
    expect(result.secretLike).toBe(true);
    expect(result.operations).toBeLessThanOrEqual(content.length * 3 + 10);
    expect(inspectDefinitionForSecrets({ content })).toMatchObject({
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

  it('fully inspects every permitted string position without former window gaps', () => {
    expect(PARTNER_EXPORT_MAX_INSPECTABLE_STRING_LENGTH).toBe(maxInspectableStringLength);
    for (const offset of [4080, 5000, 8170, 10_000]) {
      const command = `${'.'.repeat(offset)}${embeddedCredential}${'.'.repeat(
        maxInspectableStringLength - offset - embeddedCredential.length,
      )}`;
      expect(command).toHaveLength(maxInspectableStringLength);
      expect(inspectDefinitionForSecrets({ command })).toMatchObject({
        safe: false,
        reason: 'secret_detected',
      });
    }
  });

  it('detects an entropy token split around former scan-window boundaries', () => {
    const command = `${' '.repeat(4090)}${embeddedCredential} ordinary trailing script text`;
    expect(inspectDefinitionForSecrets({ command })).toMatchObject({
      safe: false,
      reason: 'secret_detected',
    });
  });

  it('fails closed on secrets placed at multiple former sampled-window gaps', () => {
    for (const offset of [6000, 14_000]) {
      const command = `${'.'.repeat(offset)}${embeddedCredential}`.padEnd(20_000, '.');
      expect(inspectDefinitionForSecrets({ command })).toMatchObject({
        safe: false,
        reason: 'secret_detected',
      });
    }
  });

  it('allows a safe string at the exact limit and blocks every longer string', () => {
    const exactLimit = 'echo ordinary safe script text; '.padEnd(maxInspectableStringLength, '.');
    expect(exactLimit).toHaveLength(maxInspectableStringLength);
    expect(inspectDefinitionForSecrets({ command: exactLimit })).toEqual({ safe: true });

    const overLimit = `${exactLimit}.`;
    expect(overLimit).toHaveLength(maxInspectableStringLength + 1);
    const result = safelyExportDefinition(
      { resource: 'scripts', id: ID, orgId: ORG_ID },
      { command: overLimit },
    );
    expect(result).toMatchObject({
      safe: false,
      blocked: {
        resource: 'scripts',
        id: ID,
        orgId: ORG_ID,
        reason: 'secret_detected',
      },
    });
    expect(result).not.toHaveProperty('definition');
    expect(JSON.stringify(result)).not.toContain(overLimit);
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

  it('never dereferences the child that would exceed the visit budget', () => {
    const values = new Array<unknown>(10_000);
    let overBudgetRead = false;
    const guardedValues = new Proxy(values, {
      get(target, property, receiver) {
        if (property === '9999') {
          overBudgetRead = true;
          throw new Error('the 10,001st value was dereferenced');
        }
        return Reflect.get(target, property, receiver);
      },
    });

    let result: ReturnType<typeof safelyExportDefinition> | undefined;
    expect(() => {
      result = safelyExportDefinition(
        { resource: 'scripts', id: ID, orgId: ORG_ID },
        guardedValues,
      );
    }).not.toThrow();
    expect(overBudgetRead).toBe(false);
    expect(result).toMatchObject({
      safe: false,
      blocked: { reason: 'secret_detected' },
    });
    expect(result).not.toHaveProperty('definition');
  });

  it('never dereferences a getter whose child would exceed the depth budget', () => {
    let overDepthRead = false;
    let definition: Record<string, unknown> = {};
    Object.defineProperty(definition, 'overDepth', {
      enumerable: true,
      get() {
        overDepthRead = true;
        throw new Error('the over-depth child was dereferenced');
      },
    });
    for (let depth = 0; depth < 32; depth += 1) definition = { next: definition };

    let result: ReturnType<typeof safelyExportDefinition> | undefined;
    expect(() => {
      result = safelyExportDefinition(
        { resource: 'configuration-policies', id: ID, orgId: ORG_ID },
        definition,
      );
    }).not.toThrow();
    expect(overDepthRead).toBe(false);
    expect(result).toMatchObject({
      safe: false,
      blocked: { reason: 'secret_detected' },
    });
    expect(result).not.toHaveProperty('definition');
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

  it('skips the structural layer on machine-observed inventory fields', () => {
    // A high-entropy-looking device path on device-inventory must NOT block.
    const inventory = { disks: [{ device: '/dev/mapper/ubuntu--vg-ubuntu--lv' }] };
    expect(inspectDefinitionForSecrets(inventory, 'device-inventory')).toEqual({ safe: true });
  });

  it('still runs the structural layer on customer-authored fields', () => {
    // Same shape under scripts (customer-authored) still exercises the layer;
    // an actual embedded credential must block.
    const script = { content: `export TOKEN=${embeddedCredential}` };
    expect(inspectDefinitionForSecrets(script, 'scripts'))
      .toMatchObject({ safe: false, reason: 'secret_detected' });
  });

  it('keeps global pattern + field-name layers on machine-observed fields', () => {
    // A forbidden field name blocks even on an inventory resource.
    expect(inspectDefinitionForSecrets({ apiKey: 'anything' }, 'device-inventory'))
      .toMatchObject({ safe: false, reason: 'secret_detected' });
    // An explicit token pattern blocks even on an inventory resource.
    expect(inspectDefinitionForSecrets(
      { note: 'ghp_A9dK2mQ7xR4tV8wY1zB3cN6fH0jL5pS2uE7g' },
      'device-inventory',
    )).toMatchObject({ safe: false, reason: 'secret_detected' });
  });

  it('defaults to scanning every field when no resource is supplied', () => {
    // Backward-compatible: omitting resource still runs the structural layer.
    // Use a genuinely secret-like token (short delimited paths are correctly safe).
    expect(inspectDefinitionForSecrets({ value: 'kR8xQ2mVp7LnWc4TgYhBz6JdFs1AeNu9XvCiPo3R' }))
      .toMatchObject({ safe: false });
  });

  it('does not flag delimited machine paths embedded in customer-authored script content', () => {
    // Script content (customer-authored, structural layer ON) legitimately
    // contains long device paths. Segment-aware detection must let them pass.
    const script = { content: [
      'mount /dev/mapper/ubuntu--vg-ubuntu--lv /mnt/data',
      'ls -la /var/lib/docker/overlay2/containers',
    ].join('\n') };
    expect(inspectDefinitionForSecrets(script, 'scripts')).toEqual({ safe: true });
  });

  it('flags a random secret token in customer-authored content via the segment detector', () => {
    for (const token of [
      'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      'kR8xQ2mVp7LnWc4TgYhBz6JdFs1AeNu9XvCiPo3R',
      'de305d5475b4431badb2eb6b9e546014aabbccdd',
    ]) {
      expect(inspectDefinitionForSecrets({ value: token }, 'custom-field-values'))
        .toMatchObject({ safe: false, reason: 'secret_detected' });
    }
  });
});
