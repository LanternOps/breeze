---
tracking_issue: LanternOps/breeze#5823
---
# Agreements W01: Vocabulary Copy Pass — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the UI calling three different objects "Contract". Rename the legal template to **Agreement template** and its frozen signed instance to **Signed agreement** everywhere the user reads them — eight locale catalogs, the quote editor, the contract detail page, the customer portal and the docs — without touching a single route, testid, nav entry, permission or API path.

**Architecture:** Wave 1 is copy-only. `apps/web/src/locales/<locale>/billing.json` is the single source for every web string; the components already read them through `useTranslation('billing')`, so most of the wave is JSON plus three component edits that render copy which has no render site yet: the quote editor's "no templates" sentence becomes a real `<Trans>` anchor into `/contracts#tab=templates`, the quote editor grows a one-line helper under Terms & Conditions, and `ContractDetail.tsx` finally renders `contract.terms` as an "Invoice note" row (today the field is written, billed on, and never displayed). The portal has no i18n, so its four literals are edited in place in `quoteBlocks.tsx`. Docs are prose-only edits that deliberately keep every existing `#contract-templates` anchor resolving.

**Tech Stack:** react-i18next (8 JSON catalogs + `<Trans>`), React islands under Astro, Vitest + Testing Library (`apps/web`, `apps/portal`), Astro Starlight MDX (`apps/docs`).

**Spec:** `docs/superpowers/specs/billing/2026-09-14-agreements-vocabulary-and-ia-design.md` (approved by Todd 2026-09-14). This wave is **§3 only**. §4 (permissions), §5 (API paths) and §6 (IA split) are W2/W3 and are explicitly out of scope; W2 and W3 both depend on the key names this wave lands.

## Global Constraints

Copied from spec §2 and §3:

