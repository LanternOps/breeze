import { describe, it, expect } from 'vitest';
import {
  substituteInstallerVariables,
  resolveInstallerVariables,
  type InstallerVariableContext,
} from './installerVariables';

const ctx: InstallerVariableContext = {
  org: { id: 'org-123', name: 'Acme Corp' },
  site: { id: 'site-9', name: 'HQ' },
  device: {
    hostname: 'WKS-014',
    customFields: { license_key: 'ABC-999', region: 'us-east', blank: '' },
  },
  vars: { repo_url: 'https://dl.example/pkg', blank_var: '' },
};

describe('substituteInstallerVariables', () => {
  it('returns the template untouched when it has no variables', () => {
    const r = substituteInstallerVariables('https://example.com/app.msi', ctx);
    expect(r.value).toBe('https://example.com/app.msi');
    expect(r.unresolved).toEqual([]);
  });

  it('passes null through', () => {
    expect(substituteInstallerVariables(null, ctx)).toEqual({ value: null, unresolved: [] });
  });

  it.each([
    ['{{org.name}}', 'Acme Corp'],
    ['{{org.id}}', 'org-123'],
    ['{{site.name}}', 'HQ'],
    ['{{site.id}}', 'site-9'],
    ['{{device.hostname}}', 'WKS-014'],
    ['{{device.customField.license_key}}', 'ABC-999'],
  ])('resolves built-in / custom token %s', (token, expected) => {
    const r = substituteInstallerVariables(`x-${token}-y`, ctx);
    expect(r.value).toBe(`x-${expected}-y`);
    expect(r.unresolved).toEqual([]);
  });

  it('tolerates inner whitespace', () => {
    expect(substituteInstallerVariables('{{ org.name }}', ctx).value).toBe('Acme Corp');
  });

  it('resolves multiple variables in one string', () => {
    const r = substituteInstallerVariables(
      'https://dl/{{org.id}}/{{device.customField.region}}/app.msi',
      ctx,
    );
    expect(r.value).toBe('https://dl/org-123/us-east/app.msi');
    expect(r.unresolved).toEqual([]);
  });

  it('leaves the single-brace {file} agent token alone', () => {
    const r = substituteInstallerVariables('msiexec /i "{file}" /qn {{org.id}}', ctx);
    expect(r.value).toBe('msiexec /i "{file}" /qn org-123');
    expect(r.unresolved).toEqual([]);
  });

  it('flags an unknown token and leaves it verbatim', () => {
    const r = substituteInstallerVariables('https://dl/{{org.licence}}/app.msi', ctx);
    expect(r.value).toBe('https://dl/{{org.licence}}/app.msi');
    expect(r.unresolved).toEqual(['{{org.licence}}']);
  });

  it('treats a missing or empty custom field as unresolved (fail loudly)', () => {
    const missing = substituteInstallerVariables('{{device.customField.absent}}', ctx);
    expect(missing.unresolved).toEqual(['{{device.customField.absent}}']);
    const blank = substituteInstallerVariables('{{device.customField.blank}}', ctx);
    expect(blank.unresolved).toEqual(['{{device.customField.blank}}']);
  });

  it('treats an empty built-in value (e.g. blank hostname) as unresolved', () => {
    const blankHost = substituteInstallerVariables('https://dl/{{device.hostname}}/app.msi', {
      ...ctx,
      device: { hostname: '', customFields: {} },
    });
    expect(blankHost.unresolved).toEqual(['{{device.hostname}}']);
    const blankSite = substituteInstallerVariables('https://dl/{{site.name}}/app.msi', {
      ...ctx,
      site: { id: 'site-9', name: '' },
    });
    expect(blankSite.unresolved).toEqual(['{{site.name}}']);
  });

  it('handles a null customFields bag', () => {
    const r = substituteInstallerVariables('{{device.customField.license_key}}', {
      ...ctx,
      device: { hostname: 'H', customFields: null },
    });
    expect(r.unresolved).toEqual(['{{device.customField.license_key}}']);
  });
});

