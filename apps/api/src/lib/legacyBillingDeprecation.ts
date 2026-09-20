// W02 grace release. Remove this compatibility handling when W04 rejects these keys.
export function legacyBillingDeprecationWarnings(body: Record<string, unknown>): string[] {
  return ['defaultBillable', 'defaultHourlyRate', 'rateCurrency']
    .filter((field) => Object.prototype.hasOwnProperty.call(body, field));
}
