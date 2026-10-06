import {readFileSync} from 'node:fs';
import {expect,it} from 'vitest';
const page=(path:string)=>readFileSync(new URL(path,import.meta.url),'utf8');
it('Skip page hydrates the skip module inside the public shell',()=>{const source=page('./[token]/skip.astro');expect(source).toContain('<AutopaySkipPage');expect(source).toContain('client:load');expect(source).toContain('PublicDocumentLayout');});
it('Confirm page hydrates the confirm module inside the public shell',()=>{const source=page('./[token]/confirm.astro');expect(source).toContain('<AutopayConfirmPage');expect(source).toContain('client:load');expect(source).toContain('PublicDocumentLayout');});
it('Stop page hydrates the stop module inside the public shell',()=>{const source=page('./[token]/stop.astro');expect(source).toContain('<AutopayStopPage');expect(source).toContain('client:load');expect(source).toContain('PublicDocumentLayout');});
it('bank return hydrates its explicit confirmation module',()=>{const source=page('./return.astro');expect(source).toContain('BankAutopayPayment');expect(source).toContain('returning');expect(source).toContain('client:load');});
it('setup return hydrates the auto-confirming return page',()=>{const source=page('./return.astro');expect(source).toContain('<AutopayReturnPage client:load');});
