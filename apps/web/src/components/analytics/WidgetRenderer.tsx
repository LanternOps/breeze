import { TrendingDown, TrendingUp } from 'lucide-react';
import { cn, formatNumber } from '@/lib/utils';
import ChartWidget, { type ChartWidgetProps } from './ChartWidget';
import GaugeWidget, { type GaugeWidgetProps } from './GaugeWidget';
import TableWidget, { type TableWidgetProps } from './TableWidget';

type SummaryWidgetData = {
  value: number | string;
  label: string;
  change?: number;
  changeLabel?: string;
};

type WidgetDefinition = {
  id: string;
  title?: string;
  type: 'chart' | 'gauge' | 'table' | 'summary';
  data: ChartWidgetProps | GaugeWidgetProps | TableWidgetProps | SummaryWidgetData;
};

type WidgetRendererProps = {
  widget: WidgetDefinition;
};

function SummaryWidget({ title, data }: { title?: string; data: SummaryWidgetData }) {
  const change = data.change ?? 0;
  const changeDirection = change >= 0 ? 'up' : 'down';

  return (
    <div className="flex h-full flex-col justify-between rounded-lg border bg-card p-4 shadow-sm">
      <div className="space-y-1">
        {title && <p className="text-sm text-muted-foreground">{title}</p>}
        <div className="text-2xl font-semibold">
          {typeof data.value === 'number' ? formatNumber(data.value) : data.value}
        </div>
        <div className="text-xs text-muted-foreground">{data.label}</div>
      </div>
      {data.changeLabel && (
        <div
          className={cn(
            'mt-3 inline-flex items-center gap-1 text-xs font-medium',
            changeDirection === 'up' ? 'text-success' : 'text-destructive'
          )}
        >
          {changeDirection === 'up' ? (
            <TrendingUp className="h-3 w-3" />
          ) : (
            <TrendingDown className="h-3 w-3" />
          )}
          {Math.abs(change)}%
          <span className="text-muted-foreground">{data.changeLabel}</span>
        </div>
      )}
    </div>
  );
}

export default function WidgetRenderer({ widget }: WidgetRendererProps) {
  switch (widget.type) {
    case 'chart':
      return <ChartWidget {...(widget.data as ChartWidgetProps)} />;
    case 'gauge':
      return <GaugeWidget {...(widget.data as GaugeWidgetProps)} />;
    case 'table':
      return <TableWidget {...(widget.data as TableWidgetProps)} />;
    case 'summary':
      return <SummaryWidget title={widget.title} data={widget.data as SummaryWidgetData} />;
    default:
      return (
        <div className="flex h-full items-center justify-center rounded-lg border bg-card p-4 text-sm text-muted-foreground">
          Unsupported widget
        </div>
      );
  }
}

export type { WidgetDefinition, SummaryWidgetData, WidgetRendererProps };
