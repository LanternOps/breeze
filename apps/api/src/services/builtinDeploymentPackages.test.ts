import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { detectionRulesSchema, validateSoftwareVersionInstallSpec } from '@breeze/shared';
import {
  BUILTIN_PACKAGES,
  BUILTIN_TENANT_VAR_PACKAGES,
  builtinPackageKeysForVendor,
  getBuiltinPackage,
  serviceRunningNamesFor,
} from './builtinDeploymentPackages';

// Note: the DB-backed ensureBuiltinPackage tests live in
// src/__tests__/integration/builtinDeploymentPackages.integration.test.ts
// (real partner fixture, runs as breeze_app). This file stays pure-unit.

describe('builtin deployment packages', () => {
  it('defines a Windows-only Huntress package with derivable URL + keys', () => {
    const pkg = getBuiltinPackage('huntress');
    expect(pkg.vendor).toBe('Huntress');
    expect(pkg.fileType).toBe('exe');
    expect(pkg.supportedOs).toEqual(['windows']);
    expect(pkg.requiresBinaryUpload).toBe(false);
    expect(pkg.downloadUrlTemplate).toContain('{huntress_acct_key}');
    expect(pkg.silentInstallArgsTemplate).toContain('{huntress_acct_key}');
    expect(pkg.silentInstallArgsTemplate).toContain('{huntress_org_key}');
  });

  it('defines a SentinelOne package that needs a binary upload and a site token', () => {
    const pkg = getBuiltinPackage('sentinelone');
    expect(pkg.vendor).toBe('SentinelOne');
    expect(pkg.fileType).toBe('msi');
    expect(pkg.supportedOs).toEqual(['windows']);
    expect(pkg.requiresBinaryUpload).toBe(true);
    expect(pkg.silentInstallArgsTemplate).toContain('{s1_site_token}');
  });

  it('SentinelOne install args must carry the single-brace site-token placeholder', async () => {
    const { installArgPlaceholders, installArgsCarryPlaceholders } = await import('./builtinDeploymentPackages');
    expect(installArgPlaceholders('sentinelone')).toEqual(['{s1_site_token}']);
    expect(installArgPlaceholders('huntress')).toEqual(['{huntress_acct_key}', '{huntress_org_key}']);
    expect(installArgsCarryPlaceholders('sentinelone', 'SITE_TOKEN={s1_site_token} /q /NORESTART')).toBe(true);
    expect(installArgsCarryPlaceholders('sentinelone', 'msiexec /i "{file}" /qn /norestart')).toBe(false);
    expect(installArgsCarryPlaceholders('sentinelone', 'SITE_TOKEN={{s1_site_token}}')).toBe(false);
    expect(installArgsCarryPlaceholders('sentinelone', '')).toBe(false);
    expect(installArgsCarryPlaceholders('sentinelone', null)).toBe(false);
  });

  it('exposes both providers', () => {
    expect(Object.keys(BUILTIN_PACKAGES).sort()).toEqual(['huntress', 'sentinelone']);
  });
});

