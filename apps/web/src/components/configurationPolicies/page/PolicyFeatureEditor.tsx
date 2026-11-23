import type { FeatureLink, FeatureTabProps, FeatureType } from '../featureTabs/types';
import PatchTab from '../featureTabs/PatchTab';
import MonitorsTab from '../featureTabs/MonitorsTab';
import BackupTab from '../featureTabs/BackupTab';
import SecurityTab from '../featureTabs/SecurityTab';
import MaintenanceTab from '../featureTabs/MaintenanceTab';
import ComplianceTab from '../featureTabs/ComplianceTab';
import AutomationTab from '../featureTabs/AutomationTab';
import EventLogTab from '../featureTabs/EventLogTab';
import SoftwarePolicyTab from '../featureTabs/SoftwarePolicyTab';
import SensitiveDataTab from '../featureTabs/SensitiveDataTab';
import PeripheralControlTab from '../featureTabs/PeripheralControlTab';
import WarrantyTab from '../featureTabs/WarrantyTab';
import HelperTab from '../featureTabs/HelperTab';
import RemoteAccessTab from '../featureTabs/RemoteAccessTab';
import PamTab from '../featureTabs/PamTab';
import VulnerabilityTab from '../featureTabs/VulnerabilityTab';
import DeviceLifecycleTab from '../featureTabs/DeviceLifecycleTab';
import OneDriveHelperTab from '../featureTabs/OneDriveHelperTab';
import HardwareMonitoringTab from '../featureTabs/HardwareMonitoringTab';
import TimeSyncTab from '../featureTabs/TimeSyncTab';
import WorkloadInventoryTab from '../featureTabs/WorkloadInventoryTab';
import SecurityAgentsTab from '../featureTabs/SecurityAgentsTab';
import SystemProtectionTab from '../featureTabs/SystemProtectionTab';
import ContainmentTab from '../featureTabs/ContainmentTab';
import VendorUpdatesTab from '../featureTabs/VendorUpdatesTab';
import WakeOnLanTab from '../featureTabs/WakeOnLanTab';

type PolicyFeatureEditorProps = {
  featureType: FeatureType;
  policyId: string;
  featureLinks: FeatureLink[];
  parentFeatureLinks: FeatureLink[];
  linkedPolicyId: string | null;
  orgId: string | null;
  partnerId: string | null;
  onLinkChanged: FeatureTabProps['onLinkChanged'];
};

// Exhaustive over FeatureType: a new feature type fails to compile until it
// has an editor here (#2004).
const EDITORS: Record<FeatureType, (props: FeatureTabProps) => React.ReactElement | null> = {
  patch: PatchTab,
  monitors: MonitorsTab,
  backup: BackupTab,
  security: SecurityTab,
  maintenance: MaintenanceTab,
  compliance: ComplianceTab,
  automation: AutomationTab,
  event_log: EventLogTab,
  software_policy: SoftwarePolicyTab,
  sensitive_data: SensitiveDataTab,
  peripheral_control: PeripheralControlTab,
  warranty: WarrantyTab,
  helper: HelperTab,
  remote_access: RemoteAccessTab,
  pam: PamTab,
  vulnerability: VulnerabilityTab,
  device_lifecycle: DeviceLifecycleTab,
  onedrive_helper: OneDriveHelperTab,
  hardware_monitoring: HardwareMonitoringTab,
  time_sync: TimeSyncTab,
  workload_inventory: WorkloadInventoryTab,
  security_agents: SecurityAgentsTab,
  system_protection: SystemProtectionTab,
  containment: ContainmentTab,
  oem_updates: VendorUpdatesTab,
  wake_on_lan: WakeOnLanTab,
};

/** The editor for one feature of a policy, with this policy's and its parent's links. */
export default function PolicyFeatureEditor({
  featureType,
  policyId,
  featureLinks,
  parentFeatureLinks,
  linkedPolicyId,
  orgId,
  partnerId,
  onLinkChanged,
}: PolicyFeatureEditorProps) {
  const linkFor = (t: FeatureType) => featureLinks.find((l) => l.featureType === t);
  const parentLinkFor = (t: FeatureType) => parentFeatureLinks.find((l) => l.featureType === t);
  // Closest-wins advisory links. Monitor detection also receives the parent's
  // attachments for cumulative resolution; existingLink still governs saves.
  const effectiveLinks = [...featureLinks, ...parentFeatureLinks.filter((link) => !linkFor(link.featureType))];
  const Editor = EDITORS[featureType];
  return (
    <Editor
      policyId={policyId}
      existingLink={linkFor(featureType)}
      allLinks={effectiveLinks}
      inheritedMonitorsLink={parentLinkFor('monitors')}
      onLinkChanged={onLinkChanged}
      linkedPolicyId={linkedPolicyId}
      parentLink={parentLinkFor(featureType)}
      siblingLinks={featureLinks}
      orgId={orgId}
      partnerId={partnerId}
    />
  );
}
