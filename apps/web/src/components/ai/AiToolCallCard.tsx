import { useState } from 'react';
import { ChevronDown, ChevronRight, Wrench, CheckCircle, XCircle, Loader2 } from 'lucide-react';

interface AiToolCallCardProps {
  toolName: string;
  input?: Record<string, unknown>;
  output?: unknown;
  isError?: boolean;
  isExecuting?: boolean;
}

export default function AiToolCallCard({ toolName, input, output, isError, isExecuting }: AiToolCallCardProps) {
  const [expanded, setExpanded] = useState(false);

  const StatusIcon = isExecuting
    ? () => <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-400" />
    : isError
      ? () => <XCircle className="h-3.5 w-3.5 text-red-400" />
      : output !== undefined
        ? () => <CheckCircle className="h-3.5 w-3.5 text-green-400" />
        : () => <Wrench className="h-3.5 w-3.5 text-gray-400" />;

  const formatToolName = (name: string) => name.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

  return (
    <div className="my-1 rounded-md border border-gray-700 bg-gray-800/50">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs"
      >
        {expanded ? (
          <ChevronDown className="h-3 w-3 text-gray-500" />
        ) : (
          <ChevronRight className="h-3 w-3 text-gray-500" />
        )}
        <StatusIcon />
        <span className="font-medium text-gray-300">{formatToolName(toolName)}</span>
        {isExecuting && <span className="text-gray-500">Running...</span>}
      </button>

      {expanded && (
        <div className="border-t border-gray-700 px-3 py-2 text-xs">
          {input && (
            <div className="mb-2">
              <span className="font-medium text-gray-400">Input:</span>
              <pre className="mt-1 max-h-32 overflow-auto rounded bg-gray-900 p-2 text-gray-300">
                {JSON.stringify(input, null, 2)}
              </pre>
            </div>
          )}
          {output !== undefined && (
            <div>
              <span className={`font-medium ${isError ? 'text-red-400' : 'text-gray-400'}`}>
                {isError ? 'Error:' : 'Output:'}
              </span>
              <pre className="mt-1 max-h-40 overflow-auto rounded bg-gray-900 p-2 text-gray-300">
                {typeof output === 'string' ? output : JSON.stringify(output, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
