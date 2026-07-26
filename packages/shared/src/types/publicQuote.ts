export interface PublicQuoteHeader {
  id: string;
  quoteNumber: string | null;
  title: string | null;
  status: 'viewed' | 'accepted' | 'declined' | 'expired' | 'converted';
  currencyCode: string;
  issueDate: string | null;
  expiryDate: string | null;
  subtotal: string;
  taxRate: string | null;
  taxTotal: string;
  total: string;
  oneTimeTotal: string;
  monthlyRecurringTotal: string;
  annualRecurringTotal: string;
  depositType: 'none' | 'percent' | 'selected_lines';
  depositAmount: string | null;
  dueOnAcceptanceTotal: string;
  depositDueTotal: string | null;
  categoryBreakdown: Array<{
    category: string;
    oneTimeTotal: string;
    monthlyTotal: string;
    annualTotal: string;
  }>;
  billToName: string | null;
  introNotes: string | null;
  terms: string | null;
  sellerSnapshot: PublicQuoteSellerSnapshot | null;
  coverPage: PublicQuoteCoverPage | null;
  termsAndConditions: string | null;
}

export interface PublicQuoteSellerSnapshot {
  name: string | null;
  address: {
    line1: string | null;
    line2: string | null;
    city: string | null;
    region: string | null;
    postalCode: string | null;
    country: string | null;
  } | null;
  phone: string | null;
  email: string | null;
  website: string | null;
}

export interface PublicQuoteCoverPage {
  enabled: boolean;
  title: string | null;
  coverImageId: string | null;
  preparedForName: string | null;
  showPreparedBy: boolean;
}