- **Vocabulary is normative.** Billing contract = **Contract** (unchanged, never "agreement"). Legal template = **Agreement template** (never "contract template", never "contract"). Signed instance = **Signed agreement** (never "executed document", never bare "document"). Quote `termsAndConditions` = **Quote terms**, labelled "Terms & Conditions (plain text)" with a helper (never bare "Terms"). Contract `terms` = **Invoice note** (never "Terms").
- **Sentence-case UI labels** (repo convention). "Agreement templates", not "Agreement Templates".
- **DB tables, enums, Drizzle names, service names and Zod validator names are NOT renamed** (spec D5). Nothing under `apps/api/src/db/`, `apps/api/src/services/` or `packages/shared/src/validators/` changes in this wave.
- **Every locale key added or renamed needs a real translation in all 8 catalogs** (`en, de-DE, es-419, fr-CA, fr-FR, it-IT, pt-BR, tr-TR`). This is the wave's main trap: `localeParity.test.ts` only checks key parity, leaf types, interpolation tokens and rich-text tag multisets — **it does not notice that you changed an English value and left the other seven stale**. A stale translation therefore ships silently green unless you re-translate it by hand. `translationCoverage.test.ts` only catches the degenerate case where a translation is byte-identical to the new English. Treat every row of the §3 table as eight edits, not one.
- **Canonical translated terms for "agreement template" / "signed agreement" go into `apps/web/src/locales/TERMINOLOGY.md`** (Task 1 Step 4).
- **No route, testid, nav, permission or API change in W1.** Testids stay exactly as they are so `e2e-tests/tests/quote-contract-proposal.spec.ts` is untouched. Do not add new testids either — the two new render sites in Task 2 are asserted by role and text, not by testid.
- Route paths never live in a locale value (`localeParity.test.ts:331` `routePathValueErrors`, issue #3426). The `/contracts#tab=templates` href is a literal in the component; the JSON carries only `<link>…</link>`.
- Branch: `feature/5823-agreements/wave-01-copy`. One PR, body contains `Closes #5823`. Final task opens the PR and **stops** — do not merge.

---

## File structure

| Path | Responsibility |
|---|---|
| `apps/web/src/locales/en/billing.json` | normative English copy (spec §3) + 3 new keys |
| `apps/web/src/locales/{de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/billing.json` | real translations of every changed/new key |
| `apps/web/src/locales/TERMINOLOGY.md` | canonical glossary rows for the two new concepts |
| `apps/web/src/components/billing/quotes/QuoteEditor.tsx` | `<Trans>` link for `noTemplates`; helper under Terms & Conditions |
| `apps/web/src/components/billing/quotes/QuoteEditor.contractblock.test.tsx` | red-first tests for both |
| `apps/web/src/components/contracts/ContractDetail.tsx` | new "Invoice note" row rendering `contract.terms` |
| `apps/web/src/components/contracts/ContractDetail.documents.test.tsx` | red-first tests for the invoice-note row |
| `apps/web/src/components/contracts/ContractDocumentsSection.tsx` | subtitle under the Signed agreements title + stale source comment |
| `apps/portal/src/components/portal/quoteBlocks.tsx` | four portal literals |
| `apps/portal/src/components/portal/quoteBlocks.test.tsx` | the one assertion that pins a changed literal |
| `apps/portal/src/components/portal/QuoteDetailView.tsx` | one clarifying comment (labels stay — see Task 4) |
| `apps/docs/src/content/docs/features/contracts.mdx` | agreement-template wording, anchor preserved |
| `apps/docs/src/content/docs/features/quotes.mdx` | three link texts, URLs unchanged |

---

### Task 1: Locale copy — English, then seven real translations

**Files:**
- Modify: `apps/web/src/locales/en/billing.json`
- Modify: `apps/web/src/locales/de-DE/billing.json`, `es-419/billing.json`, `fr-CA/billing.json`, `fr-FR/billing.json`, `it-IT/billing.json`, `pt-BR/billing.json`, `tr-TR/billing.json`
- Modify: `apps/web/src/locales/TERMINOLOGY.md`

**Interfaces:**
- Produces three **new** keys consumed by Tasks 2 and 3: `quotes.editor.terms.helper`, `contracts.contractDetail.documents.subtitle`, `contracts.contractDetail.fields.invoiceNote`.
- Renames no key. Every other row below is a **value** change on an existing key, which is why parity cannot catch a stale locale.

**Verified anchor lines in `apps/web/src/locales/en/billing.json`** (origin/main `610baba63`): `contracts.contractDetail` opens at `:63`, its `fields` object at `:64` with `notes` at `:73`, its `documents` object at `:149` with `title` at `:150`; `contracts.contractEditor.content.termsOptional` at `:222`; `contracts.tabs.templates` at `:400` and `.documents` at `:401`; `contracts.templatesTab` at `:461`; `contracts.documentsTab` at `:509`; `contracts.templateEditor` at `:541`; `quotes.editor.blockTypes` at `:682`; `quotes.editor.terms` at `:923`; `quotes.editor.contract.noTemplates` at `:946`.

- [ ] **Step 1: Write the English values (normative — spec §3, verbatim)**

| Key | New English |
|---|---|
| `contracts.tabs.templates` | `Agreement templates` |
| `contracts.tabs.documents` | `Signed agreements` |
| `contracts.templatesTab.title` | `Agreement templates` |
| `contracts.templatesTab.description` | `Your MSA and standard terms. Add one to a quote and the customer signs it with the proposal; the signed copy is filed against the contract that quote creates.` |
| `contracts.templatesTab.newTemplate` | `New agreement template` |
| `contracts.templatesTab.loadError` | `Failed to load agreement templates` |
| `contracts.templatesTab.empty.title` | `No agreement templates yet` |
| `contracts.templatesTab.empty.description` | `Add your MSA or standard terms once, then drop it into any quote. Customers sign it when they accept.` |
| `contracts.templatesTab.createDialog.title` | `New agreement template` |
| `contracts.templatesTab.createDialog.partnerWide` | `Partner-wide template` |
| `contracts.templatesTab.createDialog.create` | `Create agreement template` |
| `contracts.templateEditor.bodyAria` | `Agreement template body` |
| `contracts.templateEditor.warnings.markupRemoved` | `Saved, but some unsupported formatting was removed: {{tags}}. Agreement bodies support headings, bold, italic, underline, lists and links.` |
| `contracts.documentsTab.title` | `Signed agreements` |
| `contracts.documentsTab.description` | `Signed agreements not yet linked to a contract. Link each one so it shows on the contract it governs.` |
| `contracts.documentsTab.empty.title` | `No unlinked signed agreements` |
| `contracts.documentsTab.empty.description` | `Signed agreements appear here until they're linked to a contract.` |
| `contracts.documentsTab.loadError` | `Could not load signed agreements.` |
| `contracts.documentsTab.linkSuccess` | `Signed agreement linked to contract.` |
| `contracts.documentsTab.linkError` | `Could not link the signed agreement to that contract.` |
| `contracts.contractDetail.documents.title` | `Signed agreements` |
| `contracts.contractDetail.documents.subtitle` **(new)** | `Accepted with the quote, pinned to the template version the customer saw.` |
| `contracts.contractDetail.documents.empty` | `No signed agreements yet.` |
| `contracts.contractDetail.documents.loadError` | `Could not load signed agreements.` |
| `contracts.contractDetail.fields.invoiceNote` **(new)** | `Invoice note` |
| `contracts.contractEditor.content.termsOptional` | `Invoice note (optional, added to the Notes block on generated invoices)` |
| `quotes.editor.blockTypes.contract` | `Agreement / terms` |
| `quotes.editor.errors.loadContractTemplates` | `Couldn't load agreement templates` |
| `quotes.editor.errors.addContractSection` | `Couldn't add the agreement section` |
| `quotes.editor.success.contractSectionAdded` | `Agreement section added` |
| `quotes.editor.contract.templateLabel` | `Agreement template` |
| `quotes.editor.contract.noTemplates` | `No agreement templates yet. <link>Create one</link> under Contracts → Agreement templates.` |
| `quotes.editor.contract.noPublishedVersion` | `This template has no published version yet. Publish it before adding it to a quote.` |
| `quotes.editor.contract.untitledTemplate` | `Agreement` |
| `quotes.editor.terms.title` | `Terms & Conditions (plain text)` |
| `quotes.editor.terms.helper` **(new)** | `For reusable legal terms, add an Agreement / terms section — the customer signs it with the proposal.` |
| `quotes.editor.terms.placeholder` | `Payment terms, delivery notes, etc.` |
| `contracts.contractEditor.content.notesOptional` | `Notes (optional, added to the Notes block on generated invoices)` |
| `quotes.document.contract.download` | `Download agreement` |
| `quotes.document.contract.previewTitle` | `{{name}} agreement` |

Three notes on that table, each of which will otherwise cost you a red run:

1. `quotes.editor.contract.labelPlaceholder` appears in spec §3 marked "unchanged". **Do not touch it.**
2. `noTemplates` carries `<link>…</link>` and nothing else. The route `/contracts#tab=templates` from the spec's parenthetical is **not** part of the value — it is the `href` in Task 2. `localeParity.test.ts:492` compares rich-text tag multisets across locales, so all eight catalogs must carry exactly one `open:link` and one `close:link`.
3. `markupRemoved` keeps its `{{tags}}` token and `previewTitle` its `{{name}}` token in every locale (`localeParity.test.ts:465`).

- [ ] **Step 2: Re-translate the same keys in the seven other catalogs**

Write real translations. Do not copy English, and do not leave the current value in place because "the key didn't change" — the current values all say *contract*, which is now the wrong word in seven languages as well as English.

Canonical noun phrases to conjugate from (these are the glossary rows Step 4 records):

| Concept | pt-BR | es-419 | fr-FR | fr-CA | de-DE | it-IT | tr-TR |
|---|---|---|---|---|---|---|---|
| agreement template | modelo de acordo | plantilla de acuerdo | modèle de convention | modèle d'entente | Vereinbarungsvorlage | modello di accordo | anlaşma şablonu |
| signed agreement | acordo assinado | acuerdo firmado | convention signée | entente signée | unterzeichnete Vereinbarung | accordo firmato | imzalı anlaşma |
| invoice note (contract `terms`) | observação na fatura | nota en la factura | note de facturation | note de facturation | Rechnungshinweis | nota in fattura | fatura notu |

The billing contract keeps its existing word in each catalog (`contrato` / `contrato` / `contrat` / `contrat` / `Vertrag` / `contratto` / `sözleşme`). The whole point of the wave is that *agreement* and *contract* must no longer collide, so never reuse the contract word for a template or a signed instance.

Canonical worked examples — de-DE and pt-BR, the two the spec calls out:

| Key | de-DE | pt-BR |
|---|---|---|
| `contracts.tabs.templates` | `Vereinbarungsvorlagen` | `Modelos de acordo` |
| `contracts.tabs.documents` | `Unterzeichnete Vereinbarungen` | `Acordos assinados` |
| `contracts.templatesTab.title` | `Vereinbarungsvorlagen` | `Modelos de acordo` |
| `contracts.templatesTab.newTemplate` | `Neue Vereinbarungsvorlage` | `Novo modelo de acordo` |
| `contracts.templatesTab.loadError` | `Vereinbarungsvorlagen konnten nicht geladen werden` | `Falha ao carregar os modelos de acordo` |
| `contracts.contractDetail.documents.title` | `Unterzeichnete Vereinbarungen` | `Acordos assinados` |
| `contracts.contractDetail.documents.empty` | `Noch keine unterzeichneten Vereinbarungen.` | `Ainda não há acordos assinados.` |
| `contracts.contractDetail.fields.invoiceNote` | `Rechnungshinweis` | `Observação na fatura` |
| `quotes.editor.contract.templateLabel` | `Vereinbarungsvorlage` | `Modelo de acordo` |
| `quotes.editor.contract.noTemplates` | `Noch keine Vereinbarungsvorlagen. <link>Erstellen Sie eine</link> unter Verträge → Vereinbarungsvorlagen.` | `Ainda não há modelos de acordo. <link>Crie um</link> em Contratos → Modelos de acordo.` |
| `quotes.document.contract.download` | `Vereinbarung herunterladen` | `Baixar acordo` |

Preserve each catalog's established formality (`Sie`, `você`, `usted`, `vous`) — `TERMINOLOGY.md` context rules and `terminologyQuality.test.ts:‹formal-register test›` both depend on it.

- [ ] **Step 3: Sanity-check parity mechanically before running the suite**

Run:
```bash
cd apps/web && node --input-type=module -e "
import { readFileSync } from 'node:fs';
const en = JSON.parse(readFileSync('src/locales/en/billing.json','utf8'));
const flat = (o,p='',out={}) => { for (const [k,v] of Object.entries(o)) { const q = p?p+'.'+k:k; v && typeof v==='object' ? flat(v,q,out) : out[q]=v; } return out; };
const E = flat(en);
for (const loc of ['de-DE','es-419','fr-CA','fr-FR','it-IT','pt-BR','tr-TR']) {
  const L = flat(JSON.parse(readFileSync('src/locales/'+loc+'/billing.json','utf8')));
  const same = Object.keys(E).filter(k => /agreement|Agreement/.test(String(E[k])) && L[k] === E[k]);
  const stale = Object.keys(E).filter(k => /agreement|Agreement/.test(String(E[k])) && /contract|Vertrag|contrato|contrat|contratto|sözleşme/i.test(String(L[k])));
  console.log(loc, 'english-copies:', same.length, 'still-say-contract:', stale.length, stale.slice(0,8).join(' '));
}"
```
Expected: `english-copies: 0` for every locale, and `still-say-contract: 0` except where the sentence genuinely also mentions the billing contract (`documentsTab.description`, `templatesTab.description`, `noTemplates`, `contractDetail.documents.subtitle` may legitimately contain the contract word — eyeball those and no others).

- [ ] **Step 4: Record the canonical terms in `apps/web/src/locales/TERMINOLOGY.md`**

Add two rows to the glossary table (it has six locale columns — pt-BR, es-419, fr-FR, fr-CA, de-DE, it-IT — tr-TR is not in the table), after the `policy` row at `:20`:

```markdown
| agreement template (legal doc attached to a quote) | modelo de acordo | plantilla de acuerdo | modèle de convention | modèle d'entente | Vereinbarungsvorlage | modello di accordo |
| signed agreement (frozen, customer-signed instance) | acordo assinado | acuerdo firmado | convention signée | entente signée | unterzeichnete Vereinbarung | accordo firmato |
```

And add two context rules to the `## Context rules` list:

```markdown
- `Agreement template` and `signed agreement` are the legal document library and its
  customer-signed instances. They are NOT the recurring billing `contract`, which keeps
  its own word in every locale (contrato / contrat / Vertrag / contratto / sözleşme).
  Never translate both concepts with the same noun — telling them apart is the whole
  point of the vocabulary split. tr-TR is not in the table above: use
  `anlaşma şablonu` and `imzalı anlaşma`, keeping `sözleşme` for the billing contract.
- `Invoice note` is the contract's free-text `terms` field, which is appended to the
  Notes block on generated invoices. Translate it as a note on an invoice, never as
  legal terms.
```

- [ ] **Step 5: Run the locale suites**

Run: `cd apps/web && npx vitest run src/lib/i18n`
Expected: PASS — `localeParity.test.ts`, `translationCoverage.test.ts` and `terminologyQuality.test.ts` all green, no baseline edited.

If `translationCoverage` reports `billing.json: N exact-English duplicates exceeds baseline M`, a translation was left as English — fix the translation, **never** raise the baseline (current billing.json baselines: pt-BR 60, es-419 46, fr-FR 59, fr-CA 59, de-DE 45, it-IT 37, tr-TR 22). If `localeParity` reports `rich-text tags differ`, a locale dropped `<link>`.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/locales
git commit -m "feat(billing): agreement vocabulary in eight locale catalogs (W01)"
```

---

### Task 2: Quote editor — real link in `noTemplates`, helper under Terms & Conditions

**Files:**
- Modify: `apps/web/src/components/billing/quotes/QuoteEditor.tsx` (import at `:2`, render sites at `:2345-2349` and `:3045-3049`)
- Modify: `apps/web/src/components/billing/quotes/QuoteEditor.contractblock.test.tsx`

**Interfaces:**
- Consumes `quotes.editor.contract.noTemplates` (now carrying `<link>`) and the new `quotes.editor.terms.helper` from Task 1.
- Adds **no** testid. `quote-block-contract-no-templates` and `quote-terms` keep their current meaning; the assertions below go through role and text so W1 leaves the testid surface untouched.

- [ ] **Step 1: Write the failing tests**

Append to `QuoteEditor.contractblock.test.tsx`. The file already mocks `listContractTemplates`/`getContractTemplate` (`:45-48`) and exposes `openContractForm()` (`:106`), and `src/__tests__/setup.ts:2` imports the real i18n instance, so English copy really renders.

```tsx
describe('QuoteEditor — agreement vocabulary (spec §3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listMock.mockResolvedValue(okRes([]));
    getMock.mockResolvedValue(okRes(templateDetail));
  });

  it('links "Create one" to the agreement template library when none exist', async () => {
    await openContractForm();
    const empty = await screen.findByTestId('quote-block-contract-no-templates');
    expect(empty).toHaveTextContent('No agreement templates yet.');
    const link = within(empty).getByRole('link', { name: 'Create one' });
    expect(link).toHaveAttribute('href', '/contracts#tab=templates');
  });

  it('tells the technician where legal terms belong, under the plain-text terms box', async () => {
    render(<QuoteEditor detail={detail} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());
    expect(screen.getByText('Terms & Conditions (plain text)')).toBeInTheDocument();
    expect(
      screen.getByText(/For reusable legal terms, add an Agreement \/ terms section/),
    ).toBeInTheDocument();
  });
});
```

Add `within` to the Testing Library import on line 1: `import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';`.

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/web && npx vitest run src/components/billing/quotes/QuoteEditor.contractblock.test.tsx`
Expected: FAIL — two failures. The first says no accessible `link` named "Create one" (the sentence renders as flat text because `<link>` is not markup to `t()`); the second says the helper text was not found. If the first test instead fails on `'No agreement templates yet.'` not matching, Task 1 did not land.

- [ ] **Step 3: Implement — the `<Trans>` anchor**

`QuoteEditor.tsx:2` currently reads `import { useTranslation } from 'react-i18next';`. Change it to:

```tsx
import { Trans, useTranslation } from 'react-i18next';
```

Replace the render site at `:2345-2349` (`t` is bound to the `billing` namespace by `useTranslation('billing')` at `:160`; passing `t={t}` is the house pattern — see `PartnerEventLogsTab.tsx:87`, `LoginBrandingCard.tsx:163`):

```tsx
                  {contractTemplatesLoaded && contractTemplates.length === 0 && (
                    <p className="mt-1 text-xs text-muted-foreground" data-testid="quote-block-contract-no-templates">
                      {/* The href is a literal, never a locale value: a translated
                          route breaks the feature in one language only, at runtime,
                          with no test or type error (#3426, localeParity's
                          routePathValueErrors). W3 retargets this to
                          /agreements/templates when the IA split lands. */}
                      <Trans
                        i18nKey="quotes.editor.contract.noTemplates"
                        t={t}
                        components={{
                          link: (
                            <a
                              href="/contracts#tab=templates"
                              className="font-medium underline hover:text-foreground"
                            />
                          ),
                        }}
                      />
                    </p>
                  )}
