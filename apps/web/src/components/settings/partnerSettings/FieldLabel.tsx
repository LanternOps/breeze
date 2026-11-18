import type { ReactNode } from 'react';
import SettingBadge from './SettingBadge';

/**
 * A partner settings field label with its inheritance badge beside it. The
 * badge sits outside the `<label>`, so it never becomes part of the control's
 * accessible name.
 */
export default function FieldLabel({
  htmlFor,
  fieldId,
  id,
  className = 'text-sm font-medium',
  children,
}: {
  htmlFor?: string;
  fieldId: string;
  id?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <label htmlFor={htmlFor} id={id} className={className}>{children}</label>
      <SettingBadge fieldId={fieldId} />
    </div>
  );
}
