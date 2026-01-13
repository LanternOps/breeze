import { createContext, useContext, useMemo, type ReactNode } from 'react';

export type PortalBranding = {
  name: string;
  logoUrl?: string;
  logoAlt?: string;
  primaryColor?: string;
  secondaryColor?: string;
  supportEmail?: string;
};

type BrandingProviderProps = {
  branding: PortalBranding;
  children: ReactNode;
};

type BrandingContextValue = {
  branding: PortalBranding;
};

const BrandingContext = createContext<BrandingContextValue | null>(null);

export default function BrandingProvider({ branding, children }: BrandingProviderProps) {
  const value = useMemo(() => ({ branding }), [branding]);

  return <BrandingContext.Provider value={value}>{children}</BrandingContext.Provider>;
}

export function usePortalBranding(): PortalBranding {
  const context = useContext(BrandingContext);

  if (!context) {
    return {
      name: 'Breeze Portal'
    };
  }

  return context.branding;
}
