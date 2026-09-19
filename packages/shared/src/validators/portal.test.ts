import { describe, it, expect } from 'vitest';
import {
  updatePortalSettingsSchema,
  invitePortalUserSchema,
  bulkInvitePortalUsersSchema,
  updatePortalUserSchema,
  findUnsafePortalCssPattern,
  PORTAL_CUSTOM_CSS_MAX_LENGTH
} from './portal';

describe('updatePortalSettingsSchema', () => {
  it.each([true, false])('accepts enableDevices=%s independently of self-service', (enableDevices) => {
    expect(updatePortalSettingsSchema.parse({ enableDevices, enableSelfService: false }))
      .toEqual({ enableDevices, enableSelfService: false });
  });
  it.each([null, 'true', 1])('rejects invalid enableDevices=%s', (enableDevices) => {
    expect(updatePortalSettingsSchema.safeParse({ enableDevices }).success).toBe(false);
  });

  it('accepts a full valid payload', () => {
    const result = updatePortalSettingsSchema.safeParse({
      enableTickets: false,
      enableAssetCheckout: true,
      enableSelfService: true,
      enablePasswordReset: false,
      supportEmail: 'help@msp.example',
      supportPhone: '+1 555 0100',
      welcomeMessage: 'Welcome to support',
      footerText: 'MSP Inc.'
    });
    expect(result.success).toBe(true);
  });

  it('accepts a partial payload (single toggle)', () => {
    expect(updatePortalSettingsSchema.safeParse({ enableTickets: false }).success).toBe(true);
  });

  it('accepts an empty object (route layer rejects no-op separately)', () => {
    expect(updatePortalSettingsSchema.safeParse({}).success).toBe(true);
  });

  it('accepts null for the nullable string fields', () => {
    const result = updatePortalSettingsSchema.safeParse({
      supportEmail: null, supportPhone: null, welcomeMessage: null, footerText: null
    });
    expect(result.success).toBe(true);
  });

  it('rejects unknown keys (visual branding fields are not writable here)', () => {
    expect(updatePortalSettingsSchema.safeParse({ customDomain: 'evil.example' }).success).toBe(false);
    expect(updatePortalSettingsSchema.safeParse({ logoUrl: 'https://x/y.png' }).success).toBe(false);
    expect(updatePortalSettingsSchema.safeParse({ domainVerified: true }).success).toBe(false);
  });

  it('rejects an invalid support email', () => {
    expect(updatePortalSettingsSchema.safeParse({ supportEmail: 'not-an-email' }).success).toBe(false);
  });

  it('rejects null booleans', () => {
    expect(updatePortalSettingsSchema.safeParse({ enableTickets: null }).success).toBe(false);
  });

  it('accepts a supportEmail at exactly the 255-char limit', () => {
    const email = `${'a'.repeat(245)}@b.example`; // 245 + 10 = 255 chars
    expect(email).toHaveLength(255);
    expect(updatePortalSettingsSchema.safeParse({ supportEmail: email }).success).toBe(true);
  });

  it('accepts supportEmail: null on its own', () => {
    expect(updatePortalSettingsSchema.safeParse({ supportEmail: null }).success).toBe(true);
  });

  it('rejects over-length strings', () => {
    expect(updatePortalSettingsSchema.safeParse({ supportPhone: 'x'.repeat(51) }).success).toBe(false);
    expect(updatePortalSettingsSchema.safeParse({ supportEmail: `${'a'.repeat(250)}@b.example` }).success).toBe(false);
    expect(updatePortalSettingsSchema.safeParse({ welcomeMessage: 'x'.repeat(2001) }).success).toBe(false);
    expect(updatePortalSettingsSchema.safeParse({ footerText: 'x'.repeat(2001) }).success).toBe(false);
  });

  it('accepts all portal visibility flags', () => {
    expect(updatePortalSettingsSchema.parse({
      enableDashboard: true,
      enableSecurity: true,
      enableBackups: true,
      enableReports: true,
      enableSupportUsage: true,
    })).toEqual({
      enableDashboard: true,
      enableSecurity: true,
      enableBackups: true,
      enableReports: true,
      enableSupportUsage: true,
    });
  });

  it.each([true, false])('accepts the Network Visibility flag=%s', (enableNetworkVisibility) => {
    expect(updatePortalSettingsSchema.parse({ enableNetworkVisibility }))
      .toEqual({ enableNetworkVisibility });
  });

  it('rejects non-boolean portal visibility flags', () => {
    expect(updatePortalSettingsSchema.safeParse({
      enableDashboard: 'true',
    }).success).toBe(false);
  });
});

