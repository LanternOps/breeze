import type { Page } from '@playwright/test';
import { topologyGraphFixture, topologySettingsFixture, SITE, NODE, ASSET } from '../../apps/web/src/components/topology/topologyFixtures';
/** Frontend/worker fixture only: does not replace M1 normalized-ingestion acceptance. */
export async function installTopologyWorkerFixture(page: Page) {
const user = { id: ASSET, email: 'review@example.test', name: 'Topology review', scope: 'organization', orgId: SITE, orgName: 'Fixture organization', partnerId: null, mfaEnabled: true, permissions: [{ resource: '*', action: '*' }] };

await page.addInitScript(({ user }) => {
  localStorage.setItem('breeze-auth', JSON.stringify({ state: { user, isAuthenticated: true }, version: 2 }));
  const capture = { requests: [] as unknown[], results: [] as unknown[], violations: [] as string[] };
  Object.assign(window, { topologyWorkerCapture: capture });
  const BrowserWorker = window.Worker;
  window.Worker = class extends BrowserWorker {
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options);
      this.addEventListener('message', (event) => capture.results.push(event.data));
    }
    postMessage(message: unknown) { capture.requests.push(message); super.postMessage(message); }
  };
  document.addEventListener('securitypolicyviolation', (event) => capture.violations.push(`${event.violatedDirective}: ${event.blockedURI} ${event.sourceFile}:${event.lineNumber}`));
}, { user });
const mutations: string[] = [], graph = topologyGraphFixture();
graph.nodes.push({ ...graph.nodes[0], id: '44444444-4444-4444-8444-444444444444', kind: 'endpoint', role: 'endpoint', label: 'Fixture endpoint with a long descriptive label', bindings: [] });
graph.counts.totalNodes = 2; graph.counts.visibleNodes = 2;
graph.layout.positions = [{ nodeId: NODE, x: 320, y: 180, pinned: true, source: 'user', rowRevision: '1' }];
await page.route('**/api/v1/**', async (route) => {
 const path = new URL(route.request().url()).pathname.replace('/api/v1', ''); if(path.startsWith('/topology') && route.request().method() !== 'GET') mutations.push(path);
 let body: unknown = { data: [] };
 if (path === '/auth/refresh') body = { tokens: { accessToken: 'fixture-token', expiresInSeconds: 3600 } };
 else if (path === '/users/me') body = user;
 else if (path === `/discovery/assets/${ASSET}`) body = {data: { id: ASSET, orgId: SITE, siteId: SITE, siteName: 'Fixture site', assetType: 'switch', approvalStatus: 'approved', isOnline: true, hostname: 'inventory-edge', label: 'Fixture network device', ipAddress: '192.0.2.1', openPorts: [], linkedDeviceId: null, snmpData: {}, discoveryMethods: [], tags: [] }};
 else if (path.endsWith('/settings') && path.includes('/topology')) body = topologySettingsFixture();
 else if (path.endsWith('/nodes')) body = {siteId:SITE,graphRevision:'1',total:1,nodes:graph.nodes,cursor:null};
 else if (path.endsWith('/graph')) body = graph;
 else if (path.endsWith('/health')) body = {siteId:SITE,graphRevision:'1',healthRevision:'1',nodes:graph.nodes.map(n=>({id:n.id,health:n.health})),relationships:[]};
 else if (path === '/orgs' || path === '/organizations') body = { data: [{id:SITE,name:'Fixture organization',status:'active'}] };
 else if (path.includes('/sites')) body = {data:[{id:SITE,orgId:SITE,name:'Fixture site'}]};
 await route.fulfill({ status:200,contentType:'application/json',body:JSON.stringify(body) });
});
return { siteId: SITE, assetId: ASSET, nodeId: NODE, mutations };
}
