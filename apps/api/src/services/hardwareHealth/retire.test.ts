import { expect,it } from 'vitest';
import { resolveAlertsForRemovedComponents } from './retire';
it.each([{keys:[]},{keys:['storcli:c0:e1:s1']}])('W01 retirement is a no-op for $keys',async({keys})=>{
 expect(await resolveAlertsForRemovedComponents('11111111-1111-4111-8111-111111111111',keys)).toBe(0);
});
