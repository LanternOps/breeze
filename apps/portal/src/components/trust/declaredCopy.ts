// Owner: W02b. Public-page copy for the declared-controls section, in the 8 supported locales (amendment 31:
// typed copy modules, no i18n runtime). Control titles come from @breeze/shared trustCenter/copy (W02h) when it
// is present, else from the declared catalog's English.
import { defineTrustCopy } from './trustCopy';

export const declaredCopy = defineTrustCopy({
  en: {
    heading: 'Declared by the provider',
    intro: 'These practices are stated by the provider, not measured by Breeze. Each declaration is valid for one year.',
    marker: 'Declared',
    declaredBy: (name: string, date: string) => `Declared by ${name} on ${date}`,
    expiredOn: (date: string) => `Declaration expired on ${date}`,
    evidence: (title: string) => `Evidence: ${title}`,
  },
  'pt-BR': {
    heading: 'Declarado pelo provedor',
    intro: 'Estas práticas são declaradas pelo provedor, não medidas pelo Breeze. Cada declaração vale por um ano.',
    marker: 'Declarado',
    declaredBy: (name: string, date: string) => `Declarado por ${name} em ${date}`,
    expiredOn: (date: string) => `Declaração vencida em ${date}`,
    evidence: (title: string) => `Evidência: ${title}`,
  },
  'es-419': {
    heading: 'Declarado por el proveedor',
    intro: 'Estas prácticas las declara el proveedor; Breeze no las mide. Cada declaración es válida por un año.',
    marker: 'Declarado',
    declaredBy: (name: string, date: string) => `Declarado por ${name} el ${date}`,
    expiredOn: (date: string) => `La declaración venció el ${date}`,
    evidence: (title: string) => `Evidencia: ${title}`,
  },
  'fr-FR': {
    heading: 'Déclaré par le prestataire',
    intro: 'Ces pratiques sont déclarées par le prestataire et non mesurées par Breeze. Chaque déclaration est valable un an.',
    marker: 'Déclaré',
    declaredBy: (name: string, date: string) => `Déclaré par ${name} le ${date}`,
    expiredOn: (date: string) => `Déclaration expirée le ${date}`,
    evidence: (title: string) => `Justificatif : ${title}`,
  },
  'fr-CA': {
    heading: 'Déclaré par le fournisseur',
    intro: 'Ces pratiques sont déclarées par le fournisseur et non mesurées par Breeze. Chaque déclaration est valide un an.',
    marker: 'Déclaré',
    declaredBy: (name: string, date: string) => `Déclaré par ${name} le ${date}`,
    expiredOn: (date: string) => `Déclaration expirée le ${date}`,
    evidence: (title: string) => `Justificatif : ${title}`,
  },
  'de-DE': {
    heading: 'Vom Anbieter erklärt',
    intro: 'Diese Maßnahmen erklärt der Anbieter selbst; Breeze misst sie nicht. Jede Erklärung gilt ein Jahr.',
    marker: 'Erklärt',
    declaredBy: (name: string, date: string) => `Erklärt von ${name} am ${date}`,
    expiredOn: (date: string) => `Erklärung abgelaufen am ${date}`,
    evidence: (title: string) => `Nachweis: ${title}`,
  },
  'it-IT': {
    heading: 'Dichiarato dal fornitore',
    intro: 'Queste pratiche sono dichiarate dal fornitore, non misurate da Breeze. Ogni dichiarazione vale un anno.',
    marker: 'Dichiarato',
    declaredBy: (name: string, date: string) => `Dichiarato da ${name} il ${date}`,
    expiredOn: (date: string) => `Dichiarazione scaduta il ${date}`,
    evidence: (title: string) => `Prova: ${title}`,
  },
  'tr-TR': {
    heading: 'Sağlayıcı tarafından beyan edildi',
    intro: 'Bu uygulamalar Breeze tarafından ölçülmez, sağlayıcı tarafından beyan edilir. Her beyan bir yıl geçerlidir.',
    marker: 'Beyan',
    declaredBy: (name: string, date: string) => `${name} tarafından ${date} tarihinde beyan edildi`,
    expiredOn: (date: string) => `Beyanın süresi ${date} tarihinde doldu`,
    evidence: (title: string) => `Kanıt: ${title}`,
  },
});
