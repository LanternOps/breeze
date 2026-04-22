import { create } from 'zustand';
import { fetchWithAuth } from './auth';

export interface Features {
  billing: boolean;
  support: boolean;
}

interface FeaturesState {
  features: Features;
  loaded: boolean;
  load: () => Promise<void>;
}

const DEFAULT: Features = { billing: false, support: false };

export const useFeaturesStore = create<FeaturesState>()((set, get) => ({
  features: DEFAULT,
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
      const data = (await res.json()) as { features?: Partial<Features> };
      set({
        features: {
          billing: !!data.features?.billing,
          support: !!data.features?.support,
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
