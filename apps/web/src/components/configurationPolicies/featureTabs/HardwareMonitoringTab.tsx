import { useEffect,useState } from 'react';
import { HardDrive } from 'lucide-react';
import { HARDWARE_MONITORING_DEFAULTS,hardwareMonitoringInlineSettingsSchema } from '@breeze/shared';
import { FEATURE_META,type FeatureTabProps } from './types';
import { useFeatureLink } from './useFeatureLink';
import FeatureTabShell from './FeatureTabShell';

// Stored settings from an older/newer policy shape must not crash the tab; fall back to defaults.
function parseStoredSettings(value:unknown){
 const parsed=hardwareMonitoringInlineSettingsSchema.safeParse(value??HARDWARE_MONITORING_DEFAULTS);
 return parsed.success?parsed.data:{...HARDWARE_MONITORING_DEFAULTS};
}
export default function HardwareMonitoringTab({policyId,existingLink,parentLink,linkedPolicyId,onLinkChanged}:FeatureTabProps){
 const {save,remove,saving,error,clearError}=useFeatureLink(policyId);
 const read=()=>parseStoredSettings((existingLink??parentLink)?.inlineSettings);
 const initial=read();
 const [enabled,setEnabled]=useState(initial.enabled);
 const [raid,setRaid]=useState(String(initial.pollIntervalMinutes));
 const [disk,setDisk]=useState(String(initial.diskHealthIntervalMinutes));
 useEffect(()=>{
  const next=parseStoredSettings((existingLink??parentLink)?.inlineSettings);
  setEnabled(next.enabled);setRaid(String(next.pollIntervalMinutes));setDisk(String(next.diskHealthIntervalMinutes));
 },[existingLink,parentLink]);
 const parsed=hardwareMonitoringInlineSettingsSchema.safeParse({enabled,pollIntervalMinutes:raid===''?NaN:Number(raid),diskHealthIntervalMinutes:disk===''?NaN:Number(disk)});
 const inherited=!!parentLink&&!existingLink;
 const persist=async(id:string|null)=>{
  if(!parsed.success)return;
  clearError();
  const result=await save(id,{featureType:'hardware_monitoring',featurePolicyId:null,inlineSettings:{...parsed.data}});
  if(result)onLinkChanged(result,'hardware_monitoring');
 };
 const discard=async()=>{if(existingLink&&await remove(existingLink.id))onLinkChanged(null,'hardware_monitoring');};
 const meta=FEATURE_META.hardware_monitoring;
 return (
  <FeatureTabShell
   title={meta.label}
   description={meta.description}
   icon={<HardDrive className="h-5 w-5"/>}
   isConfigured={!!existingLink||inherited}
   saving={saving}
   saveDisabled={!parsed.success}
   error={error}
   onSave={()=>void persist(existingLink?.id??null)}
   onRemove={existingLink&&!linkedPolicyId?discard:undefined}
   isInherited={inherited}
   onOverride={inherited?()=>void persist(null):undefined}
   onRevert={!inherited&&!!linkedPolicyId&&!!existingLink?discard:undefined}
  >
   <p className="mb-4 text-sm text-muted-foreground">Probes installed RAID tools and disk health sources. Collection is enabled by default. Attach hardware monitors separately to receive alerts.</p>
   <fieldset disabled={inherited||saving} className="space-y-4">
    <label htmlFor="hardware-enabled" className="flex items-center gap-2">
     <input id="hardware-enabled" data-testid="hardware-monitoring-enabled" role="switch" type="checkbox" checked={enabled} onChange={e=>setEnabled(e.target.checked)}/>
     Enable hardware collection
    </label>
    <label htmlFor="hardware-raid-interval" className="block text-sm">
     RAID interval (minutes, 5–60)
     <input id="hardware-raid-interval" data-testid="hardware-monitoring-raid-interval" type="number" min={5} max={60} step={1} value={raid} onChange={e=>setRaid(e.target.value)} className="mt-2 block h-10 w-full rounded-md border bg-background px-3"/>
    </label>
    <label htmlFor="hardware-disk-interval" className="block text-sm">
     Disk health interval (minutes, 15–1440)
     <input id="hardware-disk-interval" data-testid="hardware-monitoring-disk-interval" type="number" min={15} max={1440} step={1} value={disk} onChange={e=>setDisk(e.target.value)} className="mt-2 block h-10 w-full rounded-md border bg-background px-3"/>
    </label>
   </fieldset>
  </FeatureTabShell>
 );
}
