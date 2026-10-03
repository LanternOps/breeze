import {expect,it,vi} from 'vitest';
import {render,screen} from '@testing-library/react';
const h=vi.hoisted(()=>({fetch:vi.fn()}));
vi.mock('../../stores/auth',async original=>({...await original<typeof import('../../stores/auth')>(),fetchWithAuth:h.fetch}));
vi.mock('../../lib/authScope',()=>({getJwtClaims:()=>({scope:'partner',partnerId:'11111111-1111-4111-8111-111111111111'}),loginPathWithNext:()=>'/login'}));
vi.mock('../../lib/permissions',()=>({usePermissions:()=>({permissions:[],can:()=>true})}));
vi.mock('../../stores/orgStore',()=>({useOrgStore:(selector?: (state: {currentOrgId: null}) => unknown)=>selector ? selector({currentOrgId:null}) : {currentOrgId:null}}));
vi.mock('@/lib/navigation',()=>({navigateTo:vi.fn()}));
vi.mock('./AccountingMappingWorkbench',()=>({default:()=>null}));
vi.mock('./AccountingCustomerImport',()=>({default:()=>null}));
import IntegrationsPage from './IntegrationsPage';
it.each([true,false])('composes accounting fee visibility from rollout %s through Integrations',async enabled=>{
  window.history.replaceState({},'', '/integrations#quickbooks-customers');
  const capabilities={connect:true,mapping:true,customerImport:true,invoicePush:true,paymentPull:true,paymentPush:true};
  h.fetch.mockImplementation(async(path:string)=>Response.json(path==='/accounting/providers'?{
    data:[{id:'quickbooks',displayName:'QuickBooks',configured:true,capabilities},{id:'xero',displayName:'Xero',configured:false,capabilities}],
    activeConnection:{provider:'quickbooks',status:'connected'},
  }:path==='/accounting/quickbooks'?{status:'connected',environment:'sandbox',pushMode:'auto',pullPayments:true,pushPayments:true,
    capabilities,autopayEnabled:enabled,feeAccountingErrorCount:1,feeIncomeItemRef:'fee-item',feeIncomeAccountRef:null,features:{tenantSelection:false,settingsOptions:false}}:{data:[],count:0}));
  render(<IntegrationsPage/>);
  expect(await screen.findByTestId('autopay-accounting-fee-attention')).toBeInTheDocument();
  expect(screen.getByTestId('quickbooks-pushmode-manual')).toBeInTheDocument();
  if(enabled)expect(screen.getByTestId('autopay-accounting-fees')).toBeInTheDocument();
  else expect(screen.queryByTestId('autopay-accounting-fees')).toBeNull();
});
