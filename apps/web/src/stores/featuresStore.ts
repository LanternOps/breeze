import { useEffect } from 'react';
import { create } from 'zustand';
import { fetchWithAuth } from './auth';

export interface Features {
  billing: boolean;
  support: boolean;
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
  load: () => Promise<void>;
}

const DEFAULT_FEATURES: Features = { billing: false, support: false };
const DEFAULT_CF_ACCESS: CfAccessLoginConfig = { enabled: false };
// Default closed: until /config confirms registration is open we hide the
// registration UI rather than flash a link that may be disabled (#1308).
const DEFAULT_REGISTRATION: RegistrationConfig = { enabled: false };
// Default OPEN, unlike registration: if /config is unreachable (or an older
// API doesn't return the field) we must not gray out uploads that would work —
// worst case the user hits the same 503 the upload routes already return.
const DEFAULT_SOFTWARE_PACKAGES: SoftwarePackagesConfig = { uploadsEnabled: true };

export const useFeaturesStore = create<FeaturesState>()((set, get) => ({
  features: DEFAULT_FEATURES,
  cfAccessLogin: DEFAULT_CF_ACCESS,
  registration: DEFAULT_REGISTRATION,
  softwarePackages: DEFAULT_SOFTWARE_PACKAGES,
  loaded: false,
  load: async () => {
    if (get().loaded) return;
    try {
      const res = await fetchWithAuth('/config', { method: 'GET' });
      if (!res.ok) {
        console.error('[features] /config fetch failed:', { status: res.status });
        set({ loaded: true });
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
      });
    } catch (err) {
      console.error('[features] /config fetch failed:', err instanceof Error ? err.message : err);
      set({ loaded: true });
    }
  },
}));

export function useFeatures(): Features {
  return useFeaturesStore((s) => s.features);
}

// useRegistrationGate ensures the runtime /config is loaded and reports whether
// self-service registration is open. `loaded` lets callers distinguish
// "not yet known" from "known disabled" so they can avoid flashing the
// registration UI before the answer arrives (#1308).
export function useRegistrationGate(): { enabled: boolean; loaded: boolean } {
  const enabled = useFeaturesStore((s) => s.registration.enabled);
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
