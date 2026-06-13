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

interface FeaturesState {
  features: Features;
  cfAccessLogin: CfAccessLoginConfig;
  registration: RegistrationConfig;
  loaded: boolean;
  load: () => Promise<void>;
}

const DEFAULT_FEATURES: Features = { billing: false, support: false };
const DEFAULT_CF_ACCESS: CfAccessLoginConfig = { enabled: false };
// Default closed: until /config confirms registration is open we hide the
// registration UI rather than flash a link that may be disabled (#1308).
const DEFAULT_REGISTRATION: RegistrationConfig = { enabled: false };

export const useFeaturesStore = create<FeaturesState>()((set, get) => ({
  features: DEFAULT_FEATURES,
  cfAccessLogin: DEFAULT_CF_ACCESS,
  registration: DEFAULT_REGISTRATION,
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