describe('updatePortalSettingsSchema customCss (#5952)', () => {
  it('accepts undefined/omitted and null', () => {
    expect(updatePortalSettingsSchema.safeParse({}).success).toBe(true);
    expect(updatePortalSettingsSchema.safeParse({ customCss: null }).success).toBe(true);
  });

  it('accepts benign CSS', () => {
    expect(updatePortalSettingsSchema.safeParse({
      customCss: '.portal-header { letter-spacing: 0.04em; color: #123456; }'
    }).success).toBe(true);
  });

  it('accepts CSS with an https: url()', () => {
    expect(updatePortalSettingsSchema.safeParse({
      customCss: '.bg { background: url(https://cdn.example/bg.png); }'
    }).success).toBe(true);
  });

  it('accepts CSS with a data: url()', () => {
    expect(updatePortalSettingsSchema.safeParse({
      customCss: ".bg { background: url('data:image/png;base64,AAAA'); }"
    }).success).toBe(true);
  });

  it('rejects @import', () => {
    expect(updatePortalSettingsSchema.safeParse({ customCss: '@import url("evil.css");' }).success).toBe(false);
  });

  it('rejects expression()', () => {
    expect(updatePortalSettingsSchema.safeParse({ customCss: 'body{width:expression(alert(1))}' }).success).toBe(false);
  });

  it('rejects behavior:', () => {
    expect(updatePortalSettingsSchema.safeParse({ customCss: 'body{behavior:url(x.htc)}' }).success).toBe(false);
  });

  it('rejects -moz-binding', () => {
    expect(updatePortalSettingsSchema.safeParse({ customCss: "body{-moz-binding:url('x.xml#x')}" }).success).toBe(false);
  });

  it('rejects url() with http:, javascript:, protocol-relative, or relative schemes', () => {
    expect(updatePortalSettingsSchema.safeParse({ customCss: 'a{background:url(http://evil.example/x.png)}' }).success).toBe(false);
    expect(updatePortalSettingsSchema.safeParse({ customCss: "a{background:url(javascript:alert(1))}" }).success).toBe(false);
    expect(updatePortalSettingsSchema.safeParse({ customCss: 'a{background:url(//evil.example/x.png)}' }).success).toBe(false);
    expect(updatePortalSettingsSchema.safeParse({ customCss: 'a{background:url(/local/x.png)}' }).success).toBe(false);
  });

  it(`rejects custom CSS over ${PORTAL_CUSTOM_CSS_MAX_LENGTH} chars`, () => {
    expect(updatePortalSettingsSchema.safeParse({
      customCss: 'a'.repeat(PORTAL_CUSTOM_CSS_MAX_LENGTH + 1)
    }).success).toBe(false);
  });

  it(`accepts custom CSS at exactly ${PORTAL_CUSTOM_CSS_MAX_LENGTH} chars`, () => {
    expect(updatePortalSettingsSchema.safeParse({
      customCss: 'a'.repeat(PORTAL_CUSTOM_CSS_MAX_LENGTH)
    }).success).toBe(true);
  });
});

