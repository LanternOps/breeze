import { fireEvent,render,screen,waitFor } from '@testing-library/react';
import { beforeEach,expect,it,vi } from 'vitest';
const m=vi.hoisted(()=>({save:vi.fn(),remove:vi.fn(),changed:vi.fn()}));
vi.mock('./useFeatureLink',()=>({useFeatureLink:()=>({save:m.save,remove:m.remove,saving:false,error:undefined,clearError:vi.fn()})}));
import HardwareMonitoringTab from './HardwareMonitoringTab';
beforeEach(()=>{vi.clearAllMocks();m.save.mockResolvedValue({id:'link',featureType:'hardware_monitoring',featurePolicyId:null,inlineSettings:{}});});
it('renders defaults and saves disabled collection with custom intervals',async()=>{
 render(<HardwareMonitoringTab policyId="policy" existingLink={undefined} linkedPolicyId={null} onLinkChanged={m.changed}/>);
 expect((screen.getByTestId('hardware-monitoring-enabled') as HTMLInputElement).checked).toBe(true);
 fireEvent.click(screen.getByTestId('hardware-monitoring-enabled'));
 fireEvent.change(screen.getByTestId('hardware-monitoring-raid-interval'),{target:{value:'20'}});
 fireEvent.change(screen.getByTestId('hardware-monitoring-disk-interval'),{target:{value:'120'}});
 fireEvent.click(screen.getByRole('button',{name:/^save$/i}));
 await waitFor(()=>expect(m.save).toHaveBeenCalledWith(null,{featureType:'hardware_monitoring',featurePolicyId:null,inlineSettings:{enabled:false,pollIntervalMinutes:20,diskHealthIntervalMinutes:120}}));
 expect(m.changed).toHaveBeenCalled();
});
it('disables invalid settings and does not clamp partially typed values',()=>{
 render(<HardwareMonitoringTab policyId="policy" existingLink={undefined} linkedPolicyId={null} onLinkChanged={m.changed}/>);
 fireEvent.change(screen.getByTestId('hardware-monitoring-raid-interval'),{target:{value:'1'}});
 expect((screen.getByRole('button',{name:/^save$/i}) as HTMLButtonElement).disabled).toBe(true);
 expect((screen.getByTestId('hardware-monitoring-raid-interval') as HTMLInputElement).value).toBe('1');
});
it('shows inherited values and creates an override without editing the parent',async()=>{
 const parent={id:'parent-link',featureType:'hardware_monitoring' as const,featurePolicyId:null,inlineSettings:{enabled:false,pollIntervalMinutes:30,diskHealthIntervalMinutes:180}};
 render(<HardwareMonitoringTab policyId="policy" existingLink={undefined} parentLink={parent} linkedPolicyId="parent" onLinkChanged={m.changed}/>);
 expect(screen.getByTestId('hardware-monitoring-enabled').closest('fieldset')!.disabled).toBe(true);
 fireEvent.click(screen.getByRole('button',{name:/override/i}));
 await waitFor(()=>expect(m.save).toHaveBeenCalledWith(null,expect.objectContaining({inlineSettings:parent.inlineSettings})));
});
it('does not notify the parent when save fails',async()=>{
 m.save.mockResolvedValue(null);render(<HardwareMonitoringTab policyId="policy" existingLink={undefined} linkedPolicyId={null} onLinkChanged={m.changed}/>);
 fireEvent.click(screen.getByRole('button',{name:/^save$/i}));await waitFor(()=>expect(m.save).toHaveBeenCalled());expect(m.changed).not.toHaveBeenCalled();
});
