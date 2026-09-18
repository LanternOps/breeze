/** C0 controls, ASCII space, and Unicode spaces browsers strip before reading a scheme. */
const HREF_SCHEME_NOISE =
  /[\u0000-\u0020\u00a0\u1680\u2000-\u200d\u2028\u2029\u202f\u205f\u3000\ufeff]/g;

export function canonicalizeHrefForSchemeCheck(href: string): string {
  return href.replace(HREF_SCHEME_NOISE, '');
}