// #3409 PR2 — the `var.<key>` arm, resolved from the caller-prefetched `vars` map.
describe('substituteInstallerVariables — var.* (#3409 PR2)', () => {
  it('resolves {{var.key}} from the prefetched map', () => {
    const r = substituteInstallerVariables('{{var.repo_url}}/pkg.msi', ctx);
    expect(r.value).toBe('https://dl.example/pkg/pkg.msi');
    expect(r.unresolved).toEqual([]);
  });

  it('treats an empty variable value as unresolved (fail loudly)', () => {
    const r = substituteInstallerVariables('{{var.blank_var}}', ctx);
    expect(r.unresolved).toEqual(['{{var.blank_var}}']);
  });

  it('flags an unknown variable key as unresolved', () => {
    const r = substituteInstallerVariables('{{var.no_such_key}}', ctx);
    expect(r.unresolved).toEqual(['{{var.no_such_key}}']);
  });

  it('does not resolve ${{var.key}} — the $-escape excludes it, exactly like script content', () => {
    // The leading `$` means "shell/Actions syntax, not a Breeze variable" in
    // the shared var.* grammar (variableTokens.ts). This tokenizer cannot
    // literally leave the WHOLE `${{var.repo_url}}` span alone (its own TOKEN
    // regex has no `$`-exclusion and that regex is deliberately left
    // untouched — see the module docblock): it still matches the inner
    // `{{var.repo_url}}` and reports IT as unresolved. What matters is what
    // it must NEVER do — substitute the variable's value in — and it
    // doesn't: the value string is unchanged and the key is reported
    // unresolved, same as any other unrecognized token.
    const r = substituteInstallerVariables('run ${{var.repo_url}}', ctx);
    expect(r.value).toBe('run ${{var.repo_url}}');
    expect(r.unresolved).toEqual(['{{var.repo_url}}']);
  });

  it('does NOT resolve {{ var.key }} with inner whitespace — one strict form only, matching the script-content grammar', () => {
    // Every OTHER namespace here tolerates inner whitespace (see "tolerates
    // inner whitespace" above) — that leniency is deliberately NOT extended
    // to var.*, because a script containing `{{ var.x }}` is invisible to
    // findVariableTokens (the same grammar used for save-time secret
    // rejection and dispatch-time substitution): it is not recognized as a
    // variable reference there at all, so resolving it here would silently
    // succeed on the exact form the script path treats as inert literal
    // text — a divergence between the two surfaces. Reported unresolved,
    // same as any other unrecognized token.
    const r = substituteInstallerVariables('{{ var.repo_url }}', ctx);
    expect(r.value).toBe('{{ var.repo_url }}');
    expect(r.unresolved).toEqual(['{{ var.repo_url }}']);
  });

  it('resolves a var.* token alongside built-in/custom tokens in one template', () => {
    const r = substituteInstallerVariables(
      'https://dl/{{org.id}}/{{var.repo_url}}?key={{device.customField.license_key}}',
      ctx,
    );
    expect(r.value).toBe('https://dl/org-123/https://dl.example/pkg?key=ABC-999');
    expect(r.unresolved).toEqual([]);
  });
});

