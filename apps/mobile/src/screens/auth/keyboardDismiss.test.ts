import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// #5104: MfaChallengeScreen/LoginScreen/HomeScreen cannot be rendered under
// this project's vitest runtime (see MfaChallengeScreen.test.ts's comment —
// no React Native test runtime is configured), so this reads the real
// shipped source and asserts on function-body text instead of behavior via
// render. The bug was: the navigator swap after a successful verify/login
// unmounts the focused TextInput, but the OS-level keyboard doesn't follow
// it down unless something explicitly calls `Keyboard.dismiss()` first — so
// it stayed up, floating over whatever screen came next.

const HERE = dirname(fileURLToPath(import.meta.url));

function readSource(relativePath: string): string {
  return readFileSync(join(HERE, relativePath), 'utf8');
}

/**
 * Slices out `function <name>(...) { ... }` (or `async function`) by
 * brace-matching from the first `{` after the signature — a plain substring
 * search can't bound the function body since nested `{`/`}` (the callback in
 * `.then`, object literals passed to `dispatch(...)`) would close on the
 * wrong brace.
 */
function extractBraceBody(source: string, openingPattern: RegExp, label: string): string {
  const match = openingPattern.exec(source);
  if (!match) {
    throw new Error(`Could not find ${label} — did the screen get refactored?`);
  }
  const bodyStart = match.index + match[0].length;
  let depth = 1;
  let i = bodyStart;
  for (; i < source.length && depth > 0; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') depth--;
  }
  return source.slice(bodyStart, i - 1);
}

/** `async function <name>(...) { ... }` (LoginScreen, MfaChallengeScreen). */
function extractFunctionBody(source: string, functionName: string): string {
  return extractBraceBody(
    source,
    new RegExp(`(?:async\\s+)?function\\s+${functionName}\\s*\\([^)]*\\)\\s*\\{`),
    `"function ${functionName}(...)"`
  );
}

/** `const <name> = useCallback(\n  async (...) => { ... }` (HomeScreen). */
function extractCallbackBody(source: string, constName: string): string {
  return extractBraceBody(
    source,
    new RegExp(`const\\s+${constName}\\s*=\\s*useCallback\\s*\\(\\s*(?:async\\s+)?\\([^)]*\\)\\s*=>\\s*\\{`),
    `"const ${constName} = useCallback(async (...) => {...`
  );
}

function assertDismissBeforeDispatch(body: string, dispatchNeedle: string, label: string) {
  const dismissIndex = body.indexOf('Keyboard.dismiss()');
  const dispatchIndex = body.indexOf(dispatchNeedle);
  expect(dismissIndex, `${label}: expected Keyboard.dismiss() call, found none`).toBeGreaterThanOrEqual(0);
  expect(dispatchIndex, `${label}: expected a "${dispatchNeedle}" call, found none`).toBeGreaterThanOrEqual(0);
  expect(
    dismissIndex,
    `${label}: Keyboard.dismiss() must run BEFORE "${dispatchNeedle}" — dismissing after the navigator has already swapped screens is too late`
  ).toBeLessThan(dispatchIndex);
}

describe('keyboard dismissed before navigation-triggering dispatch (#5104)', () => {
  it('MfaChallengeScreen.handleVerify dismisses before dispatching verifyMfaAsync', () => {
    const body = extractFunctionBody(readSource('MfaChallengeScreen.tsx'), 'handleVerify');
    assertDismissBeforeDispatch(body, 'dispatch(verifyMfaAsync', 'handleVerify');
  });

  it('LoginScreen.handleLogin dismisses before dispatching loginAsync', () => {
    const body = extractFunctionBody(readSource('LoginScreen.tsx'), 'handleLogin');
    assertDismissBeforeDispatch(body, 'dispatch(loginAsync', 'handleLogin');
  });

  it('HomeScreen.handleSend dismisses before starting a turn', () => {
    const body = extractCallbackBody(readSource('../chat/HomeScreen.tsx'), 'handleSend');
    assertDismissBeforeDispatch(body, 'cancelTurnWork()', 'handleSend');
  });
});
