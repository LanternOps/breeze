import { Building2, MapPin, User, Mail, Phone, Globe } from 'lucide-react';
import type { PartnerSettings } from '@breeze/shared';

type Address = NonNullable<PartnerSettings['address']>;
type Contact = NonNullable<PartnerSettings['contact']>;

type Props = {
  name: string;
  address: Address;
  contact: Contact;
  onNameChange: (value: string) => void;
  onAddressChange: (value: Address) => void;
  onContactChange: (value: Contact) => void;
};

const COUNTRIES: { code: string; label: string }[] = [
  { code: '', label: '— Select country —' },
  { code: 'US', label: 'United States' },
  { code: 'CA', label: 'Canada' },
  { code: 'MX', label: 'Mexico' },
  { code: 'GB', label: 'United Kingdom' },
  { code: 'IE', label: 'Ireland' },
  { code: 'FR', label: 'France' },
  { code: 'DE', label: 'Germany' },
  { code: 'ES', label: 'Spain' },
  { code: 'IT', label: 'Italy' },
  { code: 'NL', label: 'Netherlands' },
  { code: 'BE', label: 'Belgium' },
  { code: 'CH', label: 'Switzerland' },
  { code: 'AT', label: 'Austria' },
  { code: 'SE', label: 'Sweden' },
  { code: 'NO', label: 'Norway' },
  { code: 'DK', label: 'Denmark' },
  { code: 'FI', label: 'Finland' },
  { code: 'PL', label: 'Poland' },
  { code: 'PT', label: 'Portugal' },
  { code: 'CZ', label: 'Czech Republic' },
  { code: 'GR', label: 'Greece' },
  { code: 'AU', label: 'Australia' },
  { code: 'NZ', label: 'New Zealand' },
  { code: 'JP', label: 'Japan' },
  { code: 'KR', label: 'South Korea' },
  { code: 'CN', label: 'China' },
  { code: 'HK', label: 'Hong Kong' },
  { code: 'SG', label: 'Singapore' },
  { code: 'IN', label: 'India' },
  { code: 'AE', label: 'United Arab Emirates' },
  { code: 'IL', label: 'Israel' },
  { code: 'ZA', label: 'South Africa' },
  { code: 'BR', label: 'Brazil' },
  { code: 'AR', label: 'Argentina' },
  { code: 'CL', label: 'Chile' },
  { code: 'CO', label: 'Colombia' },
];

const inputClass = 'h-10 w-full rounded-md border bg-background px-3 text-sm';

