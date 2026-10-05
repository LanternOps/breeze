import {expect,it,vi} from 'vitest';
import {fireEvent,render,screen,waitFor} from '@testing-library/react';
import {fetchWithAuth} from '../../stores/auth';
import AccountingFeeSettings from './AccountingFeeSettings';
vi.mock('../../stores/auth',()=>({fetchWithAuth:vi.fn()}));
vi.mock('@/lib/navigation',()=>({navigateTo:vi.fn()}));
it('saves one nullable provider-specific ref and reports failure without losing the draft',async()=>{
  vi.mocked(fetchWithAuth).mockResolvedValueOnce(Response.json({error:'Choose an income item'},{status:400}))
    .mockResolvedValueOnce(Response.json({feeIncomeItemRef:'fee-item',feeIncomeAccountRef:null}));
  const onSaved=vi.fn();render(<AccountingFeeSettings provider="quickbooks" itemRef={null} accountRef={null} disabled={false} onSaved={onSaved}/>);
  fireEvent.change(screen.getByTestId('autopay-accounting-fee-ref'),{target:{value:'fee-item'}});
  fireEvent.click(screen.getByTestId('autopay-accounting-fee-save'));
  await screen.findByTestId('autopay-accounting-fee-error');
  expect(screen.getByTestId('autopay-accounting-fee-ref')).toHaveValue('fee-item');
  fireEvent.click(screen.getByTestId('autopay-accounting-fee-save'));
  await waitFor(()=>expect(onSaved).toHaveBeenCalledWith({feeIncomeItemRef:'fee-item',feeIncomeAccountRef:null}));
  expect(JSON.parse(vi.mocked(fetchWithAuth).mock.calls[1]![1]!.body as string)).toEqual({feeIncomeItemRef:'fee-item'});
});
