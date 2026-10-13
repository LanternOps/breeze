import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dbState = vi.hoisted(() => ({
  inContext: false,
  committed: [] as Array<() => unknown>,
}));

vi.mock('../db', () => ({
  hasDbAccessContext: () => dbState.inContext,
  getCurrentDbAccessContext: () => undefined,
  runAfterDbContextExit: (_label: string, work: () => unknown) => {
    if (!dbState.inContext) work();
  },
  // Inside a context: queued until the test models COMMIT. Outside: at once.
  runAfterDbContextCommit: (_label: string, work: () => unknown) => {
    if (dbState.inContext) dbState.committed.push(work);
    else work();
  },
}));

import { ClusterCacheBus, __setClusterCacheBusForTests } from './clusterCacheBus';
import {
  invalidateAgentOrgSettingsCaches,
  invalidateOrgHelperSettingsCache,
  invalidateOrgPamFallbackCache,
  invalidateOrgPolicyProbeCache,
} from './agentOrgSettingsCache';

let published: Array<[string, string | null]>;

function installRecordingBus(): void {
  const bus = new ClusterCacheBus({ origin: 'unit', getPublisher: () => null, createSubscriber: () => null });
  vi.spyOn(bus, 'publish').mockImplementation(async (cache: string, key: string | null) => {
    published.push([cache, key]);
    return 'published';
  });
  __setClusterCacheBusForTests(bus);
}

function publishedFor(cache: string): Array<string | null> {
  return published.filter(([name]) => name === cache).map(([, key]) => key);
}

beforeEach(() => {
  published = [];
  dbState.inContext = false;
  dbState.committed = [];
  installRecordingBus();
});
afterEach(() => __setClusterCacheBusForTests(null));

describe('org-agent-update-config is cluster-invalidated (W05 #8144, C1)', () => {
  it('an org write publishes that org id', () => {
    invalidateAgentOrgSettingsCaches('org-1');
    expect(publishedFor('org-agent-update-config')).toEqual(['org-1']);
  });

  it('a partner write publishes the whole cache (key null)', () => {
    invalidateAgentOrgSettingsCaches();
    expect(publishedFor('org-agent-update-config')).toEqual([null]);
  });

  it('a writer inside its request context publishes only after COMMIT', () => {
    dbState.inContext = true;
    invalidateAgentOrgSettingsCaches('org-1');
    expect(publishedFor('org-agent-update-config')).toEqual([]);
    dbState.inContext = false;
    for (const work of dbState.committed.splice(0)) work();
    expect(publishedFor('org-agent-update-config')).toEqual(['org-1']);
  });
});

describe('org-topology-flags is cluster-invalidated (W05 #8144, C2)', () => {
  it('an org write publishes that org id', () => {
    invalidateAgentOrgSettingsCaches('org-1');
    expect(publishedFor('org-topology-flags')).toEqual(['org-1']);
  });

  it('a partner write publishes the whole cache (key null)', () => {
    invalidateAgentOrgSettingsCaches();
    expect(publishedFor('org-topology-flags')).toEqual([null]);
  });
});

describe('org-helper-legacy-settings is cluster-invalidated (W05 #8144, C3)', () => {
  it('PATCH /agents/org/:orgId/settings/helper publishes that org id', () => {
    invalidateOrgHelperSettingsCache('org-1');
    expect(publishedFor('org-helper-legacy-settings')).toEqual(['org-1']);
  });

  it('a partner settings write publishes the whole cache (key null)', () => {
    invalidateAgentOrgSettingsCaches();
    expect(publishedFor('org-helper-legacy-settings')).toEqual([null]);
  });
});

describe('org-pam-fallback is cluster-invalidated (W05 #8144, C5)', () => {
  it('invalidateOrgPamFallbackCache publishes that org id', () => {
    invalidateOrgPamFallbackCache('org-1');
    expect(publishedFor('org-pam-fallback')).toEqual(['org-1']);
  });
});

describe('org-policy-probe is cluster-invalidated (W05 #8144, C4)', () => {
  it('deactivating an org policy publishes that org id', () => {
    invalidateOrgPolicyProbeCache('org-1');
    expect(publishedFor('org-policy-probe')).toEqual(['org-1']);
  });

  it('deactivating a partner-wide policy publishes the whole cache (key null)', () => {
    invalidateOrgPolicyProbeCache();
    expect(publishedFor('org-policy-probe')).toEqual([null]);
  });
});
