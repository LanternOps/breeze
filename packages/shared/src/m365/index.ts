export * from './profiles';
export * from './executorContracts';
export * from './readActions';
export * from './writeActions';
// commsActions / commsEffect / commsPlan are pure and safe for the root barrel.
// commsDigests is NOT exported here on purpose: it imports node:crypto, and this barrel
// is reachable from `@breeze/shared`'s root, which apps/web bundles for the browser.
// Import it as `@breeze/shared/m365/commsDigests`. Likewise commsPlanVectors is test-only
// data, reachable at `@breeze/shared/m365/commsPlanVectors`.
export * from './commsActions';
export * from './commsEffect';
export * from './commsPlan';
export * from './commsExecutorContracts';
