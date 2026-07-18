import { Building2, MapPin, User, Mail, Phone, Globe } from 'lucide-react';
import type { PartnerSettings } from '@breeze/shared';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';

type Address = NonNullable<PartnerSettings['address']>;
type Contact = NonNullable<PartnerSettings['contact']>;

type Props = {
  name: string;
  address: Address;
  contact: Contact;
  emailSignature: string;
  onNameChange: (value: string) => void;
  onAddressChange: (value: Address) => void;
  onContactChange: (value: Contact) => void;
  onEmailSignatureChange: (value: string) => void;
};

// Matches the server-side cap on partners.email_signature (PATCH /partners/me).
const MAX_EMAIL_SIGNATURE_LENGTH = 2000;

const COUNTRY_CODES = ['', 'US', 'CA', 'MX', 'GB', 'IE', 'FR', 'DE', 'ES', 'IT', 'NL', 'BE', 'CH', 'AT', 'SE', 'NO', 'DK', 'FI', 'PL', 'PT', 'CZ', 'GR', 'AU', 'NZ', 'JP', 'KR', 'CN', 'HK', 'SG', 'IN', 'AE', 'IL', 'ZA', 'BR', 'AR', 'CL', 'CO'] as const;

const inputClass = 'h-10 w-full rounded-md border bg-background px-3 text-sm';

