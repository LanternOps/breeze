import {test,expect} from '../fixtures';
import { AutopayProcessingFeesPage } from '../pages/AutopayProcessingFeesPage';
test('processing fees display and save through the actual Payments page',async({authedPage:page})=>{
  const effective={autopayOffsetDays:{value:0,source:'default'},autopayOffsetRule:{value:'later',source:'default'},
    autopayCap:{value:{enabled:false},source:'default'},achMode:{value:'ach_preferred',source:'default'},
    cardFeeBps:{value:0,source:'default'},achFeeAmount:{value:'0.00',source:'default'},feeAttested:false,
    remindersEnabled:{value:false,source:'default'},reminderBeforeDueDays:{value:3,source:'default'},
    reminderRepeatDays:{value:null,source:'default'},overdueReminderEveryDays:{value:7,source:'default'}};
  let saved:Record<string,unknown>|null=null;
  await page.route('**/partner/billing/payment-settings',async route=>{
    if(route.request().method()==='PUT'){saved=route.request().postDataJSON();await route.fulfill({json:{success:true}});return;}
    await route.fulfill({json:{autopayEnabled:true,effective,inherited:effective,values:{autopayOffsetDays:null,autopayOffsetRule:null,
      autopayCapEnabled:null,autopayCapAmount:null,autopayCapCurrency:null,achMode:null,cardFeeBps:null,achFeeAmount:null}}});
  });
  const fees = new AutopayProcessingFeesPage(page);
  await fees.goto();
  await fees.cardFee.fill('300');
  await fees.achFee.fill('2.50');
  await fees.notified.check();
  await expect(fees.save).toBeDisabled();
  await fees.cost.check();
  await fees.save.click();
  await expect.poll(()=>saved).toMatchObject({cardFeeBps:300,achFeeAmount:'2.50',feeAttestation:{
    acquirerAndNetworksNotified30DaysAgo:true,doesNotExceedAcceptanceCost:true}});
});
