import type { FlowFormValues, FlowIssue } from '@breeze/shared';

export interface FlowFormViewProps {
  values: FlowFormValues;
  onChange: (values: FlowFormValues) => void;
  /** The flow is (or will be) owned partner-wide: targets are limited to all and filter. */
  partnerWide: boolean;
  /** Live validation issues, for inline hints (e.g. event delivery not durable). */
  issues: FlowIssue[];
  readOnly?: boolean;
  /** The owning org, to scope pickers. Undefined for a partner-wide flow. */
  orgId?: string;
}

/** Placeholder; the sections land in Task E3. */
export function FlowFormView(_props: FlowFormViewProps) {
  return <div data-testid="flow-editor-form" />;
}
