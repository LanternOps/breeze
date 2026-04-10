import { sanitizeImageSrc } from '../../lib/safeImageSrc';

interface BrandHeaderProps {
  /** Partner logo. Sanitized before render; falls back to the Breeze SVG when null/unsafe. */
  logoUrl: string | null | undefined;
  /** Partner name. Falls back to "Breeze" when null/empty. */
  name: string | null | undefined;
  /** Whether to render the text label (hidden in collapsed sidebar mode). */
  showLabel: boolean;
}

const BREEZE_SVG = (
  <svg width="14" height="14" viewBox="0 0 64 64" fill="none" className="text-primary">
    <path
      d="M12 22C12 22 20 22 28 22C36 22 40 16 48 16C52 16 54 18 54 20C54 22 52 24 48 24C44 24 42 22 42 22"
      stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"
    />
    <path
      d="M8 34C8 34 18 34 30 34C42 34 46 28 52 28C55 28 57 30 57 32C57 34 55 36 52 36C48 36 46 34 46 34"
      stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"
    />
    <path
      d="M14 46C14 46 22 46 32 46C40 46 44 40 50 40C53 40 55 42 55 44C55 46 53 48 50 48C46 48 44 46 44 46"
      stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"
    />
  </svg>
);

export default function BrandHeader({ logoUrl, name, showLabel }: BrandHeaderProps) {
  const safeLogoUrl = sanitizeImageSrc(logoUrl);
  const label = name?.trim() || 'Breeze';

  return (
    <div className="flex items-center gap-2">
      <div className="flex h-[22px] w-[22px] shrink-0 items-center justify-center overflow-hidden rounded-[6px] bg-primary/15">
        {safeLogoUrl ? (
          <img src={safeLogoUrl} alt={`${label} logo`} className="h-full w-full object-contain" />
        ) : (
          BREEZE_SVG
        )}
      </div>
      {showLabel && (
        <span className="text-lg font-bold tracking-tight text-foreground truncate">{label}</span>
      )}
    </div>
  );
}
