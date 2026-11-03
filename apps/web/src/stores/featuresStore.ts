import { useEffect } from 'react';
import { create } from 'zustand';
import { fetchWithAuth } from './auth';

export interface Features {
  billing: boolean;
  support: boolean;
  aiOperatorTasks: boolean;
  aiAgentsSweepAct: boolean;
  /** #9939: the server's BREEZE_AI_AGENTS_POLICY_DECIDE_ENABLED switch. Off ⇒
   *  "Approve and always allow" can never render, so the approvals inbox skips
   *  its `GET /ai/agents/graduation` prefetch entirely. */
  aiAgentsPolicyDecide: boolean;
  /** Tool catalog W01 (#5216): the server's TOOL_SOURCES_ENABLED kill switch.
   *  Off ⇒ every /tool-sources route answers 404, so the nav item and pages
   *  must be hidden rather than linking to a dead surface. */
  toolSources: boolean;
  /** Tool catalog W3 (#5218): the server's FLOWS_ENABLED kill switch. Off ⇒
   *  every /flows route answers 404, so the nav item and pages are hidden. */
  flows: boolean;
  /** The server's PRE_ASSIGNMENT_ENROLLMENT_ENABLED platform switch. Off ⇒
   *  the Unassigned Devices nav entry and page are hidden. */
  preAssignmentEnrollment: boolean;
  /** The server's CALLER_VERIFICATION_ENABLED switch (#6354). Off ⇒ every
   *  caller-verification surface stays unmounted and makes no requests. */
  callerVerification: boolean;
  /** Partner sending domains (#9949): true only while the server has an
   *  EMAIL_DOMAINS_PROVIDER. Off ⇒ every /partner/sending-domains route
   *  answers 404, so the Sender Addresses tab stays hidden and is never probed. */
  sendingDomains: boolean;
}

export interface CfAccessLoginConfig {
  enabled: boolean;
}

export interface RegistrationConfig {
  enabled: boolean;
}

export interface SoftwarePackagesConfig {
  uploadsEnabled: boolean;
}

interface FeaturesState {
  features: Features;
  cfAccessLogin: CfAccessLoginConfig;
  registration: RegistrationConfig;
  softwarePackages: SoftwarePackagesConfig;
  loaded: boolean;
  /** True only once /config answered and parsed. `loaded` is also true after a
   *  failed read (the defaults stand); a gate that can recover on its own,
   *  such as the sending-domains probe, reads this to tell the two apart. */
  configOk: boolean;
  load: () => Promise<void>;
}

// aiOperatorTasks default CLOSED: this gates a write action that starts
// autonomous remediation on a customer machine, and the underlying server
// flags are off by default (decision D2). An unreachable or older /config
// (missing the field) must hide the "Delegate to Operator" button, never
// show it.
const DEFAULT_FEATURES: Features = { billing: false, support: false, aiOperatorTasks: false, aiAgentsSweepAct: false, aiAgentsPolicyDecide: false, toolSources: false, flows: false, preAssignmentEnrollment: false, callerVerification: false, sendingDomains: false };
const DEFAULT_CF_ACCESS: CfAccessLoginConfig = { enabled: false };
// Default closed: until /config confirms registration is open we hide the
// registration UI rather than flash a link that may be disabled (#1308).
const DEFAULT_REGISTRATION: RegistrationConfig = { enabled: false };
// Default OPEN, unlike registration: if /config is unreachable (or an older
// API doesn't return the field) we must not gray out uploads that would work —
// worst case the user hits the same 503 the upload routes already return.
const DEFAULT_SOFTWARE_PACKAGES: SoftwarePackagesConfig = { uploadsEnabled: true };

// The read in flight, shared by every caller that asks before it settles: a
// page that mounts several gated surfaces at once (the partner settings page
// reads caller verification and sending domains) issues one /config, not one
// per gate (#9949). Cleared on settle, so a later reset-and-load reads again.
let inflight: Promise<void> | null = null;

export const useFeaturesStore = create<FeaturesState>()((set, get) => {
  const readConfig = async (): Promise<void> => {
    try {
      const res = await fetchWithAuth('/config', { method: 'GET' });
      if (!res.ok) {
        console.error('[features] /config fetch failed:', { status: res.status });
        set({ loaded: true, configOk: false });
        return;
      }
      const data = (await res.json()) as {
        features?: Partial<Features>;
        cfAccessLogin?: Partial<CfAccessLoginConfig>;
        registration?: Partial<RegistrationConfig>;
        softwarePackages?: Partial<SoftwarePackagesConfig>;
      };
      set({
        features: {
          billing: !!data.features?.billing,
          support: !!data.features?.support,
          aiOperatorTasks: !!data.features?.aiOperatorTasks,
          aiAgentsSweepAct: data.features?.aiAgentsSweepAct === true,
          // Default CLOSED: an older or unreachable /config skips the prefetch.
          aiAgentsPolicyDecide: data.features?.aiAgentsPolicyDecide === true,
          // Default CLOSED, like aiOperatorTasks: an older or unreachable
          // /config must hide a surface that authors credentials reaching
          // customer systems, never flash it.
          toolSources: !!data.features?.toolSources,
          // Default CLOSED: only an exact boolean true mounts the Flows surface.
          flows: data.features?.flows === true,
          // Default CLOSED: an older or unreachable /config hides the surface.
          preAssignmentEnrollment: data.features?.preAssignmentEnrollment === true,
          // Default CLOSED: only an exact boolean true mounts the feature.
          callerVerification: data.features?.callerVerification === true,
          // Default CLOSED: an older or unreachable /config hides the tab and
          // skips the list read that would 404.
          sendingDomains: data.features?.sendingDomains === true,
        },
        cfAccessLogin: {
          enabled: !!data.cfAccessLogin?.enabled,
        },
        registration: {
          enabled: !!data.registration?.enabled,
        },
        softwarePackages: {
          // Missing field (older API) keeps the open default.
          uploadsEnabled: data.softwarePackages?.uploadsEnabled !== false,
        },
        loaded: true,
        configOk: true,
      });
    } catch (err) {
      console.error('[features] /config fetch failed:', err instanceof Error ? err.message : err);
      set({ loaded: true, configOk: false });
    }
  };

  return {
    features: DEFAULT_FEATURES,
    cfAccessLogin: DEFAULT_CF_ACCESS,
    registration: DEFAULT_REGISTRATION,
    softwarePackages: DEFAULT_SOFTWARE_PACKAGES,
    loaded: false,
    configOk: false,
    load: () => {
      if (get().loaded) return Promise.resolve();
      inflight ??= readConfig().finally(() => { inflight = null; });
      return inflight;
    },
  };
});

