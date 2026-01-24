import { useState, useMemo } from 'react';
import { X, Plus } from 'lucide-react';
import type { FilterFieldDefinition, FilterOperator, FilterValue } from '@breeze/shared';

interface ValueInputProps {
  value: FilterValue;
  onChange: (value: FilterValue) => void;
  field: FilterFieldDefinition | undefined;
  operator: FilterOperator;
  className?: string;
}

export function ValueInput({
  value,
  onChange,
  field,
  operator,
  className = ''
}: ValueInputProps) {
  // Operators that don't need a value input
  const noValueOperators: FilterOperator[] = ['isNull', 'isNotNull', 'isEmpty', 'isNotEmpty'];
  if (noValueOperators.includes(operator)) {
    return (
      <div className="h-9 flex items-center text-sm text-muted-foreground italic">
        No value needed
      </div>
    );
  }

  // Duration input for withinLast/notWithinLast
  if (operator === 'withinLast' || operator === 'notWithinLast') {
    return (
      <DurationInput
        value={value as { amount: number; unit: string }}
        onChange={onChange}
        className={className}
      />
    );
  }

  // Date range input for between
  if (operator === 'between') {
    return (
      <DateRangeInput
        value={value as { from: Date; to: Date }}
        onChange={onChange}
        className={className}
      />
    );
  }

  // Multi-select for in/notIn/hasAny/hasAll
  if (['in', 'notIn', 'hasAny', 'hasAll'].includes(operator)) {
    const arrayValue = Array.isArray(value) ? value.map(v => String(v)) : [];
    return (
      <MultiValueInput
        value={arrayValue}
        onChange={onChange}
        enumValues={field?.enumValues}
        className={className}
      />
    );
  }

  // Enum select for enum types
  if (field?.type === 'enum' && field.enumValues) {
    return (
      <select
        value={String(value)}
        onChange={(e) => onChange(e.target.value)}
        className={`h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring ${className}`}
      >
        {field.enumValues.map((enumValue) => (
          <option key={enumValue} value={enumValue}>
            {formatEnumValue(enumValue)}
          </option>
        ))}
      </select>
    );
  }

  // Boolean select
  if (field?.type === 'boolean') {
    return (
      <select
        value={String(value)}
        onChange={(e) => onChange(e.target.value === 'true')}
        className={`h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring ${className}`}
      >
        <option value="true">Yes</option>
        <option value="false">No</option>
      </select>
    );
  }

  // Number input
  if (field?.type === 'number') {
    return (
      <input
        type="number"
        value={typeof value === 'number' ? value : ''}
        onChange={(e) => onChange(e.target.valueAsNumber || 0)}
        className={`h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring ${className}`}
        placeholder="Enter a number"
      />
    );
  }

  // Date/datetime input
  if (field?.type === 'date' || field?.type === 'datetime') {
    const dateValue = value instanceof Date
      ? value.toISOString().slice(0, field.type === 'date' ? 10 : 16)
      : typeof value === 'string'
        ? value.slice(0, field.type === 'date' ? 10 : 16)
        : '';

    return (
      <input
        type={field.type === 'date' ? 'date' : 'datetime-local'}
        value={dateValue}
        onChange={(e) => onChange(e.target.value)}
        className={`h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring ${className}`}
      />
    );
  }

  // Default text input
  return (
    <input
      type="text"
      value={typeof value === 'string' ? value : ''}
      onChange={(e) => onChange(e.target.value)}
      className={`h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring ${className}`}
      placeholder={getPlaceholder(field, operator)}
    />
  );
}

// Sub-components

type DurationUnit = 'minutes' | 'hours' | 'days' | 'weeks' | 'months';

function DurationInput({
  value,
  onChange,
  className
}: {
  value: { amount: number; unit: string };
  onChange: (value: FilterValue) => void;
  className?: string;
}) {
  const safeValue = value && typeof value === 'object' && 'amount' in value
    ? value
    : { amount: 7, unit: 'days' as DurationUnit };

  const handleUnitChange = (newUnit: string) => {
    const validUnit = newUnit as DurationUnit;
    onChange({ amount: safeValue.amount, unit: validUnit });
  };

  const handleAmountChange = (newAmount: number) => {
    const validUnit = safeValue.unit as DurationUnit;
    onChange({ amount: newAmount || 1, unit: validUnit });
  };

  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <input
        type="number"
        value={safeValue.amount}
        onChange={(e) => handleAmountChange(e.target.valueAsNumber)}
        min={1}
        className="h-9 w-20 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
      />
      <select
        value={safeValue.unit}
        onChange={(e) => handleUnitChange(e.target.value)}
        className="h-9 rounded-md border bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
      >
        <option value="minutes">minutes</option>
        <option value="hours">hours</option>
        <option value="days">days</option>
        <option value="weeks">weeks</option>
        <option value="months">months</option>
      </select>
    </div>
  );
}