describe('findUnsafePortalCssPattern', () => {
  it('returns null for clean CSS', () => {
    expect(findUnsafePortalCssPattern('.a { color: red; }')).toBeNull();
  });

  it('flags each dangerous pattern with a distinct label', () => {
    expect(findUnsafePortalCssPattern('@import "x.css";')).toBe('@import');
    expect(findUnsafePortalCssPattern('a{width:expression(x)}')).toBe('expression(');
    expect(findUnsafePortalCssPattern('a{behavior:url(x.htc)}')).toBe('behavior:');
    expect(findUnsafePortalCssPattern("a{-moz-binding:url('x.xml')}")).toBe('-moz-binding');
  });

  it('flags a disallowed url() scheme by value', () => {
    expect(findUnsafePortalCssPattern('a{background:url(http://evil.example/x.png)}')).toBe('url(http://evil.example/x.png)');
  });

  // Review finding (#5982): CSS identifiers/at-keywords support backslash
  // escapes per the CSS Syntax spec, and browsers decode them BEFORE parsing
  // keywords — a naive literal-text filter can be bypassed by escaping one
  // character of the blocked keyword. These prove the decode-before-scan
  // step catches the decoded form.
  describe('CSS-escape bypass attempts', () => {
    it('catches a hex-escaped @import (\\69 = "i")', () => {
      expect(findUnsafePortalCssPattern('@\\69mport "x.css";')).toBe('@import');
    });

    // CSS hex escapes greedily consume up to 6 hex digits, so when the
    // following literal char is itself a hex digit (e/E here) the spec
    // requires one trailing whitespace to terminate the escape — otherwise
    // `\72e` decodes as hex "72e", not "72" + "e". These two use that space.
    it('catches a hex-escaped expression( (\\72 = "r", space-terminated)', () => {
      expect(findUnsafePortalCssPattern('a{width:exp\\72 ession(x)}')).toBe('expression(');
    });

    it('catches a hex-escaped behavior: (\\62 = "b", space-terminated)', () => {
      expect(findUnsafePortalCssPattern('a{\\62 ehavior:url(x.htc)}')).toBe('behavior:');
    });

    it('catches a hex-escaped -moz-binding (\\62 = "b")', () => {
      expect(findUnsafePortalCssPattern("a{-moz-\\62inding:url('x.xml')}")).toBe('-moz-binding');
    });

    it('catches a literal-char-escaped @import (\\@)', () => {
      expect(findUnsafePortalCssPattern('\\@import "x.css";')).toBe('@import');
    });

    it('catches an escaped javascript: scheme inside url()', () => {
      expect(findUnsafePortalCssPattern('a{background:url(j\\61vascript:alert(1))}')).toContain('javascript:alert(1)');
    });

    it('still accepts clean CSS containing an unrelated escape (e.g. a content ligature)', () => {
      expect(findUnsafePortalCssPattern('a::before { content: "\\f101"; }')).toBeNull();
    });
  });
});

describe('invitePortalUserSchema', () => {
  it('accepts a valid invite', () => {
    expect(invitePortalUserSchema.safeParse({ email: 'a@b.example', name: 'A', message: 'hi' }).success).toBe(true);
  });
  it('rejects a bad email', () => {
    expect(invitePortalUserSchema.safeParse({ email: 'nope' }).success).toBe(false);
  });
  it('rejects an over-long message', () => {
    expect(invitePortalUserSchema.safeParse({ email: 'a@b.example', message: 'x'.repeat(1001) }).success).toBe(false);
  });
});

describe('updatePortalUserSchema', () => {
  it('accepts active/disabled status', () => {
    expect(updatePortalUserSchema.safeParse({ status: 'disabled' }).success).toBe(true);
  });
  it('rejects an invited status (not settable here)', () => {
    expect(updatePortalUserSchema.safeParse({ status: 'invited' }).success).toBe(false);
  });
});

describe('bulkInvitePortalUsersSchema', () => {
  it('accepts an optional userIds array of GUIDs', () => {
    expect(bulkInvitePortalUsersSchema.safeParse({ userIds: ['7c0a1f7e-1111-4222-8333-444455556666'] }).success).toBe(true);
    expect(bulkInvitePortalUsersSchema.safeParse({}).success).toBe(true);
  });
  it('rejects non-GUID ids', () => {
    expect(bulkInvitePortalUsersSchema.safeParse({ userIds: ['not-a-guid'] }).success).toBe(false);
  });
});

describe('updatePortalSettingsSchema W04 flags', () => {
  it('accepts the W04 service and documents flags', () => {
    expect(updatePortalSettingsSchema.safeParse({ enableService: true, enableDocuments: false }).success).toBe(true);
    expect(updatePortalSettingsSchema.safeParse({ enableLifecycle: true }).success).toBe(true);
  });
  it('still rejects an unknown flag', () => {
    expect(updatePortalSettingsSchema.safeParse({ enableProjects: true }).success).toBe(false);
  });
});