```

- [ ] **Step 4: Implement — the Terms & Conditions helper**

At `:3045-3049` the terms card opens with a header row (`<h2>{t('quotes.editor.terms.title')}</h2>` plus `<UnsavedBadge>`). Insert the helper immediately after that header `div` closes and before the `<textarea>`:

```tsx
            <p className="mb-2 text-xs text-muted-foreground">
              {t('quotes.editor.terms.helper')}
            </p>
```

- [ ] **Step 5: Run to verify pass**

Run: `cd apps/web && npx vitest run src/components/billing/quotes/QuoteEditor.contractblock.test.tsx src/components/billing/quotes/QuoteEditor.test.tsx src/components/billing/quotes/QuoteEditor.a11y.test.tsx src/components/billing/quotes/QuoteDocument.test.tsx`
Expected: PASS. Any failure in the neighbouring files is a snapshot of old copy — update the expectation to the §3 wording, never the copy.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/billing/quotes/QuoteEditor.tsx apps/web/src/components/billing/quotes/QuoteEditor.contractblock.test.tsx
git commit -m "feat(billing): quote editor links to the agreement template library and names quote terms (W01)"
```

---

### Task 3: Contract detail — invoice-note row and the signed-agreements subtitle

**Files:**
- Modify: `apps/web/src/components/contracts/ContractDetail.tsx` (notes block at `:372-377`)
- Modify: `apps/web/src/components/contracts/ContractDetail.documents.test.tsx`
- Modify: `apps/web/src/components/contracts/ContractDocumentsSection.tsx` (doc comment at `:34-40`, header at `:70-73`)

