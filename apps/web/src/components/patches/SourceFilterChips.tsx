type Source = 'all' | 'microsoft' | 'apple' | 'linux' | 'third_party';

const labels: Record<Source, string> = {
  all: 'All',
  microsoft: 'Microsoft',
  apple: 'Apple',
  linux: 'Linux',
  third_party: 'Third-party',
};

const order: Source[] = ['all', 'microsoft', 'apple', 'linux', 'third_party'];

interface Props {
  counts: Record<string, number>;
  value: Source;
  onChange: (next: Source) => void;
}

export default function SourceFilterChips({ counts, value, onChange }: Props) {
  const total =
    (counts.microsoft ?? 0) +
    (counts.apple ?? 0) +
    (counts.linux ?? 0) +
    (counts.third_party ?? 0) +
    (counts.custom ?? 0);

  return (
    <div className="flex flex-wrap gap-2 mb-3" data-testid="patches-source-chips">
      {order.map((source) => {
        const count = source === 'all' ? total : counts[source] ?? 0;
        const active = value === source;
        return (
          <button
            key={source}
            data-testid={`patches-filter-${source}`}
            onClick={() => onChange(source)}
            className={`px-3 py-1 rounded-full text-sm border transition-colors ${
              active
                ? 'bg-blue-600 text-white border-blue-600'
                : 'bg-white text-gray-700 border-gray-200 hover:bg-gray-50'
            }`}
          >
            {labels[source]}{' '}
            <span data-testid={`patches-count-${source}`} className="ml-1 opacity-80">
              {count}
            </span>
          </button>
        );
      })}
    </div>
  );
}