export default function PartnerCompanyTab({
  name,
  address,
  contact,
  emailSignature,
  onNameChange,
  onAddressChange,
  onContactChange,
  onEmailSignatureChange,
}: Props) {
  const { t } = useTranslation('settings');
  const setAddress = (field: keyof Address, value: string) => {
    onAddressChange({ ...address, [field]: value });
  };
  const setContact = (field: keyof Contact, value: string) => {
    onContactChange({ ...contact, [field]: value });
  };

  return (
    <div className="space-y-6">
      {/* Company */}
      <section className="rounded-lg border bg-card p-6 shadow-xs">
        <div className="mb-6 flex items-center gap-2">
          <Building2 className="h-5 w-5 text-muted-foreground" />
          <h2 className="text-lg font-semibold">{t('partnerCompany.company')}</h2>
        </div>
        <div className="space-y-2">
          <label htmlFor="company-name" className="text-sm font-medium">
            {t('partnerCompany.companyName')} <span className="text-destructive">*</span>
          </label>
          <input
            id="company-name"
            type="text"
            value={name}
            onChange={(e) => onNameChange(e.target.value)}
            placeholder={t('partnerCompany.placeholders.company')}
            className={inputClass}
          />
        </div>
      </section>

      {/* Address */}
      <section className="rounded-lg border bg-card p-6 shadow-xs">
        <div className="mb-6">
          <div className="flex items-center gap-2">
            <MapPin className="h-5 w-5 text-muted-foreground" />
            <h2 className="text-lg font-semibold">{t('partnerCompany.address')}</h2>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('partnerCompany.addressDescription')}
          </p>
        </div>
        <div className="grid gap-6 sm:grid-cols-2">
          <div className="space-y-2 sm:col-span-2">
            <label htmlFor="addr-street1" className="text-sm font-medium">{t('partnerCompany.street1')}</label>
            <input
              id="addr-street1"
              type="text"
              value={address.street1 || ''}
              onChange={(e) => setAddress('street1', e.target.value)}
              className={inputClass}
            />
          </div>
          <div className="space-y-2 sm:col-span-2">
            <label htmlFor="addr-street2" className="text-sm font-medium">{t('partnerCompany.street2')}</label>
            <input
              id="addr-street2"
              type="text"
              value={address.street2 || ''}
              onChange={(e) => setAddress('street2', e.target.value)}
              className={inputClass}
            />
          </div>
          <div className="space-y-2">
            <label htmlFor="addr-city" className="text-sm font-medium">{t('partnerCompany.city')}</label>
            <input
              id="addr-city"
              type="text"
              value={address.city || ''}
              onChange={(e) => setAddress('city', e.target.value)}
              className={inputClass}
            />
          </div>
          <div className="space-y-2">
            <label htmlFor="addr-region" className="text-sm font-medium">{t('partnerCompany.region')}</label>
            <input
              id="addr-region"
              type="text"
              value={address.region || ''}
              onChange={(e) => setAddress('region', e.target.value)}
              className={inputClass}
            />
          </div>
          <div className="space-y-2">
            <label htmlFor="addr-postal" className="text-sm font-medium">{t('partnerCompany.postalCode')}</label>
            <input
              id="addr-postal"
              type="text"
              value={address.postalCode || ''}
              onChange={(e) => setAddress('postalCode', e.target.value)}
              className={inputClass}
            />
          </div>
          <div className="space-y-2">
            <label htmlFor="addr-country" className="text-sm font-medium">{t('partnerCompany.country')}</label>
            <select
              id="addr-country"
              value={address.country || ''}
              onChange={(e) => setAddress('country', e.target.value)}
              className={inputClass}
            >
              {COUNTRY_CODES.map((code) => (
                <option key={code} value={code}>{t(/* i18n-dynamic */ `partnerCompany.countries.${code || 'select'}`)}</option>
              ))}
            </select>
          </div>
        </div>
      </section>

      {/* Contact */}
      <section className="rounded-lg border bg-card p-6 shadow-xs">
        <div className="mb-6">
          <div className="flex items-center gap-2">
            <User className="h-5 w-5 text-muted-foreground" />
            <h2 className="text-lg font-semibold">{t('partnerCompany.contact')}</h2>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">{t('partnerCompany.contactDescription')}</p>
        </div>
        <div className="grid gap-6 sm:grid-cols-2">
          <div className="space-y-2">
            <label htmlFor="contact-name" className="flex items-center gap-2 text-sm font-medium">
              <User className="h-4 w-4 text-muted-foreground" /> {t('partnerCompany.contactName')}
            </label>
            <input
              id="contact-name"
              type="text"
              value={contact.name || ''}
              onChange={(e) => setContact('name', e.target.value)}
              placeholder={t('partnerCompany.placeholders.contactName')}
              className={inputClass}
            />
          </div>
          <div className="space-y-2">
            <label htmlFor="contact-email" className="flex items-center gap-2 text-sm font-medium">
              <Mail className="h-4 w-4 text-muted-foreground" /> {t('partnerCompany.email')}
            </label>
            <input
              id="contact-email"
              type="email"
              value={contact.email || ''}
              onChange={(e) => setContact('email', e.target.value)}
              placeholder={t('partnerCompany.placeholders.email')}
              className={inputClass}
            />
          </div>
          <div className="space-y-2">
            <label htmlFor="contact-phone" className="flex items-center gap-2 text-sm font-medium">
              <Phone className="h-4 w-4 text-muted-foreground" /> {t('partnerCompany.phone')}
            </label>
            <input
              id="contact-phone"
              type="tel"
              value={contact.phone || ''}
              onChange={(e) => setContact('phone', e.target.value)}
              placeholder={t('partnerCompany.placeholders.phone')}
              className={inputClass}
            />
          </div>
          <div className="space-y-2">
            <label htmlFor="contact-website" className="flex items-center gap-2 text-sm font-medium">
              <Globe className="h-4 w-4 text-muted-foreground" /> {t('partnerCompany.website')}
            </label>
            <input
              id="contact-website"
              type="url"
              value={contact.website || ''}
              onChange={(e) => setContact('website', e.target.value)}
              placeholder={t('partnerCompany.placeholders.website')}
              className={inputClass}
            />
          </div>
        </div>
      </section>

      {/* Email signature */}
      <section className="rounded-lg border bg-card p-6 shadow-xs">
        <div className="mb-6">
          <div className="flex items-center gap-2">
            <Mail className="h-5 w-5 text-muted-foreground" />
            <h2 className="text-lg font-semibold">{t('partnerCompany.emailSignature')}</h2>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('partnerCompany.emailSignatureDescription')}
          </p>
        </div>
        <div className="space-y-2">
          <label htmlFor="email-signature" className="sr-only">{t('partnerCompany.emailSignature')}</label>
          <textarea
            id="email-signature"
            data-testid="partner-email-signature"
            value={emailSignature}
            onChange={(e) => onEmailSignatureChange(e.target.value)}
            rows={4}
            maxLength={MAX_EMAIL_SIGNATURE_LENGTH}
            placeholder={t('partnerCompany.placeholders.emailSignature')}
            className="w-full rounded-md border bg-background px-3 py-2 text-sm"
          />
        </div>
      </section>
    </div>
  );
}