function DateRangeInput({
  value,
  onChange,
  className
}: {
  value: { from: Date; to: Date };
  onChange: (value: FilterValue) => void;
  className?: string;
}) {
  const safeValue = value && typeof value === 'object' && 'from' in value
    ? value
    : { from: new Date(), to: new Date() };

  const fromStr = safeValue.from instanceof Date
    ? safeValue.from.toISOString().slice(0, 10)
    : String(safeValue.from).slice(0, 10);

  const toStr = safeValue.to instanceof Date
    ? safeValue.to.toISOString().slice(0, 10)
    : String(safeValue.to).slice(0, 10);

  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <input
        type="date"
        value={fromStr}
        onChange={(e) => onChange({ ...safeValue, from: new Date(e.target.value) })}
        className="h-9 rounded-md border bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
      />
      <span className="text-sm text-muted-foreground">to</span>
      <input
        type="date"
        value={toStr}
        onChange={(e) => onChange({ ...safeValue, to: new Date(e.target.value) })}
        className="h-9 rounded-md border bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
      />
    </div>
  );
}

function MultiValueInput({
  value,
  onChange,
  enumValues,
  className
}: {
  value: string[];
  onChange: (value: FilterValue) => void;
  enumValues?: string[];
  className?: string;
}) {
  const [inputValue, setInputValue] = useState('');

  const addValue = (newValue: string) => {
    const trimmed = newValue.trim();
    if (trimmed && !value.includes(trimmed)) {
      onChange([...value, trimmed]);
    }
    setInputValue('');
  };

  const removeValue = (valueToRemove: string) => {
    onChange(value.filter((v) => v !== valueToRemove));
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addValue(inputValue);
    }
  };

  // If we have enum values, show checkboxes instead of free text
  if (enumValues && enumValues.length <= 10) {
    return (
      <div className={`flex flex-wrap gap-2 ${className}`}>
        {enumValues.map((enumValue) => {
          const isSelected = value.includes(enumValue);
          return (
            <label
              key={enumValue}
              className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs cursor-pointer transition ${
                isSelected
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'hover:bg-muted'
              }`}
            >
              <input
                type="checkbox"
                checked={isSelected}
                onChange={() => {
                  if (isSelected) {
                    removeValue(enumValue);
                  } else {
                    onChange([...value, enumValue]);
                  }
                }}
                className="sr-only"
              />
              {formatEnumValue(enumValue)}
            </label>
          );
        })}
      </div>
    );
  }

  return (
    <div className={className}>
      <div className="flex flex-wrap gap-1 min-h-[36px] p-1 rounded-md border bg-background">
        {value.map((v) => (
          <span
            key={v}
            className="inline-flex items-center gap-1 rounded-full border bg-muted px-2 py-0.5 text-xs"
          >
            {v}
            <button
              type="button"
              onClick={() => removeValue(v)}
              className="rounded-full p-0.5 hover:bg-background"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
        <input
          type="text"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={() => inputValue && addValue(inputValue)}
          placeholder={value.length === 0 ? 'Type and press Enter' : ''}
          className="flex-1 min-w-[100px] h-7 bg-transparent px-2 text-sm outline-none"
        />
      </div>
    </div>
  );
}

// Helpers

function formatEnumValue(value: string): string {
  // Convert snake_case or camelCase to Title Case
  return value
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function getPlaceholder(field: FilterFieldDefinition | undefined, operator: FilterOperator): string {
  if (operator === 'matches') {
    return 'Regular expression';
  }
  if (field?.key.includes('ip')) {
    return 'e.g., 192.168.1.';
  }
  if (field?.key.includes('mac')) {
    return 'e.g., AA:BB:CC';
  }
  if (field?.key === 'hostname') {
    return 'e.g., srv-web-01';
  }
  if (field?.key === 'software.installed' || field?.key === 'software.notInstalled') {
    return 'e.g., Chrome';
  }
  return 'Enter value';
}

export default ValueInput;
