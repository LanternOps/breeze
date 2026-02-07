import { ShieldAlert, Check, X } from 'lucide-react';

interface AiApprovalDialogProps {
  toolName: string;
  description: string;
  input: Record<string, unknown>;
  onApprove: () => void;
  onReject: () => void;
}

export default function AiApprovalDialog({ toolName, description, input, onApprove, onReject }: AiApprovalDialogProps) {
  const formatToolName = (name: string) => name.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

  return (
    <div className="my-2 rounded-lg border border-amber-600/50 bg-amber-950/30 p-3">
      <div className="flex items-center gap-2">
        <ShieldAlert className="h-4 w-4 text-amber-400" />
        <span className="text-sm font-medium text-amber-300">Approval Required</span>
      </div>

      <p className="mt-2 text-sm text-gray-300">{description}</p>

      <div className="mt-2 rounded bg-gray-900 px-3 py-2">
        <span className="text-xs font-medium text-gray-400">{formatToolName(toolName)}</span>
        <pre className="mt-1 max-h-24 overflow-auto text-xs text-gray-300">
          {JSON.stringify(input, null, 2)}
        </pre>
      </div>

      <div className="mt-3 flex gap-2">
        <button
          onClick={onApprove}
          className="flex items-center gap-1.5 rounded-md bg-green-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-green-500"
        >
          <Check className="h-3.5 w-3.5" />
          Approve
        </button>
        <button
          onClick={onReject}
          className="flex items-center gap-1.5 rounded-md bg-gray-700 px-3 py-1.5 text-xs font-medium text-gray-300 transition-colors hover:bg-gray-600"
        >
          <X className="h-3.5 w-3.5" />
          Reject
        </button>
      </div>

      <p className="mt-2 text-xs text-gray-500">
        Auto-rejects in 5 minutes if no action is taken.
      </p>
    </div>
  );
}
