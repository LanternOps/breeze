import { describe, expect, it } from 'vitest';
import { SOFTWARE_INSTALL_SCRIPT_TIMEOUT_MS } from '@breeze/shared';
import type { InstallerVariableContext } from './installerVariables';
import {
  buildInstallScriptPayload,
  findParameterKeyCollisions,
  parameterEnvName,
  scriptLanguageForOs,
  scriptTokenToParameterKey,
} from './installScriptPayload';

function ctx(overrides: Partial<InstallerVariableContext> = {}): InstallerVariableContext {
  return {
    org: { id: 'org-1', name: 'Acme Corp' },
    site: { id: 'site-1', name: 'HQ' },
    device: { hostname: 'ws-01', customFields: { asset_tag: 'A 1' } },
    vars: {},
    ...overrides,
  };
}

describe('scriptLanguageForOs', () => {
  it('binds the language to the device OS', () => {
    expect(scriptLanguageForOs('windows')).toBe('powershell');
    expect(scriptLanguageForOs('macos')).toBe('bash');
    expect(scriptLanguageForOs('linux')).toBe('bash');
    expect(scriptLanguageForOs('')).toBeNull();
    expect(scriptLanguageForOs('plan9')).toBeNull();
  });
});

describe('scriptTokenToParameterKey', () => {
  it('rewrites dots to underscores', () => {
    expect(scriptTokenToParameterKey('var.controld_provisioning_code')).toBe('var_controld_provisioning_code');
    expect(scriptTokenToParameterKey('device.customField.asset_tag')).toBe('device_customField_asset_tag');
    expect(scriptTokenToParameterKey('org.name')).toBe('org_name');
  });
});

describe('buildInstallScriptPayload (#6958)', () => {
  it('(a) rewrites tokens to executor placeholders and carries the values as parameters', () => {
    const out = buildInstallScriptPayload('x {{var.code}} y {{install.dir}}', 'windows', ctx({ vars: { code: 'ab12cd' } }));
    expect(out).toEqual({
      ok: true,
      payload: {
        language: 'powershell',
        content: 'x {{var_code}} y {{install_dir}}',
        parameters: { var_code: 'ab12cd' },
        timeoutSeconds: SOFTWARE_INSTALL_SCRIPT_TIMEOUT_MS / 1000,
      },
    });
    expect(SOFTWARE_INSTALL_SCRIPT_TIMEOUT_MS / 1000).toBe(600);
  });

  it('(b) a hostile value appears only in parameters, never in the script text', () => {
    const value = 'a; Remove-Item C:\\';
    const out = buildInstallScriptPayload('ctrld.exe start --cd-org {{var.code}}', 'windows', ctx({ vars: { code: value } }));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.payload.content).not.toContain(value);
    expect(out.payload.content).toBe('ctrld.exe start --cd-org {{var_code}}');
    expect(out.payload.parameters).toEqual({ var_code: value });
  });

  it('(c) a missing variable is unresolved', () => {
    expect(buildInstallScriptPayload('echo {{var.code}}', 'macos', ctx())).toEqual({
      ok: false,
      unresolved: ['{{var.code}}'],
    });
  });

  it('(d) keys that fold to one BREEZE_PARAM_ env name collide (agent paramrefs.go parameterEnvName)', () => {
    // Today's token grammar cannot produce such a pair (var keys are lowercase,
    // every namespace has a distinct prefix), so the guard is exercised on the
    // folding rule itself: uppercase, '-' -> '_'.
    expect(parameterEnvName('var_code')).toBe('BREEZE_PARAM_VAR_CODE');
    expect(parameterEnvName('a-b')).toBe('BREEZE_PARAM_A_B');
    expect(findParameterKeyCollisions(['a-b', 'a_b'])).toEqual(['a-b', 'a_b']);
    expect(findParameterKeyCollisions(['Path', 'PATH', 'other'])).toEqual(['PATH', 'Path']);
    expect(findParameterKeyCollisions(['org_name', 'var_code'])).toEqual([]);
    // The agent-owned keys are reserved in any case or separator form.
    expect(findParameterKeyCollisions(['INSTALL-DIR'])).toEqual(['INSTALL-DIR']);
    expect(findParameterKeyCollisions(['install_file'])).toEqual(['install_file']);
  });

  it('(d) the env-name fold mirrors the agent: uppercase and "-" -> "_"', () => {
    // org.name -> org_name; a custom field literally named org_name maps to
    // device_customField_org_name, so no collision. A repeat of the SAME
    // token is not a collision.
    const out = buildInstallScriptPayload('{{org.name}} {{org.name}} {{ org.name }}', 'linux', ctx());
    expect(out).toEqual({
      ok: true,
      payload: expect.objectContaining({ content: '{{org_name}} {{org_name}} {{org_name}}', parameters: { org_name: 'Acme Corp' } }),
    });
  });

  it('install.dir / install.file become agent-filled placeholders with no server value', () => {
    const out = buildInstallScriptPayload('cp "{{install.file}}" "{{ install.dir }}/x"', 'macos', ctx());
    expect(out).toEqual({
      ok: true,
      payload: expect.objectContaining({
        language: 'bash',
        content: 'cp "{{install_file}}" "{{install_dir}}/x"',
        parameters: {},
      }),
    });
  });

  it('values are not charset-filtered: they travel as env references (spaces, quotes are fine)', () => {
    const out = buildInstallScriptPayload('{{device.customField.asset_tag}} {{site.name}}', 'windows', ctx());
    expect(out).toEqual({
      ok: true,
      payload: expect.objectContaining({
        parameters: { device_customField_asset_tag: 'A 1', site_name: 'HQ' },
      }),
    });
  });

  it('a script with no tokens is passed through unchanged', () => {
    const out = buildInstallScriptPayload('Write-Output "hello"', 'windows', ctx());
    expect(out).toEqual({
      ok: true,
      payload: { language: 'powershell', content: 'Write-Output "hello"', parameters: {}, timeoutSeconds: 600 },
    });
  });

  it('an unknown token, a loose var token and a $-escaped var token are unresolved', () => {
    const out = buildInstallScriptPayload('{{nope}} {{ var.code }} ${{var.code}}', 'linux', ctx({ vars: { code: 'x' } }));
    expect(out).toEqual({ ok: false, unresolved: ['{{nope}}', '{{ var.code }}', '{{var.code}}'] });
  });

  it('a value the agent would refuse (NUL byte, over 8 KiB) is unresolved, not dispatched', () => {
    expect(buildInstallScriptPayload('{{var.code}}', 'linux', ctx({ vars: { code: 'a\u0000b' } })).ok).toBe(false);
    expect(buildInstallScriptPayload('{{var.code}}', 'linux', ctx({ vars: { code: 'x'.repeat(8193) } })).ok).toBe(false);
    expect(buildInstallScriptPayload('{{var.code}}', 'linux', ctx({ vars: { code: 'x'.repeat(8192) } })).ok).toBe(true);
  });

  it('a parameter key longer than the agent accepts (64) is unresolved', () => {
    const key = `k${'x'.repeat(62)}`; // var_ + 63 chars = 67 > 64
    const out = buildInstallScriptPayload(`{{var.${key}}}`, 'linux', ctx({ vars: { [key]: 'v' } }));
    expect(out).toEqual({ ok: false, unresolved: [`{{var.${key}}}`] });
  });

  it('an unsupported OS is refused', () => {
    expect(buildInstallScriptPayload('echo', 'plan9', ctx())).toEqual({ ok: false, unresolved: [], unsupportedOs: true });
  });
});
