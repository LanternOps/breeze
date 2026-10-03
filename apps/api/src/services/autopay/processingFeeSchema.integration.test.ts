import '../../__tests__/integration/setup';
import {afterAll,expect,it} from 'vitest';
import {readFileSync} from 'node:fs';
import postgres from 'postgres';
const admin=postgres(process.env.DATABASE_URL!,{max:1});
afterAll(()=>admin.end({timeout:5}));
it('replays the two migrations and retains forced tenant isolation',async()=>{
  for(let n=0;n<2;n++)for(const filename of ['2026-12-04-130000-accounting-fee-income-mapping.sql','2026-12-04-130001-processing-fee-reversals.sql']){
    const source=readFileSync(new URL(`../../../migrations/${filename}`,import.meta.url),'utf8');
    await admin.begin(tx=>tx.unsafe(source));
  }
  const columns=await admin`select table_name,column_name from information_schema.columns where
    (table_name='accounting_connections' and column_name in ('fee_income_item_ref','fee_income_account_ref')) or
    (table_name='invoice_stripe_payments' and column_name in ('fee_reversed_amount','fee_accounting_journal','fee_accounting_error'))`;
  expect(columns).toHaveLength(5);
  const rows=await admin`select relname,relrowsecurity,relforcerowsecurity from pg_class where relname in ('accounting_connections','invoice_stripe_payments')`;
  expect(rows).toHaveLength(2);
  expect(rows.every(r=>r.relrowsecurity&&r.relforcerowsecurity)).toBe(true);
});
