import React, { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

export interface BrandingConfig {
  name: string;
  logoUrl?: string;
  primaryColor?: string;
  accentColor?: string;
  supportEmail?: string;
  supportPhone?: string;
}

interface BrandingContextValue {
  branding: BrandingConfig;
  isLoading: boolean;
}

const defaultBranding: BrandingConfig = {
  name: 'Customer Portal',
  supportEmail: 'support@example.com'
};

const BrandingContext = createContext<BrandingContextValue>({
  branding: defaultBranding,
  isLoading: true
});

export function useBranding() {
  return useContext(BrandingContext);
}

interface BrandingProviderProps {
  children: ReactNode;
}

export function BrandingProvider({ children }: BrandingProviderProps) {
  const [branding, setBranding] = useState<BrandingConfig>(defaultBranding);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    // Fetch branding configuration from API
    async function fetchBranding() {
      try {
        const response = await fetch('/api/portal/branding');
        if (response.ok) {
          const data = await response.json();
          setBranding({ ...defaultBranding, ...data });

          // Apply custom CSS variables if colors are defined
          if (data.primaryColor) {
            document.documentElement.style.setProperty('--brand-primary', data.primaryColor);
          }
          if (data.accentColor) {
            document.documentElement.style.setProperty('--brand-accent', data.accentColor);
          }
        }
      } catch {
        // Use default branding on error
      } finally {
        setIsLoading(false);
      }
    }

    fetchBranding();
  }, []);

  return (
    <BrandingContext.Provider value={{ branding, isLoading }}>
      {children}
    </BrandingContext.Provider>
  );
}

export default BrandingProvider;
