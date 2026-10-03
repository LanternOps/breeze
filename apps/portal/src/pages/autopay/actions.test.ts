import {readFileSync} from 'node:fs';
import {expect,it} from 'vitest';
it('Skip page hydrates the action module',()=>{const source=readFileSync(new URL('./[token]/skip.astro',import.meta.url),'utf8');expect(source).toContain('AutopayActionPage');expect(source).toContain('action="skip"');expect(source).toContain('client:load');expect(source).toContain('PublicDocumentLayout');});

it('Confirm page hydrates the action module',()=>{const source=readFileSync(new URL('./[token]/confirm.astro',import.meta.url),'utf8');expect(source).toContain('AutopayActionPage');expect(source).toContain('action="confirm"');expect(source).toContain('client:load');expect(source).toContain('PublicDocumentLayout');});

it('bank return hydrates its explicit confirmation module',()=>{const source=readFileSync(new URL('./return.astro',import.meta.url),'utf8');expect(source).toContain('BankAutopayPayment');expect(source).toContain('returning');expect(source).toContain('client:load');});
