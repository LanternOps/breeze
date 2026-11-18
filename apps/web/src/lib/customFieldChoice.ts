type Choice = string | { label: string; value: string };

/**
 * Map a stored dropdown custom-field value to its human label (#9677).
 * Returns undefined for non-dropdown fields; falls back to the raw value when
 * no choice matches (e.g. the choice was later removed).
 */
export function dropdownChoiceLabel(
  def: { type: string; options?: { choices?: Choice[] } | null },
  value: unknown,
): string | undefined {
  if (def.type !== 'dropdown') return undefined;
  const choice = def.options?.choices?.find((c) =>
    typeof c === 'string' ? c === value : c.value === value,
  );
  if (choice === undefined) return String(value);
  return typeof choice === 'string' ? choice : choice.label;
}