export default function PartnerCompanyTab({
  name,
  address,
  contact,
  onNameChange,
  onAddressChange,
  onContactChange,
}: Props) {
  const setAddress = (field: keyof Address, value: string) => {
    onAddressChange({ ...address, [field]: value });
  };
  const setContact = (field: keyof Contact, value: string) => {
    onContactChange({ ...contact, [field]: value });
  };

  return (
    <div className="space-y-6">
      {/* Company */}
      <section className="rounded-lg border bg-card p-6 shadow-sm">
        <div className="mb-6 flex items-center gap-2">
          <Building2 className="h-5 w-5 text-muted-foreground" />
          <h2 className="text-lg font-semibold">Company</h2>
        </div>
        <div className="space-y-2">
          <label htmlFor="company-name" className="text-sm font-medium">
            Company Name <span className="text-destructive">*</span>
          </label>
          <input
            id="company-name"
            type="text"
            value={name}
            onChange={(e) => onNameChange(e.target.value)}
            placeholder="Acme MSP"
            className={inputClass}
          />
        </div>
      </section>

      {/* Address */}
      <section className="rounded-lg border bg-card p-6 shadow-sm">
        <div className="mb-6">
          <div className="flex items-center gap-2">
            <MapPin className="h-5 w-5 text-muted-foreground" />
            <h2 className="text-lg font-semibold">Address</h2>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Used for branded PDFs, invoices, and email footers.
          </p>
        </div>
        <div className="grid gap-6 sm:grid-cols-2">
          <div className="space-y-2 sm:col-span-2">
            <label htmlFor="addr-street1" className="text-sm font-medium">Street 1</label>
            <input
              id="addr-street1"
              type="text"
              value={address.street1 || ''}
              onChange={(e) => setAddress('street1', e.target.value)}
              className={inputClass}
            />
          </div>
          <div className="space-y-2 sm:col-span-2">
            <label htmlFor="addr-street2" className="text-sm font-medium">Street 2</label>
            <input
              id="addr-street2"
              type="text"
              value={address.street2 || ''}
              onChange={(e) => setAddress('street2', e.target.value)}
              className={inputClass}
            />
          </div>
          <div className="space-y-2">
            <label htmlFor="addr-city" className="text-sm font-medium">City</label>
            <input
              id="addr-city"
              type="text"
              value={address.city || ''}
              onChange={(e) => setAddress('city', e.target.value)}
              className={inputClass}
            />
          </div>
          <div className="space-y-2">
            <label htmlFor="addr-region" className="text-sm font-medium">State / Region</label>
            <input
              id="addr-region"
              type="text"
              value={address.region || ''}
              onChange={(e) => setAddress('region', e.target.value)}
              className={inputClass}
            />
          </div>
          <div className="space-y-2">
            <label htmlFor="addr-postal" className="text-sm font-medium">Postal Code</label>
            <input
              id="addr-postal"
              type="text"
              value={address.postalCode || ''}
              onChange={(e) => setAddress('postalCode', e.target.value)}
              className={inputClass}
            />
          </div>
          <div className="space-y-2">
            <label htmlFor="addr-country" className="text-sm font-medium">Country</label>
            <select
              id="addr-country"
              value={address.country || ''}
              onChange={(e) => setAddress('country', e.target.value)}
              className={inputClass}
            >
              {COUNTRIES.map((c) => (
                <option key={c.code} value={c.code}>{c.label}</option>
              ))}
            </select>
          </div>
        </div>
      </section>

      {/* Contact */}
      <section className="rounded-lg border bg-card p-6 shadow-sm">
        <div className="mb-6">
          <div className="flex items-center gap-2">
            <User className="h-5 w-5 text-muted-foreground" />
            <h2 className="text-lg font-semibold">Contact</h2>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">Primary contact for your MSP.</p>
        </div>
        <div className="grid gap-6 sm:grid-cols-2">
          <div className="space-y-2">
            <label htmlFor="contact-name" className="flex items-center gap-2 text-sm font-medium">
              <User className="h-4 w-4 text-muted-foreground" /> Contact Name
            </label>
            <input
              id="contact-name"
              type="text"
              value={contact.name || ''}
              onChange={(e) => setContact('name', e.target.value)}
              placeholder="John Smith"
              className={inputClass}
            />
          </div>
          <div className="space-y-2">
            <label htmlFor="contact-email" className="flex items-center gap-2 text-sm font-medium">
              <Mail className="h-4 w-4 text-muted-foreground" /> Email
            </label>
            <input
              id="contact-email"
              type="email"
              value={contact.email || ''}
              onChange={(e) => setContact('email', e.target.value)}
              placeholder="contact@example.com"
              className={inputClass}
            />
          </div>
          <div className="space-y-2">
            <label htmlFor="contact-phone" className="flex items-center gap-2 text-sm font-medium">
              <Phone className="h-4 w-4 text-muted-foreground" /> Phone
            </label>
            <input
              id="contact-phone"
              type="tel"
              value={contact.phone || ''}
              onChange={(e) => setContact('phone', e.target.value)}
              placeholder="+1 (555) 123-4567"
              className={inputClass}
            />
          </div>
          <div className="space-y-2">
            <label htmlFor="contact-website" className="flex items-center gap-2 text-sm font-medium">
              <Globe className="h-4 w-4 text-muted-foreground" /> Website
            </label>
            <input
              id="contact-website"
              type="url"
              value={contact.website || ''}
              onChange={(e) => setContact('website', e.target.value)}
              placeholder="https://example.com"
              className={inputClass}
            />
          </div>
        </div>
      </section>
    </div>
  );
}