**Interfaces:**
- Consumes `contracts.contractDetail.fields.invoiceNote` and `contracts.contractDetail.documents.subtitle` from Task 1.
- `contract.terms` is already on the wire: `apps/web/src/lib/api/contracts.ts:64` types it `string | null`, and every `ContractDetail.*.test.tsx` fixture already sets `terms: null`. This is a pure render gap — the field is written by `contractService.ts` and concatenated into generated invoice notes (`:1899-1906`), and `ContractDetail.tsx` has never shown it.

- [ ] **Step 1: Write the failing tests**

Append to `ContractDetail.documents.test.tsx` (it already carries the auth mock, the `contracts` / `contractDocuments` API mocks and the `activeDetail` fixture at `:45-56`):

```tsx
describe('ContractDetail — invoice note (spec §3)', () => {
  it('renders the contract terms as an Invoice note row next to Notes', async () => {
    const detail: ContractDetailData = {
      ...activeDetail,
      contract: { ...activeDetail.contract, notes: 'Renewal call booked', terms: 'Net 30. Late fees apply after 15 days.' },
    };
    render(<ContractDetail detail={detail} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('contract-documents-section')).toBeInTheDocument());
    expect(screen.getByText('Invoice note')).toBeInTheDocument();
    expect(screen.getByText('Net 30. Late fees apply after 15 days.')).toBeInTheDocument();
    // The billing contract's own Notes row is unaffected.
    expect(screen.getByText('Notes')).toBeInTheDocument();
    expect(screen.getByText('Renewal call booked')).toBeInTheDocument();
  });

  it('omits the Invoice note row when the contract has no terms', async () => {
    render(<ContractDetail detail={activeDetail} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('contract-documents-section')).toBeInTheDocument());
    expect(screen.queryByText('Invoice note')).toBeNull();
  });

  it('titles the panel Signed agreements and explains what they are', async () => {
    render(<ContractDetail detail={activeDetail} onChanged={vi.fn()} />);
    const section = await screen.findByTestId('contract-documents-section');
    expect(section).toHaveTextContent('Signed agreements');
    expect(section).toHaveTextContent('Accepted with the quote, pinned to the template version the customer saw.');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/web && npx vitest run src/components/contracts/ContractDetail.documents.test.tsx`
