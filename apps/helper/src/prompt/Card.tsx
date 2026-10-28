import type { CSSProperties, ReactNode } from 'react';

/*
 * The one on-device card (#10190 W04, spec 3.5): prompt cards (PromptCard,
 * kinds/*) and endpoint message cards (MessageCard) are drawn by this shell,
 * so they share one structure: who is asking, the title, the body, then the
 * status lines and the actions. The variant keeps each family's own classes,
 * so a message card looks exactly as it did before W04.
 *
 * Card renders no wrapper of its own around the slots: the root element is
 * the card (the window's 100vh box) and the slots are its direct children.
 * Content is passed as React nodes; nothing here ever renders a string as
 * markup.
 */

export type CardVariant = 'prompt' | 'message';

export interface CardProps {
  variant: CardVariant;
  /** The family's look (e.g. `helper-message-card is-warning`, `prompt-card is-pending`). */
  className: string;
  /** `alertdialog` for something that needs an answer, `dialog` otherwise. */
  role: 'dialog' | 'alertdialog';
  /** An accessible name (`aria-label`), or the id of the title (`aria-labelledby`). */
  label?: string;
  labelledBy?: string;
  style?: CSSProperties;
  dir?: 'ltr' | 'rtl';
  lang?: string;
  testId?: string;
  /** The prompt kind, for styling and tests (`data-kind`). */
  kind?: string;
  /** `none`: the card never moves keyboard focus (informational notices). */
  activation?: 'focus' | 'none';
  /** Who is asking: the identity header, or the message card's sender slot. */
  header: ReactNode;
  /** The title element (an `h1`). */
  title: ReactNode;
  /** The body element. */
  body: ReactNode;
  /** Status lines, actions and live regions, in this order. */
  children?: ReactNode;
}

export function Card({
  variant,
  className,
  role,
  label,
  labelledBy,
  style,
  dir,
  lang,
  testId,
  kind,
  activation,
  header,
  title,
  body,
  children,
}: CardProps) {
  return (
    <div
      className={className}
      data-card={variant}
      data-kind={kind}
      data-activation={activation}
      data-testid={testId}
      role={role}
      aria-label={label}
      aria-labelledby={labelledBy}
      style={style}
      dir={dir}
      lang={lang}
    >
      {header}
      {title}
      {body}
      {children}
    </div>
  );
}
