import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import type { MfaChallenge } from '../../services/api';
import { type as typeTokens } from '../../theme/typography';
import {
  getInitialNativeMfaMethod,
  getSupportedNativeMfaMethods,
  normalizeNativeMfaInput,
  normalizeNativeMfaSubmission,
} from './mfaChallengePresentation';

function challenge(overrides: Partial<MfaChallenge> = {}): MfaChallenge {
  return {
    tempToken: 'temp-1',
    mfaMethod: 'totp',
    methods: ['totp'],
    allowedMethods: { totp: true, sms: false, passkey: false },
    recoveryAvailable: false,
    phoneLast4: null,
    ...overrides,
  };
}

describe('MfaChallengeScreen presentation contract', () => {
  it('filters passkey from native choices while keeping recovery', () => {
    expect(getSupportedNativeMfaMethods(challenge({
      methods: ['totp', 'sms', 'passkey', 'recovery'],
    }))).toEqual(['totp', 'sms', 'recovery']);
  });

  it('returns no initial method for a passkey-only challenge', () => {
    const value = challenge({
      mfaMethod: 'passkey',
      methods: ['passkey'],
      allowedMethods: { totp: false, sms: false, passkey: true },
    });
    expect(getInitialNativeMfaMethod(value)).toBeNull();
  });

  it('falls back from a passkey primary to the first supported native method', () => {
    const value = challenge({ mfaMethod: 'passkey', methods: ['passkey', 'recovery'] });
    expect(getInitialNativeMfaMethod(value)).toBe('recovery');
  });

  it('keeps only six numeric digits for TOTP and SMS', () => {
    expect(normalizeNativeMfaInput('totp', '12a34 567')).toBe('123456');
    expect(normalizeNativeMfaInput('sms', '98-76')).toBe('9876');
  });

  it('preserves recovery separators and trims only outer whitespace on submit', () => {
    const raw = '  ABCD EFGH-IJKL  ';
    expect(normalizeNativeMfaInput('recovery', raw)).toBe(raw);
    expect(normalizeNativeMfaSubmission('recovery', raw)).toBe('ABCD EFGH-IJKL');
  });
});

// MfaChallengeScreen.tsx cannot be imported here: it (transitively, via the
// store and services layers) pulls in react-native, @sentry/react-native,
// react-native-svg, react-native-reanimated, expo-haptics and expo-secure-store
// — none of which have a test runtime under this project's vitest config
// (see the comment atop vitest.config.ts: component .tsx modules are
// deliberately kept out of the test graph). So instead of rendering the
// screen, this parses its real source with the TypeScript compiler API and
// inspects the literal style object the code-entry TextInput actually uses —
// that keeps the assertion honest against the shipped code without requiring
// a React Native test runtime.
describe('MfaChallengeScreen code input style', () => {
  function findCodeInputStyleOverride(): { fontSize?: number; lineHeight?: number } {
    const sourcePath = join(dirname(fileURLToPath(import.meta.url)), 'MfaChallengeScreen.tsx');
    const source = readFileSync(sourcePath, 'utf8');
    const sourceFile = ts.createSourceFile(
      sourcePath,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );

    let override: { fontSize?: number; lineHeight?: number } | null = null;

    function visit(node: ts.Node) {
      if (ts.isObjectLiteralExpression(node)) {
        const hasFontSize = node.properties.some(
          (p) =>
            ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'fontSize',
        );
        if (hasFontSize) {
          const found: { fontSize?: number; lineHeight?: number } = {};
          for (const prop of node.properties) {
            if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue;
            if (
              (prop.name.text === 'fontSize' || prop.name.text === 'lineHeight') &&
              ts.isNumericLiteral(prop.initializer)
            ) {
              found[prop.name.text as 'fontSize' | 'lineHeight'] = Number(prop.initializer.text);
            }
          }
          override = found;
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(sourceFile);

    if (!override) {
      throw new Error(
        'Could not find the code-input style override (an inline object literal with a ' +
          '`fontSize` property) in MfaChallengeScreen.tsx — did the style structure change?',
      );
    }
    return override;
  }

  it('gives the code input a lineHeight tall enough for its overridden fontSize on iOS', () => {
    const override = findCodeInputStyleOverride();

    // The code input's style is `[type.mono, { ...override }]` — React Native
    // flattens that left-to-right, so an explicit `lineHeight` in the override
    // wins; otherwise type.mono's lineHeight (sized for mono's own 14pt
    // fontSize) leaks through unchanged. At a 22pt override fontSize with a
    // 22pt inherited lineHeight, iOS clips the glyphs from the top — exactly
    // the reported bug. Require real headroom, not just fontSize <= lineHeight.
    expect(override.fontSize).toBe(22);
    const effectiveFontSize = override.fontSize as number;
    const effectiveLineHeight = override.lineHeight ?? typeTokens.mono.lineHeight;

    expect(effectiveLineHeight).toBeGreaterThanOrEqual(effectiveFontSize + 4);
  });
});
