// Copy for the hardening-safeguards disclosure (W03e). Per-section typed copy via defineTrustCopy (spec §19 item 31);
// never i18next on the public page. Safeguard labels come from @breeze/shared (crosswalk copy), never the payload.
// Never a claim of compliance: the note says so in every locale.
import { defineTrustCopy } from './trustCopy';

export const hardeningSafeguardsCopy = defineTrustCopy({
  en: {
    disclosure: (n: number) => `Safeguards evidenced by hardening checks (${n})`,
    note: 'Only some hardening checks map to a named safeguard, so this list is partial. It is not a statement of compliance.',
  },
  'pt-BR': {
    disclosure: (n: number) => `Salvaguardas evidenciadas por verificações de hardening (${n})`,
    note: 'Apenas algumas verificações de hardening correspondem a uma salvaguarda nomeada, portanto esta lista é parcial. Não é uma declaração de conformidade.',
  },
  'es-419': {
    disclosure: (n: number) => `Salvaguardas respaldadas por verificaciones de endurecimiento (${n})`,
    note: 'Solo algunas verificaciones de endurecimiento corresponden a una salvaguarda con nombre, por lo que esta lista es parcial. No es una declaración de cumplimiento.',
  },
  'fr-FR': {
    disclosure: (n: number) => `Mesures de sécurité étayées par les contrôles de durcissement (${n})`,
    note: 'Seuls certains contrôles de durcissement correspondent à une mesure de sécurité nommée ; cette liste est donc partielle. Ceci n’est pas une déclaration de conformité.',
  },
  'fr-CA': {
    disclosure: (n: number) => `Mesures de sécurité appuyées par les vérifications de durcissement (${n})`,
    note: 'Seules certaines vérifications de durcissement correspondent à une mesure de sécurité nommée; cette liste est donc partielle. Il ne s’agit pas d’une déclaration de conformité.',
  },
  'de-DE': {
    disclosure: (n: number) => `Durch Härtungsprüfungen belegte Schutzmaßnahmen (${n})`,
    note: 'Nur einige Härtungsprüfungen lassen sich einer benannten Schutzmaßnahme zuordnen, daher ist diese Liste unvollständig. Sie ist keine Konformitätserklärung.',
  },
  'it-IT': {
    disclosure: (n: number) => `Salvaguardie supportate dai controlli di hardening (${n})`,
    note: 'Solo alcuni controlli di hardening corrispondono a una salvaguardia nominata, quindi questo elenco è parziale. Non costituisce una dichiarazione di conformità.',
  },
  'tr-TR': {
    disclosure: (n: number) => `Sıkılaştırma denetimleriyle kanıtlanan güvenlik önlemleri (${n})`,
    note: 'Yalnızca bazı sıkılaştırma denetimleri adlandırılmış bir güvenlik önlemiyle eşleşir; bu nedenle bu liste kısmidir. Bir uygunluk beyanı değildir.',
  },
});
