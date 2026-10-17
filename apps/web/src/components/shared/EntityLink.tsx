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

export interface EntityLinkProps {
  kind: EntityKind;
  id: string;
  name: string;
  hash?: string;
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
export function EntityLink({ kind, id, name, hash, className }: EntityLinkProps): JSX.Element {
  // No id, or no name to show: plain text, never an empty/dead tab stop.
  if (id === '' || name === '') {
    return <span className={className}>{name}</span>;
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
      className={cn('hover:underline', className)}
      onClick={handleClick}
    >
      {name}
    </a>
  );
}