Expected: FAIL — test 1 cannot find `Invoice note`; test 3 cannot find the subtitle sentence. Test 2 passes vacuously today; it is the guard that the new row is conditional.

- [ ] **Step 3: Implement the invoice-note row**

`ContractDetail.tsx:372-377` currently ends the left column with the notes block. Add the sibling immediately after it, mirroring its markup exactly (both sit outside the `<dl>` above, which is existing structure — do not restructure):

```tsx
            {contract.terms && (
              <div className="mt-4 border-t pt-3">
                {/* contract.terms is the free-text note appended to the Notes block
                    on generated invoices (contractService.ts:1899). It is NOT the
                    legal agreement — that is a signed agreement, listed below. */}
                <dt className="text-xs uppercase text-muted-foreground">{t('contracts.contractDetail.fields.invoiceNote')}</dt>
                <dd className="mt-1 whitespace-pre-wrap text-sm">{contract.terms}</dd>
              </div>
            )}
```

- [ ] **Step 4: Implement the subtitle and fix the stale source comment**

In `ContractDocumentsSection.tsx`, replace the doc comment at `:34-40` — the spec calls this comment out by name as the only place in the product where the object relationship was written down:

```tsx
/**
 * Signed agreements for one contract: the frozen instances created at
 * quote-acceptance time, each pinned to the agreement template version and the
 * variable values the signer actually saw. Read-only — linking an unlinked
 * signed agreement to a contract happens from the Signed agreements tab on the
 * contracts landing page, not here.
 */
```

Then replace the bare `<h3>` header at `:70-73` with a title + subtitle block:

```tsx
      <div className="border-b px-3 py-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t('contracts.contractDetail.documents.title')}
        </h3>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {t('contracts.contractDetail.documents.subtitle')}
        </p>
      </div>
```

