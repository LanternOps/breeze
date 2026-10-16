export const FIXTURE_AGENT_VERSION = '1.0.0';

export function workloadFixture(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'container',
    workloadId: 'c'.repeat(64),
    name: 'web',
    state: 'running',
    rawState: 'running',
    imageRef: 'nginx:1.27',
    imageRepository: 'docker.io/library/nginx',
    imageTag: '1.27',
    imageDigest: `sha256:${'a'.repeat(64)}`,
    imageId: `sha256:${'b'.repeat(64)}`,
    composeProject: 'shop',
    composeService: 'web',
    ...over,
  };
}

export function runtimeFixture(over: Record<string, unknown> = {}): Record<string, unknown> {
  const workloads = (over.workloads as unknown[] | undefined) ?? [workloadFixture()];
  return {
    runtime: 'docker',
    detection: 'present',
    collection: 'ok',
    complete: true,
    runtimeVersion: '27.1.1',
    observedCount: workloads.length,
    error: null,
    workloads,
    ...over,
  };
}

export function reportFixture(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocolVersion: 1,
    collectedAt: '2026-10-06T12:00:00.000Z',
    runtimes: [runtimeFixture()],
    ...over,
  };
}
