interface Option { key: string; label: string }
export function SegmentedControl({ options, value, onChange }: {
  options: Option[]; value: string; onChange: (key: string) => void;
}) {
  const idx = options.findIndex((o) => o.key === value);
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowRight' && idx < options.length - 1) onChange(options[idx + 1].key);
    if (e.key === 'ArrowLeft' && idx > 0) onChange(options[idx - 1].key);
  };
  return (
    <div role="tablist" tabIndex={0} className="ws-segmented" onKeyDown={onKeyDown}>
      {options.map((o) => (
        <button key={o.key} role="tab" aria-selected={o.key === value}
          className="ws-segmented-item" onClick={() => onChange(o.key)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}