(The `border-b` moves from the `<h3>` to the wrapper so the rule still sits under the whole header.)

- [ ] **Step 5: Run to verify pass**

Run: `cd apps/web && npx vitest run src/components/contracts`
Expected: PASS across all thirteen `ContractDetail.*` files plus the template/documents tab suites. Suites that assert the old "Executed documents" wording (`TemplatesTab.test.tsx`, `DocumentsTab.test.tsx`, `TemplateEditor.test.tsx`) must be updated to the §3 wording — copy, not testids.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/contracts
git commit -m "feat(billing): show the contract invoice note and name signed agreements on contract detail (W01)"
```

---

### Task 4: Portal literals

**Files:**
- Modify: `apps/portal/src/components/portal/quoteBlocks.tsx` (`:282`, `:297`, `:303`, `:307`)
- Modify: `apps/portal/src/components/portal/quoteBlocks.test.tsx` (`:93`)
- Modify: `apps/portal/src/components/portal/QuoteDetailView.tsx` (`:334-336`, comment only)

**Interfaces:** the portal has no i18n catalog. Every string here is an inline literal; there is nothing to translate.

**Verified test surface:** `grep -rn "Download contract" apps/portal/src` matches **only** `quoteBlocks.tsx:303` — no test pins that text; `quoteBlocks.test.tsx:77-78` asserts the download link by testid and href, which do not change. One test **does** pin a changed literal: `quoteBlocks.test.tsx:93` asserts `'Contract file unavailable'`. That is the single test edit in this task.

- [ ] **Step 1: Write the failing assertion**

In `quoteBlocks.test.tsx`, change `:93` from

```tsx
    expect(el.textContent).toContain('Contract file unavailable');
```

to

```tsx
    expect(el.textContent).toContain('Agreement file unavailable');
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/portal && npx vitest run src/components/portal/quoteBlocks.test.tsx`
Expected: FAIL — one test, `shows an unavailable fallback for an uploaded block with no fileUrl`.

- [ ] **Step 3: Implement the four literals**

`:282` — the fallback display name. Spec §3: "Contract" → block label if present else "Agreement". `label` is already in scope from `:281`:

```tsx
      const templateName = typeof c.templateName === 'string' ? c.templateName : (label || 'Agreement');
```

`:297` → `Agreement content unavailable`
`:303` → `Download agreement`
`:307` → `Agreement file unavailable`

- [ ] **Step 4: Decide the `QuoteDetailView.tsx:334-336` labels (spec §3 conditional)**

Spec §3 says label the first block "Notes" *if* `quote.terms` is the notes field, and leave both labels alone if both are genuinely terms. **Verified: both are genuinely terms — leave the labels unchanged.** Evidence: `quotes.terms` and `quotes.terms_and_conditions` are two separate `text` columns (`apps/api/src/db/schema/quotes.ts:71,81`), both accepted as free text by the quote validators (`packages/shared/src/validators/quotes.ts:352-353,390-391`) and both merely copied on revise (`quoteService.ts:655,666`). The quote's *notes* field is `intro_notes` (`schema/quotes.ts:70`), which is a third, distinct column. The web editor's "Terms & Conditions" box writes `termsAndConditions` only (`QuoteEditor.tsx:328,524`), and nothing in `apps/web` writes `terms` — it is an API-only legacy field. Relabelling it "Notes" would therefore be wrong twice over.

Record the finding in the source so the next reader does not re-litigate it. Above `:334`:

```tsx
        {/* Two distinct free-text columns, both genuinely terms: `terms` is the
            API-only legacy field, `termsAndConditions` is what the quote editor
            writes. The quote's notes live in `introNotes`, elsewhere on the page.
            Spec 2026-09-14 §3 checked this and left both labels as-is. */}
```

- [ ] **Step 5: Run to verify pass**

Run: `cd apps/portal && npx vitest run src/components/portal/quoteBlocks.test.tsx src/components/portal/PublicQuoteView.test.tsx src/components/portal/QuoteViews.zeroRecurring.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/portal/src/components/portal
git commit -m "feat(portal): call the signed legal document an agreement on proposals (W01)"
```

---

### Task 5: Docs wording

**Files:**
- Modify: `apps/docs/src/content/docs/features/contracts.mdx` (`:185`, `:187`, `:189`, `:194`, `:204`, `:217`, `:224`)
- Modify: `apps/docs/src/content/docs/features/quotes.mdx` (`:196`, `:206`, `:252`)

**Heading-anchor decision — verified, do not re-derive.** Spec §3 asks for `## Agreement Templates {#contract-templates}`. **Astro/Starlight in this repo does not support explicit heading ids.** `apps/docs/astro.config.mjs` has no `markdown` key at all — no `remark-heading-id`, no `rehype-slug` override — and `grep -rn "{#" apps/docs/src/content/docs` returns zero hits, so the syntax is used nowhere and would render as literal text `{#contract-templates}` in the heading. The heading text therefore **stays `## Contract Templates`** so its generated slug keeps `quotes.mdx:196`, `:206` and `:252` resolving, and a note carries the vocabulary. W3 moves this whole section to `features/agreements.mdx` and retargets the links, which is where the anchor change belongs.

Note also the spec's line range `:153-182` is stale on `610baba63`: the section actually spans `:185-213` (a "Service deliverables" section now occupies `:153-183`). Line numbers below are the verified ones.

- [ ] **Step 1: `contracts.mdx` — keep the heading, add the note, fix the prose**

`:185` unchanged: `## Contract Templates`

