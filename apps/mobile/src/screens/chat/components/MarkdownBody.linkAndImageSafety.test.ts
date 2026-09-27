import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// MarkdownBody.tsx cannot be rendered under this project's vitest runtime —
// no React Native test runtime is configured (see vitest.config.ts's comment
// and MfaChallengeScreen.test.ts's precedent) — so this reads the real
// shipped source and asserts structurally instead of via render.
//
// The gap: `react-native-markdown-display`'s default `image` rule renders a
// live `<Image>` unconditionally on mount for any URL the model streams, and
// its default `link` rule opens whatever `href` it is given via
// `Linking.openURL` with no scheme restriction. `onLinkPress={() => true}`
// (the prior wiring) compounds the second half by unconditionally approving
// every link regardless of scheme.

const HERE = dirname(fileURLToPath(import.meta.url));

function readSource(): string {
  return readFileSync(join(HERE, 'MarkdownBody.tsx'), 'utf8');
}

describe('MarkdownBody image auto-load and link scheme guards', () => {
  it('overrides the `image` rule instead of relying on the library default', () => {
    const source = readSource();
    expect(source).toMatch(/rules\s*:\s*RenderRules\s*=\s*useMemo\(\s*\(\)\s*=>\s*\(\{[\s\S]*?\bimage\s*:/);
  });

  it('does not unconditionally approve every link scheme via onLinkPress', () => {
    const source = readSource();
    // The unguarded prior wiring: `onLinkPress={() => true}` with no url param
    // inspected at all.
    expect(source).not.toMatch(/onLinkPress=\{\(\)\s*=>\s*true\}/);
  });

  it('gates onLinkPress and the image rule through the shared http(s) scheme guard', () => {
    const source = readSource();
    expect(source).toContain("from './safeMarkdownLinks'");
    expect(source).toContain('isSafeHttpUrl');
  });
});
