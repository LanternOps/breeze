/**
 * Scheme guard shared by `MarkdownBody`'s `image` rule override and its
 * `onLinkPress` handler.
 *
 * `react-native-markdown-display`'s default `image` rule renders a live
 * `<Image source={{uri}}>` unconditionally on mount — no tap, no
 * confirmation — for any URL the model streams, including one carrying
 * exfiltrated data in its query string. Its default `link` rule opens
 * whatever `href` it is given via `Linking.openURL`, with no scheme
 * restriction, unlike the equivalent web/helper overrides which reject
 * anything but `http(s)`.
 *
 * Pure logic, not a component: `apps/mobile`'s Vitest config deliberately
 * excludes `.tsx` so RN/Expo component imports never reach the test runner
 * (see `vitest.config.ts`). `MarkdownBody.tsx` imports this and wires it
 * into its `image` rule and `onLinkPress`; neither is covered by a component
 * render test here for that reason — this module's own coverage is the
 * scheme-guard logic itself.
 */

/** Only `http(s)` survives; every other scheme (`javascript:`, `data:`, a
 *  bare relative path) is treated as unsafe. */
export function isSafeHttpUrl(url: string | undefined | null): boolean {
  return typeof url === 'string' && /^https?:\/\//i.test(url);
}
