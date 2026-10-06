import { cn } from '@/lib/utils';
import { RADIO } from '../ui';

export interface MethodOption<V extends string = string> {
  value: V; name: string; fee?: string | null; detail?: string | null; testId?: string; feeTestId?: string;
}

/**
 * How the client will pay, as radio rows in one bordered group (a true control
 * surface). Each row names the method, its fee on the right and one helper line.
 * The selected row carries the register mark, the nav's green rule. A single
 * available method is a plain row: a lone radio asks a question with one answer.
 */
export function MethodChoice<V extends string>({ legend, name, options, value, onChange, disabled }: {
  legend: string; name: string; options: MethodOption<V>[]; value: V; onChange: (value: V) => void; disabled?: boolean;
}) {
  if (options.length === 1) {
    const only = options[0]!;
    return (
      <div className="space-y-2">
        <p className="text-sm font-semibold text-foreground">Payment method</p>
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 rounded-lg border border-border px-4 py-3.5" data-testid={only.testId}>
          <span className="text-sm font-semibold text-foreground">{only.name}</span>
          {only.fee && <span className="text-sm text-muted-foreground" data-testid={only.feeTestId}>{only.fee}</span>}
          {only.detail && <span className="basis-full text-sm text-muted-foreground">{only.detail}</span>}
        </div>
      </div>
    );
  }
  return (
    <fieldset disabled={disabled} className="space-y-2">
      <legend className="mb-2 text-sm font-semibold text-foreground">{legend}</legend>
      <div className="divide-y divide-border/70 overflow-hidden rounded-lg border border-border">
        {options.map(option => {
          const selected = option.value === value;
          return (
            <label key={option.value}
              className={cn('relative flex min-h-11 cursor-pointer gap-3 px-4 py-3.5 transition-colors hover:bg-accent/40',
                selected && 'bg-accent/50')}>
              {selected && <span aria-hidden="true" className="absolute inset-y-3 left-0 w-0.5 rounded-full bg-primary" />}
              <input type="radio" name={name} value={option.value} checked={selected} className={RADIO}
                data-testid={option.testId} onChange={() => onChange(option.value)} />
              <span className="flex min-w-0 flex-1 flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5">
                <span className="text-sm font-semibold text-foreground">{option.name}</span>
                {option.fee && <span className="text-sm text-muted-foreground" data-testid={option.feeTestId}>{option.fee}</span>}
                {option.detail && <span className="basis-full text-sm text-muted-foreground">{option.detail}</span>}
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

export default MethodChoice;
