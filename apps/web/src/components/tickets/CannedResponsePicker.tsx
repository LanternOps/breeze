import { useState } from 'react';
import { renderTemplate, type TicketTemplateVars } from '@breeze/shared';
import type { CannedResponse } from '../../lib/ticketResponseTemplatesApi';

interface Props {
  templates: CannedResponse[];
  /** Values substituted into the template body on insert (built from the ticket). */
  vars: TicketTemplateVars;
  onInsert: (text: string) => void;
  disabled?: boolean;
}

/** Dropdown that inserts a partner canned response (with merge variables resolved
 *  from the current ticket) into the reply composer. Self-hides when the partner
 *  has no templates so the toolbar stays clean. */
export default function CannedResponsePicker({ templates, vars, onInsert, disabled }: Props) {
  const [open, setOpen] = useState(false);
  if (templates.length === 0) return null;
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        data-testid="canned-picker-button"
        className="rounded-md px-2.5 py-1 text-xs font-medium text-muted-foreground hover:text-foreground disabled:opacity-50"
      >
        Canned response
      </button>
      {open && (
        <div
          className="absolute z-10 mt-1 max-h-64 w-64 overflow-auto rounded-md border bg-background py-1 shadow-md"
          data-testid="canned-picker-menu"
        >
          {templates.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => {
                onInsert(renderTemplate(t.body, vars));
                setOpen(false);
              }}
              data-testid={`canned-picker-option-${t.id}`}
              className="block w-full px-3 py-1.5 text-left text-sm hover:bg-muted"
            >
              {t.category ? <span className="text-muted-foreground">{t.category} · </span> : null}
              {t.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
