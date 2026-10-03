import {expect,it,vi} from 'vitest';
const h=vi.hoisted(()=>({processor:null as null|(()=>Promise<unknown>),setups:vi.fn(),poll:vi.fn()}));
vi.mock('bullmq',()=>({Worker:class{constructor(_name:string,fn:()=>Promise<unknown>){h.processor=fn;}on(){}async close(){}},Queue:class{async getRepeatableJobs(){return [];}async add(){}async close(){}}}));
vi.mock('../db',()=>({db:{execute:async()=>[]},withSystemDbAccessContext:(fn:()=>unknown)=>fn()}));
vi.mock('../services/autopay/setupReconciliation',()=>({reconcileAutopaySetups:h.setups}));
vi.mock('../services/stripeFinancialEventPoller',()=>({pollStripeFinancialEvents:h.poll}));
vi.mock('../services/stripeSettle',()=>({assertNoHeldDbContextForStripe:()=>{},HeldDbContextForStripeError:class extends Error{},settleCheckoutSession:vi.fn()}));
vi.mock('../services/redis',()=>({getBullMQConnection:()=>({})}));
vi.mock('../services/sentry',()=>({captureException:vi.fn()}));
vi.mock('./workerObservability',()=>({attachWorkerObservability:()=>{}}));
import {initializeStripeReconcileSweep,shutdownStripeReconcileSweep} from './stripeReconcileSweep';
it('still polls refunds/disputes after setup reconciliation fails',async()=>{
 h.setups.mockRejectedValue(new Error('autopay unavailable'));h.poll.mockResolvedValue({accounts:1,events:1,applied:1});
 await initializeStripeReconcileSweep();
 await h.processor!().catch(()=>{});
 expect(h.poll).toHaveBeenCalledOnce();
 await shutdownStripeReconcileSweep();
});