export function useFeatures(): Features {
  return useFeaturesStore((s) => s.features);
}

// useRegistrationGate ensures the runtime /config is loaded and reports whether
// self-service registration is open. `loaded` lets callers distinguish
// "not yet known" from "known disabled" so they can avoid flashing the
// registration UI before the answer arrives (#1308).
//
// `active` (default true), like usePackageUploadsGate's, defers the /config
// fetch until the caller says so — PartnerRegisterPage (sweep paper cut #1)
// passes `active: false` while it is still resolving whether an
// already-signed-in visitor should be redirected to the dashboard instead,
// so /config's fetchWithAuth call can't race that page's own session check.
export function useRegistrationGate(active = true): { enabled: boolean; loaded: boolean } {
  const enabled = useFeaturesStore((s) => s.registration.enabled);
  const loaded = useFeaturesStore((s) => s.loaded);
  const load = useFeaturesStore((s) => s.load);
  useEffect(() => {
    if (active) void load();
  }, [active, load]);
  return { enabled, loaded };
}

// useAiOperatorTasksGate ensures the runtime /config is loaded and reports
// whether the "Delegate to Operator" action should be shown. `loaded` lets
// callers distinguish "not yet known" from "known disabled" so they can avoid
// flashing the button before the answer arrives (W08 of #5205, #5246).
export function useAiOperatorTasksGate(): { enabled: boolean; loaded: boolean } {
  const enabled = useFeaturesStore((s) => s.features.aiOperatorTasks);
  const loaded = useFeaturesStore((s) => s.loaded);
  const load = useFeaturesStore((s) => s.load);
  useEffect(() => {
    void load();
  }, [load]);
  return { enabled, loaded };
}

// #9939: whether policy-decide is on, i.e. whether the approvals inbox's
// "Approve and always allow" affordance can exist at all. `loaded` lets the
// caller hold its graduation prefetch until the answer is known rather than
// firing it optimistically and discarding the result.
export function useAiAgentsPolicyDecideGate(): { enabled: boolean; loaded: boolean } {
  const enabled = useFeaturesStore((s) => s.features.aiAgentsPolicyDecide);
  const loaded = useFeaturesStore((s) => s.loaded);
  const load = useFeaturesStore((s) => s.load);
  useEffect(() => {
    void load();
  }, [load]);
  return { enabled, loaded };
}

// Whether software package file uploads are possible (S3 storage configured on
// the server). Defaults open until /config says otherwise — see
// DEFAULT_SOFTWARE_PACKAGES above. Pass `active: false` to defer the /config
// fetch until the consuming surface is actually shown (e.g. a closed modal).
export function usePackageUploadsGate(active = true): {
  enabled: boolean;
  loaded: boolean;
} {
  const enabled = useFeaturesStore((s) => s.softwarePackages.uploadsEnabled);
  const loaded = useFeaturesStore((s) => s.loaded);
  const load = useFeaturesStore((s) => s.load);
  useEffect(() => {
    if (active) void load();
  }, [active, load]);
  return { enabled, loaded };
}

// useToolSourcesGate ensures the runtime /config is loaded and reports whether
// the Tool Sources surface exists on this deployment (#5216 W01). `loaded`
// lets callers distinguish "not yet known" from "known disabled".
export function useToolSourcesGate(): { enabled: boolean; loaded: boolean } {
  const enabled = useFeaturesStore((s) => s.features.toolSources);
  const loaded = useFeaturesStore((s) => s.loaded);
  const load = useFeaturesStore((s) => s.load);
  useEffect(() => {
    void load();
  }, [load]);
  return { enabled, loaded };
}

// useFlowsGate ensures the runtime /config is loaded and reports whether the
// Flows surface exists on this deployment (#5218). `loaded` lets callers
// distinguish "not yet known" from "known disabled".
export function useFlowsGate(): { enabled: boolean; loaded: boolean } {
  const enabled = useFeaturesStore((s) => s.features.flows);
  const loaded = useFeaturesStore((s) => s.loaded);
  const load = useFeaturesStore((s) => s.load);
  useEffect(() => {
    void load();
  }, [load]);
  return { enabled, loaded };
}

// usePreAssignmentGate ensures the runtime /config is loaded and reports
// whether the Unassigned Devices surface is shown on this deployment
// (PRE_ASSIGNMENT_ENROLLMENT_ENABLED). `loaded` distinguishes "not yet known"
// from "known disabled".
export function usePreAssignmentGate(): { enabled: boolean; loaded: boolean } {
  const enabled = useFeaturesStore((s) => s.features.preAssignmentEnrollment);
  const loaded = useFeaturesStore((s) => s.loaded);
  const load = useFeaturesStore((s) => s.load);
  useEffect(() => {
    void load();
  }, [load]);
  return { enabled, loaded };
}
