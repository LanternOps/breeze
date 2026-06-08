import { create } from 'zustand';
import { fetchWithAuth } from './auth';

export interface Features {
  billing: boolean;
  support: boolean;
}

export interface CfAccessLoginConfig {
  enabled: boolean;
}

interface FeaturesState {
  features: Features;
  cfAccessLogin: CfAccessLoginConfig;
  loaded: boolean;
  load: () => Promise<void>;
}

const DEFAULT_FEATURES: Features = { billing: false, support: false };
const DEFAULT_CF_ACCESS: CfAccessLoginConfig = { enabled: false };

export const useFeaturesStore = create<FeaturesState>()((set, get) => ({
  features: DEFAULT_FEATURES,
  cfAccessLogin: DEFAULT_CF_ACCESS,
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
      };
      set({
        features: {
          billing: !!data.features?.billing,
          support: !!data.features?.support,
        },
        cfAccessLogin: {
          enabled: !!data.cfAccessLogin?.enabled,
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
