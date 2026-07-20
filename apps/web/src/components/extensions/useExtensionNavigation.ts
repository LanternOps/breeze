// Enabled-extension top-level navigation links for the Sidebar's "Extensions"
// section (Task 5). Reuses the registry client from Task 4 — this hook does
// NOT fetch or validate the registry document itself, only projects+re-checks
// the `navigation` array of each already-validated `RuntimeWebExtension`.
//
// SECURITY — `href` is a second trust boundary, independent of
// `runtimeWebRegistrySchema` (registry.ts). That schema only proves the wire
// shape is well-formed; it says nothing about whether a given `path` stays
// inside `/extensions/<extension-name>/...`. A compromised/misbehaving
// registry response could otherwise smuggle a nav item whose href points
// anywhere (`/settings/users`, `//evil.example.com`, `/../admin`) and have it
// rendered as a real Sidebar `<a href>`. `isSafeExtensionHref` below is the
// one place that re-derives and re-validates every href before it can reach
// the DOM.
import { useEffect, useState } from 'react';
import {
  getExtensionRegistry,
  type RuntimeWebExtension,
  type RuntimeWebNavItem,
  type RuntimeWebRegistry,
} from '@/lib/extensions/registry';

export interface ExtensionNavLink {
  readonly name: string;
  readonly href: string;
}

// Mirrors packages/extension-sdk/src/manifest.ts NAME_RE — kept as a literal
// copy (not imported) so this trust-boundary check never silently changes
// behavior via an unrelated package bump.
const EXTENSION_NAME_RE = /^[a-z][a-z0-9-]{1,31}$/;

// Mirrors manifest.ts's `absoluteWebPath` character allowlist.
const SAFE_HREF_CHARS_RE = /^\/[a-zA-Z0-9\-_./]*$/;

/**
 * True only for `/extensions/<extensionName>/...` (or exactly
 * `/extensions/<extensionName>`), built from a well-formed extension name,
 * using only the character set the server's own manifest schema allows, and
 * containing no `..` traversal segment.
 */
function isSafeExtensionHref(href: string, extensionName: string): boolean {
  if (!EXTENSION_NAME_RE.test(extensionName)) return false;
  if (!SAFE_HREF_CHARS_RE.test(href)) return false;
  if (href.split('/').includes('..')) return false;
  const prefix = `/extensions/${extensionName}`;
  return href === prefix || href.startsWith(`${prefix}/`);
}

interface RankedNavLink {
  readonly link: ExtensionNavLink;
  readonly order: number;
  readonly extensionName: string;
  readonly contributionId: string;
}

function toRankedNavLink(
  extension: RuntimeWebExtension,
  item: RuntimeWebNavItem,
): RankedNavLink | null {
  const href = `/extensions/${extension.name}${item.path}`;
  if (!isSafeExtensionHref(href, extension.name)) return null;
  return {
    link: { name: item.label, href },
    // Undefined `order` sorts after every explicitly ordered item, never
    // before — an extension that doesn't care about position shouldn't be
    // able to jump ahead of ones that do.
    order: item.order ?? Number.POSITIVE_INFINITY,
    extensionName: extension.name,
    contributionId: item.id ?? item.path,
  };
}

/** order -> extension name -> contribution id (id, falling back to the
 *  manifest-unique path), matching the server projection's own tie-break
 *  (webRegistry.ts `pageOrNavKey`). */
function compareRanked(a: RankedNavLink, b: RankedNavLink): number {
  if (a.order !== b.order) return a.order - b.order;
  const nameCompare = a.extensionName.localeCompare(b.extensionName);
  if (nameCompare !== 0) return nameCompare;
  return a.contributionId.localeCompare(b.contributionId);
}

/** Pure projection, exported for direct unit-testing of the sort/validation
 *  rules without mounting a component or mocking the registry client. */
export function extensionNavLinksFromRegistry(registry: RuntimeWebRegistry): ExtensionNavLink[] {
  return registry.extensions
    .flatMap((extension) => extension.navigation.map((item) => toRankedNavLink(extension, item)))
    .filter((ranked): ranked is RankedNavLink => ranked !== null)
    .sort(compareRanked)
    .map((ranked) => ranked.link);
}

/**
 * Enabled runtime-extension navigation links, deterministically ordered.
 * Never throws: a registry fetch failure (401, network error, shape
 * mismatch) resolves to an empty list, same "hide the addition, never break
 * the host" posture as the rest of the extension surface.
 */
export function useExtensionNavigation(): ExtensionNavLink[] {
  const [links, setLinks] = useState<ExtensionNavLink[]>([]);

  useEffect(() => {
    let cancelled = false;

    getExtensionRegistry()
      .then((registry) => {
        if (cancelled) return;
        setLinks(extensionNavLinksFromRegistry(registry));
      })
      .catch(() => {
        if (!cancelled) setLinks([]);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return links;
}
