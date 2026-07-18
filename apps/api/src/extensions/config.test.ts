import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  loadExtensionDeploymentConfig,
  parseExtensionDeploymentConfig,
} from './config';

describe('parseExtensionDeploymentConfig', () => {
  it('requires a digest in production and refuses unsigned-development mode', () => {
    expect(() => parseExtensionDeploymentConfig('extensions: [{ name: demo, uri: file:./demo.breeze-ext }]', {
      production: true,
      allowUnsigned: false,
    })).toThrow(/digest/);
    expect(() => parseExtensionDeploymentConfig('extensions: []', {
      production: true,
      allowUnsigned: true,
    })).toThrow(/unsigned.*production/i);
  });

  it('parses a well-formed production config and applies defaults', () => {
    const digest = `sha256:${'a'.repeat(64)}`;
    const config = parseExtensionDeploymentConfig(
      [
        'publishers:',
        '  acme:',
        '    publicKeyFile: keys/acme.pub',
        'extensions:',
        '  - name: demo',
        '    uri: file:./demo.breeze-ext',
        '    publisher: acme',
        `    digest: ${digest}`,
      ].join('\n'),
      { production: true, allowUnsigned: false },
    );

    expect(config.publishers).toEqual({ acme: { publicKeyFile: 'keys/acme.pub' } });
    expect(config.extensions).toHaveLength(1);
    expect(config.extensions[0]).toEqual({
      name: 'demo',
      uri: 'file:./demo.breeze-ext',
      publisher: 'acme',
      digest,
      required: false,
      rollout: 'rolling',
    });
  });

  it('allows version-only selection in development', () => {
    const config = parseExtensionDeploymentConfig(
      [
        'publishers:',
        '  acme:',
        '    publicKeyFile: keys/acme.pub',
        'extensions:',
        '  - name: demo',
        '    uri: file:./demo.breeze-ext',
        '    publisher: acme',
        '    version: 1.2.3',
        '    required: true',
        '    rollout: replace',
      ].join('\n'),
      { production: false, allowUnsigned: true },
    );

    expect(config.extensions[0]).toMatchObject({
      version: '1.2.3',
      required: true,
      rollout: 'replace',
    });
    expect(config.extensions[0]?.digest).toBeUndefined();
  });

  it('rejects a malformed digest', () => {
    expect(() => parseExtensionDeploymentConfig(
      [
        'publishers:',
        '  acme:',
        '    publicKeyFile: keys/acme.pub',
        'extensions:',
        '  - name: demo',
        '    uri: file:./demo.breeze-ext',
        '    publisher: acme',
        '    digest: sha256:NOTHEX',
      ].join('\n'),
      { production: true, allowUnsigned: false },
    )).toThrow(/digest/);
  });

  it('rejects a publisher that is not declared in the publishers map', () => {
    expect(() => parseExtensionDeploymentConfig(
      [
        'extensions:',
        '  - name: demo',
        '    uri: file:./demo.breeze-ext',
        '    publisher: ghost',
        `    digest: sha256:${'a'.repeat(64)}`,
      ].join('\n'),
      { production: true, allowUnsigned: false },
    )).toThrow(/publisher/);
  });

  it('rejects duplicate extension names', () => {
    expect(() => parseExtensionDeploymentConfig(
      [
        'publishers:',
        '  acme:',
        '    publicKeyFile: keys/acme.pub',
        'extensions:',
        '  - name: demo',
        '    uri: file:./a.breeze-ext',
        '    publisher: acme',
        `    digest: sha256:${'a'.repeat(64)}`,
        '  - name: demo',
        '    uri: file:./b.breeze-ext',
        '    publisher: acme',
        `    digest: sha256:${'b'.repeat(64)}`,
      ].join('\n'),
      { production: true, allowUnsigned: false },
    )).toThrow(/unique|duplicate/i);
  });

  it('rejects unknown top-level keys (strict schema)', () => {
    expect(() => parseExtensionDeploymentConfig(
      'extensions: []\nsurprise: true',
      { production: false, allowUnsigned: false },
    )).toThrow();
  });
});

describe('loadExtensionDeploymentConfig', () => {
  const originalEnv = { ...process.env };
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'breeze-ext-config-'));
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('resolves publicKeyFile paths relative to the config file directory', () => {
    process.env.NODE_ENV = 'development';
    delete process.env.BREEZE_EXTENSIONS_ALLOW_UNSIGNED;
    const configPath = path.join(dir, 'extensions.yaml');
    writeFileSync(configPath, [
      'publishers:',
      '  acme:',
      '    publicKeyFile: keys/acme.pub',
      'extensions: []',
    ].join('\n'));

    const config = loadExtensionDeploymentConfig(configPath);
    expect(config.publishers.acme?.publicKeyFile).toBe(path.join(dir, 'keys/acme.pub'));
  });

  it('enforces production digest requirement derived from NODE_ENV', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.BREEZE_EXTENSIONS_ALLOW_UNSIGNED;
    const configPath = path.join(dir, 'extensions.yaml');
    writeFileSync(configPath, [
      'publishers:',
      '  acme:',
      '    publicKeyFile: keys/acme.pub',
      'extensions:',
      '  - name: demo',
      '    uri: file:./demo.breeze-ext',
      '    publisher: acme',
    ].join('\n'));

    expect(() => loadExtensionDeploymentConfig(configPath)).toThrow(/digest/);
  });

  it('rejects unsigned mode in production derived from env', () => {
    process.env.NODE_ENV = 'Production';
    process.env.BREEZE_EXTENSIONS_ALLOW_UNSIGNED = 'true';
    const configPath = path.join(dir, 'extensions.yaml');
    writeFileSync(configPath, 'extensions: []');

    expect(() => loadExtensionDeploymentConfig(configPath)).toThrow(/unsigned.*production/i);
  });
});
