import { useEffect, useRef, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { BTN_BLOCK, BTN_DANGER, BTN_PRIMARY, BTN_SECONDARY, LINK, StatusMark, type MarkTone } from '../ui';
import { SummaryList, type SummaryRow } from './SummaryList';

export type PanelAction = {
  label: string; testId?: string; disabled?: boolean; variant?: 'primary' | 'secondary' | 'danger' | 'link';
} & ({ href: string; onClick?: never } | { onClick: () => void; href?: never });

function Action({ action, fallback }: { action: PanelAction; fallback: 'primary' | 'secondary' | 'link' }) {
  const variant = action.variant ?? fallback;
  const className = variant === 'link' ? LINK
    : cn(variant === 'danger' ? BTN_DANGER : variant === 'primary' ? BTN_PRIMARY : BTN_SECONDARY, BTN_BLOCK);
  return action.href !== undefined
    ? <a href={action.href} className={cn(className, variant === 'link' && 'self-center')} data-testid={action.testId}>{action.label}</a>
    : <button type="button" onClick={action.onClick} disabled={action.disabled} className={className} data-testid={action.testId}>{action.label}</button>;
}

/**
 * One grammar for every outcome, empty and error state on the client pages: an
 * optional status mark, a serif title, a few short lines, an optional summary and
 * at most two actions. The heading takes focus when the state appears so a screen
 * reader announces it (no icon-in-a-circle: DESIGN.md).
 */
export function StatePanel({ mark, title, children, summary, primary, secondary, headingLevel = 1, testId, tone }: {
  mark?: { tone: MarkTone; label: string }; title: string; children?: ReactNode; summary?: SummaryRow[];
  primary?: PanelAction | null; secondary?: PanelAction | null; headingLevel?: 1 | 2; testId?: string;
  /** Announce as an alert (destructive outcomes). */
  tone?: 'alert';
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus({ preventScroll: true }); }, [title]);
  const H = headingLevel === 1 ? 'h1' : 'h2';
  return (
    <div className="space-y-4" role={tone === 'alert' ? 'alert' : 'status'} data-testid={testId}>
      {mark && <StatusMark tone={mark.tone}>{mark.label}</StatusMark>}
      <H ref={heading} tabIndex={-1}
        className={cn('font-display font-semibold leading-tight tracking-tight text-foreground outline-none',
          headingLevel === 1 ? 'text-[1.5rem] sm:text-[1.75rem]' : 'text-xl')}>
        {title}
      </H>
      {children && <div className="max-w-prose space-y-3 text-sm leading-relaxed text-foreground/85">{children}</div>}
      {summary && summary.length > 0 && <SummaryList rows={summary} />}
      {(primary || secondary) && (
        <div className="flex flex-col gap-3 pt-1 sm:flex-row sm:flex-wrap sm:items-center">
          {primary && <Action action={primary} fallback="primary" />}
          {secondary && <Action action={secondary} fallback="link" />}
        </div>
      )}
    </div>
  );
}

export default StatePanel;
