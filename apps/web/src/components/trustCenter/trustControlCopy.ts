// Catalog copy for the Trust Center editor (category labels, control titles and descriptions), in the editor
// user's UI language (spec §19 item 31). The strings live in @breeze/shared `trustCopyFor` (single-sourced with
// the public portal); an unsupported language gets English. This is the editor's language, not the published
// page's: the page locale is the partner's document language, frozen at publish.
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  trustCopyFor,
  type DeclaredControlId,
  type TelemetryControlId,
  type TrustControlCategory,
} from '@breeze/shared';

export interface TrustControlCopy {
  categoryLabel(c: TrustControlCategory): string;
  controlTitle(id: TelemetryControlId | DeclaredControlId): string;
  controlDescription(id: TelemetryControlId | DeclaredControlId): string;
}

export function useTrustControlCopy(): TrustControlCopy {
  const { i18n } = useTranslation();
  const language = i18n.resolvedLanguage ?? i18n.language;
  return useMemo(() => {
    const copy = trustCopyFor(language);
    return {
      categoryLabel: (c) => copy.categories[c],
      controlTitle: (id) => copy.controls[id]?.title ?? id,
      controlDescription: (id) => copy.controls[id]?.description ?? '',
    };
  }, [language]);
}
