// Copy for the Trust Center framework view (W02e). Per-section typed copy via defineTrustCopy (spec §19 item 31);
// never i18next on the public page. Framework names and control titles come from @breeze/shared.
import { defineTrustCopy } from './trustCopy';

export const frameworkCopy = defineTrustCopy({
  en: {
    heading: 'Framework view',
    summary: (evidenced: number, total: number, verified: number, declared: number) =>
      `Evidence shown for ${evidenced} of ${total} safeguards (${verified} verified by Breeze telemetry · ${declared} declared by the provider).`,
    disclaimer: 'This is not a statement of compliance.',
    declaredBadge: 'Declared',
    declaredExpired: 'Declaration expired · not counted',
    notCounted: 'Not counted',
    noControls: 'No shown control maps to this framework yet.',
  },
  'pt-BR': {
    heading: 'Visão por framework',
    summary: (evidenced: number, total: number, verified: number, declared: number) =>
      `Evidências apresentadas para ${evidenced} de ${total} salvaguardas (${verified} verificadas pela telemetria do Breeze · ${declared} declaradas pelo provedor).`,
    disclaimer: 'Isto não é uma declaração de conformidade.',
    declaredBadge: 'Declarado',
    declaredExpired: 'Declaração expirada · não contabilizada',
    notCounted: 'Não contabilizado',
    noControls: 'Nenhum controle exibido corresponde a este framework ainda.',
  },
  'es-419': {
    heading: 'Vista por marco de referencia',
    summary: (evidenced: number, total: number, verified: number, declared: number) =>
      `Evidencia mostrada para ${evidenced} de ${total} salvaguardas (${verified} verificadas por la telemetría de Breeze · ${declared} declaradas por el proveedor).`,
    disclaimer: 'Esto no es una declaración de cumplimiento.',
    declaredBadge: 'Declarado',
    declaredExpired: 'Declaración vencida · no se cuenta',
    notCounted: 'No se cuenta',
    noControls: 'Ningún control mostrado corresponde todavía a este marco.',
  },
  'fr-FR': {
    heading: 'Vue par référentiel',
    summary: (evidenced: number, total: number, verified: number, declared: number) =>
      `Preuves présentées pour ${evidenced} mesures de sécurité sur ${total} (${verified} vérifiées par la télémétrie Breeze · ${declared} déclarées par le prestataire).`,
    disclaimer: 'Ceci n’est pas une déclaration de conformité.',
    declaredBadge: 'Déclaré',
    declaredExpired: 'Déclaration expirée · non comptabilisée',
    notCounted: 'Non comptabilisé',
    noControls: 'Aucun contrôle affiché ne correspond encore à ce référentiel.',
  },
  'fr-CA': {
    heading: 'Vue par cadre de référence',
    summary: (evidenced: number, total: number, verified: number, declared: number) =>
      `Preuves présentées pour ${evidenced} mesures de sécurité sur ${total} (${verified} vérifiées par la télémétrie Breeze · ${declared} déclarées par le fournisseur).`,
    disclaimer: 'Ceci n’est pas une déclaration de conformité.',
    declaredBadge: 'Déclaré',
    declaredExpired: 'Déclaration expirée · non comptée',
    notCounted: 'Non compté',
    noControls: 'Aucun contrôle affiché ne correspond encore à ce cadre de référence.',
  },
  'de-DE': {
    heading: 'Framework-Ansicht',
    summary: (evidenced: number, total: number, verified: number, declared: number) =>
      `Nachweise für ${evidenced} von ${total} Sicherheitsmaßnahmen (${verified} per Breeze-Telemetrie verifiziert · ${declared} vom Anbieter erklärt).`,
    disclaimer: 'Dies ist keine Konformitätserklärung.',
    declaredBadge: 'Erklärt',
    declaredExpired: 'Erklärung abgelaufen · nicht gezählt',
    notCounted: 'Nicht gezählt',
    noControls: 'Noch keine angezeigte Kontrolle ist diesem Framework zugeordnet.',
  },
  'it-IT': {
    heading: 'Vista per framework',
    summary: (evidenced: number, total: number, verified: number, declared: number) =>
      `Evidenze mostrate per ${evidenced} salvaguardie su ${total} (${verified} verificate dalla telemetria di Breeze · ${declared} dichiarate dal fornitore).`,
    disclaimer: 'Questa non è una dichiarazione di conformità.',
    declaredBadge: 'Dichiarato',
    declaredExpired: 'Dichiarazione scaduta · non conteggiata',
    notCounted: 'Non conteggiato',
    noControls: 'Nessun controllo mostrato corrisponde ancora a questo framework.',
  },
  'tr-TR': {
    heading: 'Çerçeve görünümü',
    summary: (evidenced: number, total: number, verified: number, declared: number) =>
      `${total} güvenlik önleminin ${evidenced} tanesi için kanıt gösteriliyor (${verified} Breeze telemetrisiyle doğrulandı · ${declared} sağlayıcı tarafından beyan edildi).`,
    disclaimer: 'Bu bir uygunluk beyanı değildir.',
    declaredBadge: 'Beyan edilen',
    declaredExpired: 'Beyan süresi doldu · sayılmadı',
    notCounted: 'Sayılmadı',
    noControls: 'Gösterilen hiçbir kontrol henüz bu çerçeveyle eşleşmiyor.',
  },
});