describe('resolveInstallerVariables', () => {
  it('resolves both fields and de-duplicates unresolved tokens', () => {
    const r = resolveInstallerVariables(
      'https://dl/{{org.bogus}}/app.msi',
      'run {{org.bogus}} now',
      ctx,
    );
    expect(r.downloadUrl).toBe('https://dl/{{org.bogus}}/app.msi');
    expect(r.silentInstallArgs).toBe('run {{org.bogus}} now');
    expect(r.unresolved).toEqual(['{{org.bogus}}']); // de-duped across both fields
  });

  it('returns clean values when everything resolves', () => {
    const r = resolveInstallerVariables(
      'https://dl/{{org.id}}/app.msi',
      'msiexec /i "{file}" /qn KEY={{device.customField.license_key}}',
      ctx,
    );
    expect(r.downloadUrl).toBe('https://dl/org-123/app.msi');
    expect(r.silentInstallArgs).toBe('msiexec /i "{file}" /qn KEY=ABC-999');
    expect(r.unresolved).toEqual([]);
  });

  // A custom-field value lands verbatim in the argv the agent splits from
  // silentInstallArgs. A value containing whitespace can smuggle in an
  // entire extra flag: a value of `X TRANSFORMS=\\host\share\t.mst`
  // becomes a second, unintended argv element once substituted into an
  // unquoted template.
  it('fails a device whose custom-field value would inject a new argv token', () => {
    const injectingCtx: InstallerVariableContext = {
      ...ctx,
      device: {
        ...ctx.device,
        customFields: { lic: 'X TRANSFORMS=\\\\host\\share\\t.mst' },
      },
    };
    const r = resolveInstallerVariables(
      null,
      '/qn LICENSEKEY={{device.customField.lic}}',
      injectingCtx,
    );
    expect(r.silentInstallArgs).toBe('/qn LICENSEKEY={{device.customField.lic}}');
    expect(r.unresolved).toEqual(['{{device.customField.lic}}']);
  });

  it('fails a device whose custom-field value would break out of template quoting', () => {
    const injectingCtx: InstallerVariableContext = {
      ...ctx,
      device: {
        ...ctx.device,
        customFields: { lic: 'abc" /X /evil="1' },
      },
    };
    const r = resolveInstallerVariables(
      null,
      'msiexec /qn LICENSEKEY="{{device.customField.lic}}"',
      injectingCtx,
    );
    expect(r.unresolved).toEqual(['{{device.customField.lic}}']);
  });

  it('still substitutes a safe custom-field value into silentInstallArgs', () => {
    const r = resolveInstallerVariables(
      null,
      '/qn LICENSEKEY={{device.customField.license_key}}',
      ctx,
    );
    expect(r.silentInstallArgs).toBe('/qn LICENSEKEY=ABC-999');
    expect(r.unresolved).toEqual([]);
  });

  it('does not apply the argv charset restriction to the download URL', () => {
    // org.name ("Acme Corp") has a space and is a built-in field, not a
    // device-writable custom field — the argv restriction targets custom
    // fields specifically and must not break existing URL templates.
    const r = resolveInstallerVariables(
      'https://dl/{{org.name}}/app.msi',
      null,
      ctx,
    );
    expect(r.downloadUrl).toBe('https://dl/Acme Corp/app.msi');
    expect(r.unresolved).toEqual([]);
  });
});

describe('resolveInstallerVariables — org.name / site.name in silentInstallArgs', () => {
  it('quotes a safe org.name value substituted into silentInstallArgs (names legitimately contain spaces)', () => {
    const r = resolveInstallerVariables(
      null,
      '/qn CUSTOMER={{org.name}}',
      ctx,
    );
    expect(r.silentInstallArgs).toBe('/qn CUSTOMER="Acme Corp"');
    expect(r.unresolved).toEqual([]);
  });

  it('quotes a safe site.name value substituted into silentInstallArgs', () => {
    const r = resolveInstallerVariables(
      null,
      '/qn SITE={{site.name}}',
      ctx,
    );
    expect(r.silentInstallArgs).toBe('/qn SITE="HQ"');
    expect(r.unresolved).toEqual([]);
  });

  it('fails a device whose site.name would inject a new argv token and break out of quoting', () => {
    const injectingCtx: InstallerVariableContext = {
      ...ctx,
      site: { ...ctx.site, name: '" /quiet INSTALLDIR=C:\\evil' },
    };
    const r = resolveInstallerVariables(
      null,
      'msiexec /qn CUSTOMER={{site.name}}',
      injectingCtx,
    );
    expect(r.unresolved).toEqual(['{{site.name}}']);
  });

  it('fails a device whose org.name contains a literal double quote', () => {
    const injectingCtx: InstallerVariableContext = {
      ...ctx,
      org: { ...ctx.org, name: 'Acme "Corp"' },
    };
    const r = resolveInstallerVariables(
      null,
      '/qn CUSTOMER={{org.name}}',
      injectingCtx,
    );
    expect(r.unresolved).toEqual(['{{org.name}}']);
  });

  it('fails a device whose org.name ends in a trailing backslash (would sit directly before the closing quote)', () => {
    const injectingCtx: InstallerVariableContext = {
      ...ctx,
      org: { ...ctx.org, name: 'Acme Corp\\' },
    };
    const r = resolveInstallerVariables(
      null,
      '/qn CUSTOMER={{org.name}}',
      injectingCtx,
    );
    expect(r.unresolved).toEqual(['{{org.name}}']);
  });

  it('still allows org.name unquoted/unrestricted in downloadUrl (not argv-safe)', () => {
    const injectingCtx: InstallerVariableContext = {
      ...ctx,
      org: { ...ctx.org, name: 'Acme "Corp"' },
    };
    const r = resolveInstallerVariables(
      'https://dl/{{org.name}}/app.msi',
      null,
      injectingCtx,
    );
    expect(r.downloadUrl).toBe('https://dl/Acme "Corp"/app.msi');
    expect(r.unresolved).toEqual([]);
  });
});

