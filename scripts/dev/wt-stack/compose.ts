export function parsePublishedPort(output: string): number {
  const line = output.split('\n').map((l) => l.trim()).find(Boolean);
  const m = line?.match(/:(\d+)$/);
  if (!m) throw new Error(`Could not find a published port in compose output: ${JSON.stringify(output)} (no published port)`);
  return Number(m[1]);
}
