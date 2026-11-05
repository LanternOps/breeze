import type { ReactNode } from 'react';
import { usePartnerSettingsSaveApi } from './partnerSettingsSaveContext';

/**
 * A form-kind card of the partner settings page (spec §3.6). Submitting it
 * (Enter in a field) runs the header Save, the page's only Save. Forms never
 * nest: list rows and drawers keep their own forms and are never wrapped.
 * Every `<button>` inside must carry an explicit `type`, or it would submit.
 */
export default function FormCard({
  children,
  onSubmit,
  className = 'rounded-lg border bg-card p-6 shadow-xs',
  testId,
}: {
  children: ReactNode;
  /** Defaults to the page's header Save. */
  onSubmit?: () => void;
  className?: string;
  testId?: string;
}) {
  const { submit } = usePartnerSettingsSaveApi();
  return (
    <form
      noValidate
      className={className}
      data-testid={testId}
      onSubmit={(e) => {
        e.preventDefault();
        (onSubmit ?? submit)();
      }}
    >
      {children}
      {/* Implicit submission (Enter) needs a submit button once a form has more
          than one text field. Visually hidden, out of the tab order. */}
      <button type="submit" tabIndex={-1} aria-hidden="true" className="sr-only" />
    </form>
  );
}
