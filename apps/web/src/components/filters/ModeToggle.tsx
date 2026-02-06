import { cn } from '@/lib/utils';

export interface ModeToggleOption<T extends string = string> {
  value: T;
  label: string;
  icon?: React.ReactNode;
}

interface ModeToggleProps<T extends string = string> {
  options: ModeToggleOption<T>[];
  value: T;
  onChange: (value: T) => void;
}

export function ModeToggle<T extends string = string>({
  options,
  value,
  onChange
}: ModeToggleProps<T>) {
  return (
    <div className="flex rounded-md border">
      {options.map((option, idx) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          className={cn(
            'px-3 py-1.5 text-xs font-medium transition',
            idx === 0 && 'rounded-l-md',
            idx === options.length - 1 && 'rounded-r-md',
            value === option.value
              ? 'bg-primary text-primary-foreground'
              : 'hover:bg-muted'
          )}
        >
          {option.icon && <span className="inline mr-1">{option.icon}</span>}
          {option.label}
        </button>
      ))}
    </div>
  );
}
