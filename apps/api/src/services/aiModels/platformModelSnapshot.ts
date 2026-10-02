/**
 * In-process snapshot of ai_platform_models for synchronous hot paths: the
 * Agent SDK wire options and the cost tracker's token-rate lookup.
 *
 * Dependency-free on purpose: aiModel.ts and aiCostTracker.ts import it, and
 * hundreds of tests import those without mocking the database.
 *
 * Loaded by refreshPlatformModelSnapshot() (platformModels.ts):
 * - at startup and then every 60 s in the API and worker processes;
 * - after every admin write;
 * - after every discovery sync.
 *
 * Cold (never loaded) means callers apply the W00 bootstrap rules.
 */
import type { PlatformModel } from './platformModels';

interface Snapshot {
  byModelId: ReadonlyMap<string, PlatformModel>;
  defaultModelId: string | null;
  loadedAt: number;
}

let current: Snapshot | null = null;

export function setPlatformModelSnapshot(models: readonly PlatformModel[], loadedAt: number = Date.now()): void {
  const byModelId = new Map(models.map((model) => [model.modelId, model] as const));
  const defaultModel = models.find((model) => model.isPlatformDefault && model.lifecycle !== 'retired');
  current = { byModelId, defaultModelId: defaultModel?.modelId ?? null, loadedAt };
}

export function clearPlatformModelSnapshot(): void {
  current = null;
}

export function isPlatformModelSnapshotLoaded(): boolean {
  return current !== null;
}

export function peekPlatformModel(modelId: string): PlatformModel | undefined {
  return current?.byModelId.get(modelId);
}

export function peekPlatformDefaultModelId(): string | null {
  return current?.defaultModelId ?? null;
}