// ---------------------------------------------------------------------------
// #6958 PR D: code-pinned DNS filtering client built-ins.
// ---------------------------------------------------------------------------
describe('pinned DNS built-in packages (#6958)', () => {
  const FIXTURE_DIR = resolve(__dirname, '../../../../agent/internal/remote/tools/testdata/builtin_scripts');
  const fixture = (file: string) => readFileSync(resolve(FIXTURE_DIR, file), 'utf8');

  it('defines exactly the three keys with the plan values', () => {
    expect(Object.keys(BUILTIN_TENANT_VAR_PACKAGES).sort()).toEqual(['controld_macos', 'controld_windows', 'nextdns_windows']);
    const cw = BUILTIN_TENANT_VAR_PACKAGES.controld_windows;
    expect(cw).toMatchObject({
      key: 'controld_windows', vendorKey: 'controld', name: 'Control D (Windows)', vendor: 'Control D',
      category: 'security', websiteUrl: 'https://controld.com', os: 'windows', hidden: false,
      version: '1.5.8', fileType: 'zip', originalFileName: 'ctrld_1.5.8_windows_amd64.zip',
      downloadUrl: 'https://github.com/Control-D-Inc/ctrld/releases/download/v1.5.8/ctrld_1.5.8_windows_amd64.zip',
      checksum: '7a72bab5ad384f9028c48f166f7872b5fc64f7210e65bbb59ce4d257d36df310',
      preInstallScript: null, requiredVars: ['controld_provisioning_code'],
      uninstallCommand: 'C:\\ControlD\\ctrld.exe uninstall',
    });
    expect(cw.detectionRules).toEqual([
      { type: 'file_exists', path: 'C:\\ControlD\\ctrld.exe' },
      { type: 'service_running', serviceName: 'ctrld' },
    ]);
    const cm = BUILTIN_TENANT_VAR_PACKAGES.controld_macos;
    expect(cm).toMatchObject({
      key: 'controld_macos', vendorKey: 'controld', name: 'Control D (macOS)', vendor: 'Control D',
      category: 'security', websiteUrl: 'https://controld.com',
      os: 'macos', hidden: true, version: '1.5.8', fileType: 'pkg',
      originalFileName: 'ctrld_1.5.8_darwin_universal.pkg',
      downloadUrl: 'https://github.com/Control-D-Inc/ctrld/releases/download/v1.5.8/ctrld_1.5.8_darwin_universal.pkg',
      checksum: 'dfc94e649e8a38fa04a314ff2d23fba59903cea217a315deafb9bece6979ec3c',
      requiredVars: ['controld_provisioning_code'], uninstallCommand: 'sudo /usr/local/bin/ctrld uninstall',
    });
    expect(cm.detectionRules).toEqual([
      { type: 'file_exists', path: '/usr/local/bin/ctrld' },
      { type: 'service_running', serviceName: 'ctrld' },
    ]);
    const nw = BUILTIN_TENANT_VAR_PACKAGES.nextdns_windows;
    expect(nw).toMatchObject({
      key: 'nextdns_windows', vendorKey: 'nextdns', name: 'NextDNS CLI (Windows)', vendor: 'NextDNS',
      category: 'security', websiteUrl: 'https://nextdns.io', os: 'windows', hidden: false,
      version: '1.47.3', fileType: 'zip',
      originalFileName: 'nextdns_1.47.3_windows_amd64.zip',
      downloadUrl: 'https://github.com/nextdns/nextdns/releases/download/v1.47.3/nextdns_1.47.3_windows_amd64.zip',
      checksum: 'b9ea2c3b2286d62aff63c48356c06ee75bf9fb775b7d9800b3c0d9febaedcbfc',
      preInstallScript: null, requiredVars: ['nextdns_profile_id'],
      uninstallCommand: '"C:\\Program Files\\nextdns\\nextdns.exe" uninstall',
    });
    expect(nw.detectionRules).toEqual([
      { type: 'file_exists', path: 'C:\\Program Files\\nextdns\\nextdns.exe' },
      { type: 'service_running', serviceName: 'nextdns' },
    ]);
  });

  // A hidden def is still a complete def: every structural assertion runs on it too.
  for (const def of Object.values(BUILTIN_TENANT_VAR_PACKAGES)) {
    describe(def.key, () => {
      it('passes the shared detection-rules schema and the install-spec validator', () => {
        expect(detectionRulesSchema.safeParse(def.detectionRules).success).toBe(true);
        expect(validateSoftwareVersionInstallSpec({
          fileType: def.fileType,
          supportedOs: [def.os],
          silentInstallArgs: null,
          preInstallScript: def.preInstallScript,
          postInstallScript: def.postInstallScript,
        })).toEqual([]);
      });

      it('pins a GitHub release asset by sha256', () => {
        expect(def.checksum).toMatch(/^[a-f0-9]{64}$/);
        expect(def.downloadUrl.startsWith('https://github.com/')).toBe(true);
        expect(def.downloadUrl).toContain(`/releases/download/v${def.version}/`);
        expect(def.downloadUrl.endsWith(`/${def.originalFileName}`)).toBe(true);
      });

      it('references only its own requiredVars in {{var.*}} tokens', () => {
        const vars = new Set<string>();
        for (const script of [def.preInstallScript, def.postInstallScript]) {
          for (const m of (script ?? '').matchAll(/\{\{var\.([a-zA-Z0-9_]+)\}\}/g)) vars.add(m[1]!);
        }
        expect([...vars].sort()).toEqual([...def.requiredVars].sort());
      });

      it('agrees with serviceRunningNamesFor', () => {
        expect(serviceRunningNamesFor(def.key)).toEqual(
          def.detectionRules.flatMap((r) => (r.type === 'service_running' ? [r.serviceName] : [])),
        );
      });
    });
  }

  it('scripts are byte copies of the agent fixtures (PR B, the byte source of truth)', () => {
    expect(BUILTIN_TENANT_VAR_PACKAGES.controld_windows.postInstallScript).toBe(fixture('controld_windows_post.ps1'));
    expect(BUILTIN_TENANT_VAR_PACKAGES.controld_macos.preInstallScript).toBe(fixture('controld_macos_pre.sh'));
    expect(BUILTIN_TENANT_VAR_PACKAGES.controld_macos.postInstallScript).toBe(fixture('controld_macos_post.sh'));
    expect(BUILTIN_TENANT_VAR_PACKAGES.nextdns_windows.postInstallScript).toBe(fixture('nextdns_windows_post.ps1'));
  });

  it('Review Focus 5: macOS managed-prefs file is marked, root-only, and removed only when marked', () => {
    const pre = BUILTIN_TENANT_VAR_PACKAGES.controld_macos.preInstallScript!;
    const post = BUILTIN_TENANT_VAR_PACKAGES.controld_macos.postInstallScript!;
    // Never overwrite a file Breeze did not write (MDM-delivered prefs).
    expect(pre).toMatch(/BreezeWritten 2>\/dev\/null\)" != "1" \]; then\n\s*exit 0/);
    expect(pre).toContain('/usr/bin/defaults write "$DOMAIN" BreezeWritten -bool true');
    // Symbolic mode: the agent executor's setuid/setgid pattern rejects octal `chmod 600`.
    expect(pre).toContain('chmod u=rw,go= "$DOMAIN.plist"');
    expect(pre).not.toContain('chmod 600');
    expect(post).toContain('if [ "$(/usr/bin/defaults read "$DOMAIN" BreezeWritten 2>/dev/null)" = "1" ]; then rm -f "$DOMAIN.plist"; fi');
    expect(post.match(/\brm\b/g)).toHaveLength(1);
  });

  it('serviceRunningNamesFor / builtinPackageKeysForVendor', () => {
    expect(serviceRunningNamesFor('nextdns_windows')).toEqual(['nextdns']);
    expect(serviceRunningNamesFor('controld_windows')).toEqual(['ctrld']);
    expect(builtinPackageKeysForVendor('controld')).toEqual({ windows: 'controld_windows', macos: 'controld_macos' });
    expect(builtinPackageKeysForVendor('nextdns')).toEqual({ windows: 'nextdns_windows' });
  });

  it('the definitions are frozen', () => {
    expect(Object.isFrozen(BUILTIN_TENANT_VAR_PACKAGES)).toBe(true);
    expect(Object.isFrozen(BUILTIN_TENANT_VAR_PACKAGES.controld_windows)).toBe(true);
    expect(Object.isFrozen(BUILTIN_TENANT_VAR_PACKAGES.controld_windows.detectionRules)).toBe(true);
  });
});