// Ported verbatim from `splitCommandLine` in
// agent/internal/remote/tools/software_install.go:823 so these tests assert
// against the agent's real argv-splitting semantics rather than a guess at
// them. Any drift between this port and the Go source should be caught by
// keeping the two side by side and diffing on review, not by a shared
// import (the API and the agent are different languages/build systems).
function splitCommandLine(s: string): string[] {
  const args: string[] = [];
  let current = '';
  let inQuote = false;
  for (const ch of s) {
    if (ch === '"') {
      inQuote = !inQuote;
    } else if (ch === ' ' && !inQuote) {
      if (current.length > 0) {
        args.push(current);
        current = '';
      }
    } else {
      current += ch;
    }
  }
  if (current.length > 0) args.push(current);
  return args;
}

describe('resolveInstallerVariables — org.name/site.name quote-aware substitution (2026-09-25 follow-up)', () => {
  it('quotes an unquoted template so the name stays one argv element', () => {
    const r = resolveInstallerVariables(null, 'msiexec /qn CUSTOMER={{org.name}}', ctx);
    expect(r.silentInstallArgs).toBe('msiexec /qn CUSTOMER="Acme Corp"');
    expect(splitCommandLine(r.silentInstallArgs!)).toEqual([
      'msiexec',
      '/qn',
      'CUSTOMER=Acme Corp',
    ]);
  });

  it('does not re-quote a template that already wraps the token in quotes', () => {
    const r = resolveInstallerVariables(null, 'msiexec /qn TRANSFORMS="{{org.name}}"', ctx);
    // Must NOT be `""Acme Corp""` — that double-quote pair cancels out under
    // splitCommandLine and reintroduces the space-breaks-argv bug.
    expect(r.silentInstallArgs).toBe('msiexec /qn TRANSFORMS="Acme Corp"');
    expect(splitCommandLine(r.silentInstallArgs!)).toEqual([
      'msiexec',
      '/qn',
      'TRANSFORMS=Acme Corp',
    ]);
  });

  it('does not re-quote a template that wraps site.name in quotes', () => {
    const r = resolveInstallerVariables(null, 'msiexec /qn SITE="{{site.name}}"', {
      ...ctx,
      site: { ...ctx.site, name: 'North Office' },
    });
    expect(r.silentInstallArgs).toBe('msiexec /qn SITE="North Office"');
    expect(splitCommandLine(r.silentInstallArgs!)).toEqual([
      'msiexec',
      '/qn',
      'SITE=North Office',
    ]);
  });

  it('handles a name containing an apostrophe the same way whether the template pre-quotes it or not', () => {
    const apostropheCtx: InstallerVariableContext = {
      ...ctx,
      org: { ...ctx.org, name: "O'Brien's Shop" },
    };
    const unquoted = resolveInstallerVariables(
      null,
      'msiexec /qn CUSTOMER={{org.name}}',
      apostropheCtx,
    );
    expect(unquoted.silentInstallArgs).toBe('msiexec /qn CUSTOMER="O\'Brien\'s Shop"');
    expect(splitCommandLine(unquoted.silentInstallArgs!)).toEqual([
      'msiexec',
      '/qn',
      "CUSTOMER=O'Brien's Shop",
    ]);

    const preQuoted = resolveInstallerVariables(
      null,
      'msiexec /qn CUSTOMER="{{org.name}}"',
      apostropheCtx,
    );
    expect(preQuoted.silentInstallArgs).toBe('msiexec /qn CUSTOMER="O\'Brien\'s Shop"');
    expect(splitCommandLine(preQuoted.silentInstallArgs!)).toEqual([
      'msiexec',
      '/qn',
      "CUSTOMER=O'Brien's Shop",
    ]);
  });

  it('still rejects a quote-breakout value inside a pre-quoted template', () => {
    const injectingCtx: InstallerVariableContext = {
      ...ctx,
      org: { ...ctx.org, name: 'Acme " /quiet INSTALLDIR=C:\\evil' },
    };
    const r = resolveInstallerVariables(
      null,
      'msiexec /qn CUSTOMER="{{org.name}}"',
      injectingCtx,
    );
    expect(r.unresolved).toEqual(['{{org.name}}']);
  });
});
