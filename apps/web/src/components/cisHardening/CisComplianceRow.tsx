import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { cn, formatRelativeTime } from '@/lib/utils';
import type { ComplianceEntry } from './types';

const severityBadge: Record<string, string> = {
  low: 'bg-blue-500/20 text-blue-700 border-blue-500/30',
  medium: 'bg-yellow-500/20 text-yellow-800 border-yellow-500/40',
  high: 'bg-orange-500/20 text-orange-700 border-orange-500/40',
  critical: 'bg-red-500/20 text-red-700 border-red-500/40',
};

interface CisComplianceRowProps {
  entry: ComplianceEntry;
}

export default function CisComplianceRow({ entry }: CisComplianceRowProps) {
  const [expanded, setExpanded] = useState(false);
  const { result, baseline, device } = entry;
  const scoreColor = result.score >= 80 ? 'bg-emerald-500' : result.score >= 60 ? 'bg-amber-500' : 'bg-red-500';

  const failedFindings = (result.findings ?? []).filter(
    (f) => f.status === 'fail' || f.status === 'failed'
  );

  return (
    <>
      <tr
        className="cursor-pointer text-sm hover:bg-muted/40"
        onClick={() => setExpanded(!expanded)}
      >
        <td className="px-4 py-3">
          {expanded ? (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          )}
        </td>
        <td className="px-4 py-3 font-medium">{device.hostname}</td>
        <td className="px-4 py-3">{baseline.name}</td>
        <td className="px-4 py-3 uppercase text-muted-foreground">{device.osType}</td>
        <td className="px-4 py-3">
          <div className="flex items-center gap-2">
            <div className="h-1.5 w-16 rounded-full bg-muted">
              <div
                className={cn('h-1.5 rounded-full', scoreColor)}
                style={{ width: `${result.score}%` }}
              />
            </div>
            <span className="text-xs font-medium">{result.score}%</span>
          </div>
        </td>
        <td className="px-4 py-3 text-muted-foreground">{result.failedChecks}</td>
        <td className="px-4 py-3 text-xs text-muted-foreground">
          {formatRelativeTime(new Date(result.checkedAt))}
        </td>
      </tr>
      {expanded && failedFindings.length > 0 && (
        <tr>
          <td colSpan={7} className="bg-muted/20 px-4 py-3">
            <div className="space-y-2">
              {failedFindings.map((finding, idx) => (
                <div
                  key={finding.checkId ?? idx}
                  className="flex items-start gap-3 rounded-md border bg-card px-3 py-2 text-sm"
                >
                  <span
                    className={cn(
                      'inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold',
                      severityBadge[finding.severity ?? 'medium'] ?? severityBadge.medium
                    )}
                  >
                    {finding.severity ?? 'medium'}
                  </span>
                  <code className="font-mono text-xs text-muted-foreground">{finding.checkId}</code>
                  <span className="flex-1">{finding.title}</span>
                  {finding.message && (
                    <span className="text-xs text-muted-foreground">{finding.message}</span>
                  )}
                </div>
              ))}
            </div>
          </td>
        </tr>
      )}
      {expanded && failedFindings.length === 0 && (
        <tr>
          <td colSpan={7} className="bg-muted/20 px-4 py-3 text-center text-sm text-muted-foreground">
            No failed findings.
          </td>
        </tr>
      )}
    </>
  );
}
