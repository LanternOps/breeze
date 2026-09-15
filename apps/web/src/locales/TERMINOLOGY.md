# Breeze translation terminology

Use this glossary when translating UI copy. Translate the meaning in the product
context, not the isolated English word. Brand names, protocol names, acronyms,
template variables (`{{name}}`), and code values remain unchanged.

| English concept | pt-BR | es-419 | fr-FR | fr-CA | de-DE | it-IT |
|---|---|---|---|---|---|---|
| network switch | switch | conmutador | commutateur | commutateur | Netzwerk-Switch | switch |
| virtual switch (Hyper-V) | switch virtual | conmutador virtual | commutateur virtuel | commutateur virtuel | virtueller Switch | switch virtuale |
| UI selector/switcher | seletor | selector | sélecteur | sélecteur | Umschalter/Auswahl | selettore |
| switch/change (verb) | alternar/mudar | cambiar | changer/passer | changer/passer | wechseln | cambiare/passare |
| endpoint (managed device) | endpoint | endpoint | terminal | terminal | Endpoint | endpoint |
| Microsoft Entra tenant | locatário do Entra | inquilino de Entra | tenant Entra | locataire Entra | Entra-Mandant | tenant Entra |
| ticket | chamado | ticket | ticket | billet | Ticket | ticket |
| patch (software update) | patch/correção | parche | correctif | correctif | Patch | patch |
| site (managed location) | local | sitio | site | site | Standort | sito |
| agent (Breeze software) | agente | agente | agent | agent | Agent | agente |
| scope (access/filter boundary) | escopo | alcance | périmètre | portée | Bereich | ambito |
| policy | política | política | politique | politique | Richtlinie | criterio |
| agreement template (legal doc attached to a quote) | modelo de acordo | plantilla de acuerdo | modèle de convention | modèle d'entente | Vereinbarungsvorlage | modello di accordo |
| signed agreement (frozen, customer-signed instance) | acordo assinado | acuerdo firmado | convention signée | entente signée | unterzeichnete Vereinbarung | accordo firmato |
| smoke test | teste de verificação | prueba de verificación | test de vérification | test de vérification | Smoke-Test | smoke test |

## Context rules

- `Switch` under device roles, discovered asset types, SNMP templates, or Hyper-V
  is networking equipment. Never translate it as an action or electrical switch.
- `switcher` in navigation is a selector, not networking equipment.
- `tenant` means an identity/cloud tenancy. Do not use words meaning renter,
  incoming, or resident unless that term is established Microsoft terminology in
  the locale.
- `grant` in OAuth means authorization or permission, never a financial grant.
- `apply` for settings means apply a change, never apply for a job.
- Preserve the catalog's established formality: `você`, `usted`, `vous`, `Sie`,
  and the existing Italian second-person voice.
- Billing, legal, privacy, and contractual language still requires native-speaker
  review before being treated as legally authoritative.
- `Agreement template` and `signed agreement` are the legal document library and its
  customer-signed instances. They are NOT the recurring billing `contract`, which keeps
  its own word in every locale (contrato / contrat / Vertrag / contratto / sözleşme).
  Never translate both concepts with the same noun — telling them apart is the whole
  point of the vocabulary split. tr-TR is not in the table above: use
  `anlaşma şablonu` and `imzalı anlaşma`, keeping `sözleşme` for the billing contract.
- `Invoice note` is the contract's free-text `terms` field, which is appended to the
  Notes block on generated invoices. Translate it as a note on an invoice, never as
  legal terms.