Replace `:187` with:

```mdx
Separate from the recurring-billing contracts above, Breeze keeps a library of **agreement templates** -- the legal-document text (or an uploaded PDF) you attach to a quote for the customer to review and effectively sign as part of accepting a proposal. Open **Contracts → Agreement templates** to manage the library.

<Aside type="note" title="Agreement templates, not contracts">
  The product calls these **agreement templates**, and the customer-signed copies **signed agreements**, to keep them distinct from the recurring billing contracts described above. The heading and link anchor on this page still read "Contract Templates" so existing links keep resolving; a dedicated Agreements page follows.
</Aside>
```

(`Aside` is already imported by this file — it is used at `:181`.)

Replace `:189`: `An agreement template is owned either by your whole partner (usable on any customer's quotes) or by a single organization, chosen when you create it.`

Replace `:194`: `1. Go to **Contracts → Agreement templates** and click **New agreement template**.`

Replace `:204`: `**Archive** a template to stop it from being used on new quotes. Archiving doesn't touch versions already attached to existing quotes or the signed agreements generated from them.`

In `:217`, replace `The same permissions gate the contract template library and service deliverables.` with `The same permissions gate the agreement template library and service deliverables.` (the permission *resource* does not change until W2 — this is wording only).

Replace `:224`: `- [Quotes → Contract blocks](/features/quotes/#contract-blocks) -- attach an agreement template to a quote` (the `#contract-blocks` anchor stays: `quotes.mdx`'s `### Contract blocks` heading is not renamed in W1).

- [ ] **Step 2: `quotes.mdx` — link text only, every URL unchanged**

`:196` → `| **Contract** | Attaching a template from your [agreement template library](/features/contracts/#contract-templates) for the customer to review as part of the proposal |`
`:206` → `A **Contract** block attaches a document from your [agreement template library](/features/contracts/#contract-templates) to a quote, so the customer reviews (and, by accepting the quote, effectively agrees to) that document alongside the priced lines.`
`:252` → `- [Recurring Contracts → Agreement Templates](/features/contracts/#contract-templates) -- manage the document library contract blocks attach`

Leave the `### Contract blocks` heading and the quote-editor block-type name "Contract" in `quotes.mdx` alone: the editor's block-type label becomes "Agreement / terms" in Task 1, but the `#contract-blocks` anchor is referenced from `contracts.mdx:202` and `:224`, and retargeting anchors is W3 work.

- [ ] **Step 3: Verify the docs build and that no anchor broke**

Run: `pnpm --filter @breeze/docs check && pnpm --filter @breeze/docs build`
Expected: both PASS (this is exactly what CI's `docs-check` job runs — `.github/workflows/ci.yml:126,129`).

Then confirm the anchor survives:
```bash
grep -rn "features/contracts/#contract-templates" apps/docs/src/content/docs
grep -n "^## Contract Templates" apps/docs/src/content/docs/features/contracts.mdx
```
Expected: three link hits (quotes.mdx `:196,:206,:252`), and the heading still present so the slug still generates.

- [ ] **Step 4: Commit**

```bash
git add apps/docs/src/content/docs/features/contracts.mdx apps/docs/src/content/docs/features/quotes.mdx
git commit -m "docs(billing): agreement template wording, anchors preserved (W01)"
```

---

### Task 6: Wave verification, commit and PR

- [ ] **Step 1: Typecheck the web app**

Run: `cd apps/web && pnpm exec astro check`
Expected: 0 errors. **There is no `typecheck` script in `apps/web/package.json`** — `astro check` is what CI runs for this app (`.github/workflows/ci.yml:256-257`); `pnpm --filter @breeze/web exec tsc --noEmit` is not a configured path here and will not typecheck `.astro` files.

- [ ] **Step 2: Run every test file this wave touched**

```bash
cd apps/web && npx vitest run \
  src/lib/i18n \
  src/components/billing/quotes \
  src/components/contracts
cd ../portal && npx vitest run src/components/portal
```
Expected: all green. Nothing under `apps/api` or `packages/shared` was touched, so those suites do not need a run — but if you touched anything there, you left the wave's scope and should back it out.

- [ ] **Step 3: Confirm the wave stayed inside its blast radius**

```bash
git diff --stat origin/main
```
Expected: changes only under `apps/web/src/locales/`, `apps/web/src/components/billing/quotes/`, `apps/web/src/components/contracts/`, `apps/portal/src/components/portal/` and `apps/docs/src/content/docs/features/`. **Zero** changes under `apps/api/`, `packages/shared/`, `e2e-tests/`, and zero lines matching `data-testid` added or removed:
```bash
git diff origin/main -- apps/web apps/portal | grep -c '^[+-].*data-testid'
```
Expected: `0`. A non-zero count means W1 touched the testid surface — the spec forbids it and `quote-contract-proposal.spec.ts` would break.

- [ ] **Step 4: Lint**

Run: `cd apps/web && pnpm lint`
Expected: clean.

- [ ] **Step 5: Push and open the PR — then STOP**

```bash
git push -u origin feature/5823-agreements/wave-01-copy
gh pr create --base main --title "feat(billing): agreements vocabulary — copy pass (W01)" --body "$(cat <<'BODY'
## What

Wave 1 of the agreements vocabulary and IA split: **copy only**. The legal
document library is now **Agreement templates**, its customer-signed instances
are **Signed agreements**, the quote's free-text block is **Quote terms**, and
the contract's `terms` field is the **Invoice note** it has always actually been.

- §3 copy across all 8 locale catalogs (`apps/web/src/locales/*/billing.json`),
  with real translations — not English copies — in the seven non-English ones,
  and the two new concepts recorded in `TERMINOLOGY.md`.
- Quote editor: "No agreement templates yet. **Create one**…" is now a real
  anchor to the template library, and a helper under Terms & Conditions points
  legal text at an Agreement / terms section.
- Contract detail: `contract.terms` is finally rendered, as an **Invoice note**
  row next to Notes. It was written, billed on, and never shown.
- Signed agreements panel gains a one-line explanation of what it contains.
- Portal proposal blocks say "agreement" instead of "contract".
- Docs wording updated; the `#contract-templates` anchor is deliberately
  preserved (Astro here has no explicit-heading-id support, and W3 moves the
  page anyway).

## What this PR deliberately does NOT do

No route, testid, nav, permission or API change — spec §3 is the whole scope.
`e2e-tests/tests/quote-contract-proposal.spec.ts` is untouched by design.
Permissions (§4) and API paths (§5) are W2; the IA split (§6) is W3, and both
depend on the key names landed here.

## Spec

`docs/superpowers/specs/billing/2026-09-14-agreements-vocabulary-and-ia-design.md` §2, §3, §7.

## Verification

- `cd apps/web && npx vitest run src/lib/i18n src/components/billing/quotes src/components/contracts`
- `cd apps/portal && npx vitest run src/components/portal`
- `cd apps/web && pnpm exec astro check`
- `pnpm --filter @breeze/docs check && pnpm --filter @breeze/docs build`
- `git diff origin/main -- apps/web apps/portal | grep -c '^[+-].*data-testid'` → 0

Closes #5823
BODY
)"
```

**This is the final task. Open the PR and stop.** Do not merge, do not enqueue, do not run `gh pr merge`. Hand the PR number back and wait.

---

## Self-review

**Spec §3 row → task mapping.** Every row of the §3 copy table is Task 1 (the eight catalogs); the rows that also need a render change are listed against their second task:

| §3 row | Task |
|---|---|
| `contracts.tabs.templates`, `contracts.tabs.documents` | T1 |
| `contracts.templatesTab.*` (title, description, newTemplate, loadError, empty.title, empty.description, createDialog.title, createDialog.partnerWide, createDialog.create) | T1 |
| `contracts.templateEditor.bodyAria`, `.warnings.markupRemoved` | T1 |
| `contracts.documentsTab.*` (title, description, empty.title, empty.description, loadError, linkSuccess, linkError) | T1 |
| `contracts.contractDetail.documents.title`, `.empty`, `.loadError` | T1 |
| `contracts.contractDetail.documents.subtitle` (new) | T1 (key) + **T3** (render under the panel title) |
| `contracts.contractDetail.fields.invoiceNote` (new) | T1 (key) + **T3** (new row rendering `contract.terms`) |
| `contracts.contractEditor.content.termsOptional` | T1 |
| `quotes.editor.blockTypes.contract` | T1 |
| `quotes.editor.errors.loadContractTemplates`, `.addContractSection`, `quotes.editor.success.contractSectionAdded` | T1 |
| `quotes.editor.contract.templateLabel`, `.noPublishedVersion`, `.untitledTemplate` | T1 |
| `quotes.editor.contract.noTemplates` | T1 (value + `<link>` in 8 catalogs) + **T2** (`<Trans>` with the real href) |
| `quotes.editor.contract.labelPlaceholder` — "unchanged" | none, by design |
| `quotes.editor.terms.title` | T1 |
| `quotes.editor.terms.helper` (new) | T1 (key) + **T2** (paragraph under the terms title) |
| `quotes.document.contract.download`, `.previewTitle` | T1 |
| §3 "Contract detail renders the invoice note" | **T3** |
| §3 Portal — `quoteBlocks.tsx:282,297,303,307` | **T4** |
| §3 Portal — `QuoteDetailView.tsx:334-336` | **T4 Step 4** — verified both fields are genuinely terms, labels stay, finding recorded in source |
| §3 Docs — `contracts.mdx`, `quotes.mdx` | **T5** |
| §3 "Not in Wave 1: route/testid/nav/permission/API" | **T6 Step 3** asserts it mechanically |
| §2 "real translations ×8" | **T1 Steps 2-3** + T1 Step 5 |
| §2 TERMINOLOGY.md | **T1 Step 4** |

**The parity gap this plan exists to close.** `localeParity.test.ts` compares key sets, leaf types, interpolation tokens and rich-text tag multisets — never values. Renaming an English value while leaving `de-DE` saying *Vertragsvorlage* is therefore invisible to it, and `translationCoverage.test.ts` only fires if a translation is byte-identical to English. Task 1 Step 2 makes re-translation an explicit deliverable, and Step 3 adds a mechanical grep for the specific failure mode (a non-English catalog still using the contract word where English now says agreement) that neither suite can see.

**No placeholders.** `5823` is the one intentional token, as requested, in the branch name, the frontmatter and the PR body. Every line number cited was read on `610baba63`; two spec citations were corrected against the file (`contracts.mdx` §3 section is `:185-213`, not `:153-182`; `ContractDetail.tsx` notes block is `:372-377`, not `~:371`). Two spec instructions were resolved by verification rather than guessed: the Starlight explicit-heading-id syntax is **unsupported here** (T5, heading text kept), and the portal's two terms blocks are **both genuinely terms** (T4 Step 4, labels kept).
