import type { JSX, MouseEvent } from 'react';
import { cn } from '@/lib/utils';
import { navigateTo } from '@/lib/navigation';

export type EntityKind = 'org' | 'site' | 'device' | 'ticket' | 'alert';

const ENTITY_PATHS: Record<EntityKind, string> = {
  org: '/organizations',
  site: '/settings/sites',
  device: '/devices',
  ticket: '/tickets',
  alert: '/alerts',
};

/** Canonical record URL for an entity. `id` is encoded as a single path segment. */
export function entityHref(kind: EntityKind, id: string, hash?: string): string {
  const base = `${ENTITY_PATHS[kind]}/${encodeURIComponent(id)}`;
  if (!hash) return base;
  return `${base}#${hash.startsWith('#') ? hash.slice(1) : hash}`;
}

/**
 * Text colour of the link. Colour is reserved for state, so neither tone
 * changes on hover — only the underline does. `primary` for the record a row
 * is about (device hostname, ticket), `muted` for secondary context (org and
 * site cells, metadata lines).
 */
export type EntityLinkTone = 'primary' | 'muted';

const TONE_CLASS: Record<EntityLinkTone, string> = {
  primary: 'text-foreground',
  muted: 'text-muted-foreground',
};

// #9033: a quiet, always-visible underline (token colour) so a link inside a
// cursor-pointer row is distinguishable from plain text at rest; hover/focus
// make it solid. inline-flex + min-h keeps a 24px target. The name sits in a
// truncating inner span so a link in a narrow cell still ellipsizes (an
// overflowing inline-flex box would otherwise be swallowed whole by the
// parent's ellipsis).
const LINK_CLASS =
  'inline-flex max-w-full min-h-[24px] items-center rounded-sm underline underline-offset-4 decoration-border ' +
  'hover:decoration-current focus-visible:decoration-current focus-visible:outline-none ' +
  'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2';

export interface EntityLinkProps {
  kind: EntityKind;
  id: string;
  name: string;
  hash?: string;
  tone?: EntityLinkTone;
  /**
   * -1 inside a focusable row that already opens the record on Enter (#9037),
   * so each row costs one tab stop; the anchor stays real for middle-click.
   */
  tabIndex?: number;
  className?: string;
}

/**
 * A quiet link to an org / site / device / ticket / alert record.
 *
 * Safe inside any clickable row: it always stops propagation so the row
 * handler does not fire. Because React's stopPropagation also halts the native
 * event, Astro's document-level <ClientRouter /> never sees the click, so a
 * plain primary click soft-navigates itself; modified clicks (cmd/ctrl/shift/alt,
 * non-primary button) are left to the browser so they open a tab/window.
 *
 * An empty `id` (the '' sentinel for "no site/org") renders the name as text.
 */
export function EntityLink({ kind, id, name, hash, tone = 'primary', tabIndex, className }: EntityLinkProps): JSX.Element {
  // No id, or no name to show: plain text, never an empty/dead tab stop.
  if (id === '' || name === '') {
    return <span className={cn(TONE_CLASS[tone], className)}>{name}</span>;
  }

  const href = entityHref(kind, id, hash);

  const handleClick = (e: MouseEvent<HTMLAnchorElement>) => {
    e.stopPropagation();
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    void navigateTo(href);
  };

  return (
    <a
      href={href}
      data-testid={`${kind}-record-link`}
      tabIndex={tabIndex}
      className={cn(LINK_CLASS, TONE_CLASS[tone], className)}
      onClick={handleClick}
    >
      <span className="min-w-0 truncate">{name}</span>
    </a>
  );
}
