import { useTranslation } from 'react-i18next';
import {
  ClipboardCheck,
  Clock,
  Cloud,
  Container,
  Cpu,
  HardDrive,
  History,
  KeyRound,
  LifeBuoy,
  ListChecks,
  Monitor,
  PackageCheck,
  Power,
  Radar,
  ScanSearch,
  ScrollText,
  Shield,
  ShieldAlert,
  ShieldBan,
  ShieldCheck,
  Trash2,
  Usb,
  Wrench,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { i18n } from '@/lib/i18n';
import SettingsSectionNav, { type SettingsNavGroup } from '../../settings/SettingsSectionNav';
import { configFeatureLabel } from '../configPolicyLabels';
import { FEATURE_META, type FeatureLink, type FeatureType } from '../featureTabs/types';
import { FEATURE_RAIL_GROUPS, featureState, featureStateLabel } from './featureState';
import { outrankedFor, type PolicyPrecedence } from './precedenceApi';

/** A rail entry: a feature, or the Compliance status results view at the foot. */
export type RailKey = FeatureType | 'compliance_status';

// Exhaustive over FeatureType (a full Record) so a new feature type fails to
// compile until it has a rail icon (#2004).
const FEATURE_ICONS: Record<FeatureType, LucideIcon> = {
  patch: PackageCheck,
  monitors: Radar,
  backup: HardDrive,
  security: Shield,
  maintenance: Wrench,
  compliance: ClipboardCheck,
  automation: Zap,
  event_log: ScrollText,
  software_policy: PackageCheck,
  sensitive_data: ScanSearch,
  peripheral_control: Usb,
  warranty: ShieldCheck,
  helper: LifeBuoy,
  remote_access: Monitor,
  pam: KeyRound,
  vulnerability: ShieldAlert,
  device_lifecycle: Trash2,
  onedrive_helper: Cloud,
  hardware_monitoring: HardDrive,
  time_sync: Clock,
  workload_inventory: Container,
  security_agents: ShieldCheck,
  system_protection: History,
  containment: ShieldBan,
  oem_updates: Cpu,
  wake_on_lan: Power,
};

type FeatureRailProps = {
  activeKey: RailKey;
  /** This policy's own feature links. */
  ownLinks: FeatureLink[];
  /** The parent policy's feature links (empty when there is no parent). */
  parentLinks: FeatureLink[];
  /** Whether this policy cannot carry the feature (spec Decision 4). */
  isGated: (featureType: FeatureType) => boolean;
  /** The rail entry holding unsaved changes, if any. */
  dirtyKey: RailKey | null;
  /** The page decides whether to switch (it may ask about unsaved changes first). */
  onNavigate: (key: RailKey) => void;
  /**
   * Where another policy wins each feature (#12472). A count above zero joins
   * the state line; capped, unknown and zero leave the plain state (the open
   * feature's line says capped).
   */
  precedence?: PolicyPrecedence | null;
};

/**
 * The grouped feature rail that replaces the policy page's tab strip
 * (spec "Policy page"; plan W03b H2). Built on SettingsSectionNav, so it is a
 * vertical rail at lg+ and a picker below. Each entry's href is the raw
 * feature type (`#onedrive_helper`), which inbound links already use.
 */
export default function FeatureRail({
  activeKey,
  ownLinks,
  parentLinks,
  isGated,
  dirtyKey,
  onNavigate,
  precedence = null,
}: FeatureRailProps) {
  useTranslation('policies');
  const groups: SettingsNavGroup[] = [
    ...FEATURE_RAIL_GROUPS.map((group) => ({
      label: i18n.t(/* i18n-dynamic */ `policies:configurationPolicies.featureRail.groups.${group.key}.label`),
      items: group.features.map((featureType) => {
        const state = featureState(
          ownLinks.find((l) => l.featureType === featureType),
          parentLinks.find((l) => l.featureType === featureType),
          isGated(featureType),
        );
        const outranked = outrankedFor(precedence, featureType, state);
        const status =
          outranked?.kind === 'outranked'
            ? i18n.t('policies:configurationPolicies.featureRail.statusOutranked', {
                state: featureStateLabel(state),
                count: outranked.count,
              })
            : featureStateLabel(state);
        return {
          key: featureType,
          hash: featureType,
          label: configFeatureLabel(featureType),
          description: FEATURE_META[featureType].description,
          status,
          icon: FEATURE_ICONS[featureType],
          dirty: dirtyKey === featureType,
        };
      }),
    })),
    {
      label: i18n.t('policies:configurationPolicies.featureRail.groups.results.label'),
      items: [
        {
          key: 'compliance_status',
          hash: 'compliance_status',
          label: i18n.t('policies:configurationPolicies.configPolicyDetailPage.complianceStatus'),
          description: '',
          icon: ListChecks,
          dirty: false,
        },
      ],
    },
  ];
  return (
    <SettingsSectionNav
      groups={groups}
      activeKey={activeKey}
      onNavigate={(key) => onNavigate(key as RailKey)}
      selectId="config-policy-feature-select"
      testIdPrefix="config-policy-rail"
      navLabel={i18n.t('policies:configurationPolicies.featureRail.navLabel')}
      selectLabel={i18n.t('policies:configurationPolicies.featureRail.selectLabel')}
    />
  );
}
