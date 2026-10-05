import '../../__tests__/integration/setup';
import {afterAll,expect,it} from 'vitest';
import {readFileSync} from 'node:fs';
import postgres from 'postgres';
const admin=postgres(process.env.DATABASE_URL!,{max:1});
afterAll(()=>admin.end({timeout:5}));
// The replay runs in a transaction that is rolled back. Committing it would leave this
// shared test database at the 2026-12-04 definition of constraints that later migrations
// widen (invoice_autopay_schedules_ineligible_reason_check gained above_authorized_cap in
// 2026-12-10-110100), so every test that runs afterwards in the same database would see
// a narrower schema than production.
const rolledBack=new Error('roll back the replay');
it('replays the two migrations and retains forced tenant isolation',async()=>{
  await expect(admin.begin(async tx=>{
    for(let n=0;n<2;n++)for(const filename of ['2026-12-04-130000-accounting-fee-income-mapping.sql','2026-12-04-130001-processing-fee-reversals.sql']){
      const source=readFileSync(new URL(`../../../migrations/${filename}`,import.meta.url),'utf8');
      await tx.unsafe(source);
    }
    const columns=await tx`select table_name,column_name from information_schema.columns where
      (table_name='accounting_connections' and column_name in ('fee_income_item_ref','fee_income_account_ref')) or
      (table_name='invoice_stripe_payments' and column_name in ('fee_reversed_amount','fee_accounting_journal','fee_accounting_error'))`;
    expect(columns).toHaveLength(5);
    const rows=await tx`select relname,relrowsecurity,relforcerowsecurity from pg_class where relname in ('accounting_connections','invoice_stripe_payments')`;
    expect(rows).toHaveLength(2);
    expect(rows.every(r=>r.relrowsecurity&&r.relforcerowsecurity)).toBe(true);
    throw rolledBack;
  })).rejects.toBe(rolledBack);
  // The committed schema keeps its latest definition.
  const [check]=await admin`select pg_get_constraintdef(oid) as def from pg_constraint where conname='invoice_autopay_schedules_ineligible_reason_check'`;
  expect(check!.def).toContain('above_authorized_cap');
});
