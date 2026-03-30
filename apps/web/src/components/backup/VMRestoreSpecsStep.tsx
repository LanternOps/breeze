/**
 * VM Restore Wizard — Step 3: VM Specifications
 *
 * Configure memory, CPU, and disk resources for the restored VM.
 * Pre-filled from the backup's hardware profile estimate.
 */

type VMRestoreSpecsStepProps = {
  memoryMB: number;
  cpuCount: number;
  diskGB: number;
  onMemoryChange: (v: number) => void;
  onCpuChange: (v: number) => void;
  onDiskChange: (v: number) => void;
};

export default function VMRestoreSpecsStep({
  memoryMB,
  cpuCount,
  diskGB,
  onMemoryChange,
  onCpuChange,
  onDiskChange,
}: VMRestoreSpecsStepProps) {
  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-lg font-semibold text-foreground">VM specifications</h3>
        <p className="text-sm text-muted-foreground">
          Configure resources for the virtual machine. Pre-filled from the backup hardware profile.
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="space-y-2">
          <label htmlFor="vm-memory" className="text-xs font-medium text-muted-foreground">Memory (MB)</label>
          <input
            id="vm-memory"
            type="number"
            min={512}
            step={512}
            value={memoryMB}
            onChange={(e) => onMemoryChange(Number(e.target.value) || 4096)}
            className="w-full rounded-md border bg-background px-3 py-2 text-sm"
          />
        </div>
        <div className="space-y-2">
          <label htmlFor="vm-cpu" className="text-xs font-medium text-muted-foreground">CPU Count</label>
          <input
            id="vm-cpu"
            type="number"
            min={1}
            max={64}
            value={cpuCount}
            onChange={(e) => onCpuChange(Number(e.target.value) || 2)}
            className="w-full rounded-md border bg-background px-3 py-2 text-sm"
          />
        </div>
        <div className="space-y-2">
          <label htmlFor="vm-disk" className="text-xs font-medium text-muted-foreground">Disk (GB)</label>
          <input
            id="vm-disk"
            type="number"
            min={10}
            value={diskGB}
            onChange={(e) => onDiskChange(Number(e.target.value) || 80)}
            className="w-full rounded-md border bg-background px-3 py-2 text-sm"
          />
        </div>
      </div>
    </div>
  );
}
