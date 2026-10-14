---
title: Customer Portal Environment Visibility — controlled, customer-safe infrastructure views
issue: LanternOps/breeze discussion #8775
status: draft (direction accepted in discussion #8775; Portuguese working draft for review)
depends_on:
  - LanternOps/breeze discussion #5438
  - LanternOps/breeze discussion #7450
  - LanternOps/breeze#5861
  - docs/superpowers/specs/portal/2026-10-01-portal-advanced-visibility-design.md
  - docs/superpowers/specs/monitoring/2026-10-07-physical-placement-circuits-design.md
  - docs/superpowers/specs/monitoring/2026-10-03-topology-site-location-design.md
---

# Customer Portal Environment Visibility (CPEV)

## 1. Status e origem

Esta specification consolida a direção aceita na Discussion #8775 como continuação, e não substituição, das decisões já estabelecidas em #5438 e #7450.

**Confirmado pelo mantenedor — #8775:**

- uma opção explícita por família de dados, por organização e desligada por padrão;
- topology e observed location exigem opt-in próprio e ficam fora de qualquer comportamento de "Enable all";
- cada wave deve possuir uma allowlist explícita de campos;
- nenhum passthrough de registros internos e nenhum blob `jsonb`;
- nenhum credential, management IP ou internal hostname, salvo campo explicitamente listado e justificado;
- CPEV-W1 deve se limitar a dados já existentes, já descobertos/registrados e já org-scoped.

**Confirmado pelo mantenedor — #5438:** Network Visibility é read-only, org-scoped, fail-closed, usa contrato discriminado para `ok` / `no_data` / `not_enabled`, não fabrica zero quando a informação não existe e não expõe SNMP raw, credenciais, monitor configuration ou `jsonb` interno.

**Confirmado pelo mantenedor — #7450 / PR #7642:** o Portal segue o padrão de uma flag por família, com famílias de maior sensibilidade deliberadamente fora de "Enable all"; o contrato público deve selecionar colunas explicitamente e testes devem provar que campos excluídos não escapam.

Esta specification define o contrato de visibilidade e a divisão das waves. Ela não autoriza implementação automática das sete waves. Cada wave continua pequena, revisável e implementada separadamente.

## 2. Problema

Breeze já mantém ou está consolidando uma visão estruturada do ambiente do cliente: descoberta de ativos, reachability, monitoramento, placement físico, topology, presence/location e circuitos. Esses modelos foram construídos prioritariamente para o operador MSP e contêm dados que não devem atravessar a fronteira do Customer Portal.

O problema não é falta de dados. É falta de uma camada explícita de projeção customer-safe que permita ao MSP escolher, por organização, quais partes do ambiente o cliente pode visualizar.

O Portal deve responder:

> O que está acontecendo no meu ambiente?

Ele não deve responder:

> Como meu MSP descobriu, inferiu, configurou ou está diagnosticando esse ambiente?

## 3. Objetivos

CPEV deve:

1. expor apenas projeções read-only e customer-safe;
2. reutilizar dados e classificações canônicas existentes, sem criar algoritmos paralelos no Portal;
3. derivar a organização exclusivamente da autenticação do Portal;
4. manter toda capacidade desligada por padrão quando depender de nova flag;
5. permitir controle por organização e por família de dados;
6. definir allowlists fechadas, campo por campo, antes da implementação de cada wave;
7. preservar os estados `no_data` / `not_enabled` quando ausência e desabilitação forem semanticamente diferentes de zero;
8. impedir vazamento de credenciais, configuração operacional, evidência bruta, payloads livres e metadados de inferência;
9. reutilizar os serviços/read models canônicos de reachability, topology e presence em vez de recalcular o mesmo significado no Portal;
10. manter o Customer Portal como superfície de visibilidade, não de operação de infraestrutura.

## 4. Non-goals globais

CPEV não inclui:

- edição de topology;
- alteração do site atribuído de um device;
- movimento automático de devices;
- edição ou provisionamento de circuits;
- alteração de monitor, threshold, template ou polling;
- execução de ações SNMP;
- credenciais SNMP ou outras credenciais;
- raw OIDs ou raw SNMP payloads;
- raw discovery payloads/evidence;
- fingerprints, gateway MAC evidence ou neighbour evidence;
- collector internals;
- debug/execution metadata;
- Portal-specific inference de reachability, topology ou location;
- cópia da technician console para o cliente.

## 5. Modelo de controle de visibilidade

### 5.1 Regra geral

Cada família exposta por CPEV deve ter um gate explícito, por organização, com default `false`, seguindo `portal_branding` e o padrão atual do Portal.

Uma linha ausente, `false` ou `null` deve falhar fechada.

### 5.2 Matriz de famílias e flags

| Família | Waves | Flag | Estado da decisão | "Enable all" |
|---|---:|---|---|---|
| Network | W2, W3 | `enableNetworkVisibility` / `enable_network_visibility` | **Existente e confirmado no código** | segue comportamento existente |
| Placement | W1 | `enablePhysicalPlacement` / `enable_physical_placement` | **Nome proposto nesta spec; flag nova** | proposta: pode entrar somente após revisão explícita de sensibilidade |
| Monitoring / SNMP detail | W4 | **TBD: nova flag dedicada da família de monitoring** | família exigida pelo mantenedor; nome ainda não definido | proposta: fora de "Enable all" até decisão do mantenedor |
| Topology | W5 | `enableNetworkTopology` / `enable_network_topology` | **Nome proposto nesta spec; flag nova** | **fora de "Enable all" — obrigatório** |
| Observed location | W6 | `enableObservedLocation` / `enable_observed_location` | **Nome proposto nesta spec; flag nova** | **fora de "Enable all" — obrigatório** |
| Circuits | W7 | `enableCircuitVisibility` / `enable_circuit_visibility` | **Nome proposto nesta spec; depende da fundação de circuits** | proposta: fora de "Enable all" até revisão da wave |

`enableNetworkAlerts` continua sendo a flag existente para o enrichment de alert/ticket dos assets de Network Visibility. Ela não deve ser reutilizada como gate de Advanced SNMP; alertas e SNMP são contratos distintos e têm sensibilidades distintas.

**Decisão ainda necessária:** os nomes das novas flags são sugestões desta specification. A exigência confirmada é o isolamento por família e o opt-in por organização, não esses nomes específicos.

## 6. Regra de exposição de campos

Para toda wave:

- o read model do Portal seleciona somente campos explicitamente listados;
- nenhum `select()` irrestrito de uma tabela interna pode formar o DTO público;
- `json`, `jsonb`, `bytea`, free text operacional e containers abertos são excluídos por padrão;
- IDs internos são omitidos quando não são necessários para navegação/estabilidade do contrato;
- campos necessários apenas para joins, autorização ou inferência podem ser lidos pelo backend e ainda assim não aparecem no DTO;
- contract tests devem semear campos sensíveis nos registros de origem e provar que eles não aparecem na resposta serializada.

## 7. CPEV-W1 — Physical Placement Visibility

### 7.1 Objetivo

Expor ao cliente a localização física estruturada de um ativo já conhecido pelo Breeze, sem expor a mecânica de authority/reconciliation de placement.

### 7.2 Estado atual confirmado no código

`asset_physical_placements` já existe e é org-scoped. Seu conteúdo de placement é exatamente:

```text
room
rack
rackUnit
heightU
```

O modelo aceita como subject um managed `device` ou um `discovered_asset`. O site **não é armazenado** no placement; ele é derivado do subject atual. Quando um discovered asset está linked a um managed device elegível, o managed device se torna a authority de placement.

Isso significa que o Portal não deve criar outra regra de authority e não deve copiar `site_id` para uma nova estrutura.

### 7.3 Flag

Nova flag por organização, default `false`:

```text
enablePhysicalPlacement
```

Nome sujeito à aprovação do mantenedor.

### 7.4 Customer-safe DTO proposto

A projeção deve ser um bloco opcional do asset detail:

```ts
physicalPlacement?: {
  siteName: string;
  room: string | null;
  rack: string | null;
  rackUnit: number | null;
  heightU: number | null;
}
```

**Allowlist exata W1:**

| Campo público | Fonte | Regra |
|---|---|---|
| `siteName` | site live do subject/authority | nome customer-safe; não copiar `site_id` para o contrato se não for necessário |
| `room` | `asset_physical_placements.room` | direto, nullable |
| `rack` | `asset_physical_placements.rack` | direto, nullable |
| `rackUnit` | `asset_physical_placements.rack_unit` | inteiro 1..100 ou null |
| `heightU` | `asset_physical_placements.height_u` | inteiro 1..100 ou null |

### 7.5 Campos explicitamente excluídos W1

Não expor:

```text
asset_physical_placements.id
org_id
device_id
discovered_asset_id
created_at
updated_at
authority kind
linked/unlinked state
reconciliation outcome
placement conflict state
internal subject identifiers adicionais
```

O backend pode usar os IDs para joins e autorização, mas eles não fazem parte do bloco customer-safe de placement.

### 7.6 Comportamento

- flag off ou ausente: nenhum placement é exposto;
- flag on e placement ausente: bloco omitido; não fabricar strings como `Unknown`;
- flag on e placement existente: retornar somente a allowlist;
- a resolução de authority deve reutilizar `resolvePlacementAuthority()` e `readPlacement()` ou uma composição equivalente que preserve exatamente suas regras, não uma segunda implementação;
- W1 é exclusivamente leitura no Portal.

### 7.7 Acceptance criteria W1

1. Organização A nunca recebe placement de B.
2. O orgId é derivado de `portalAuth`, nunca de query/body autoritativo.
3. Managed device e discovered asset linked não produzem placements conflitantes no Portal; a authority canônica é respeitada.
4. O site exibido é o live site da authority, não um valor duplicado no placement.
5. Flag ausente/false não expõe nenhum dos cinco campos públicos.
6. Campos internos e timestamps de administração não aparecem na resposta.
7. Teste real de banco cobre isolamento cross-org.
8. Contract test prova a ausência dos campos excluídos.

## 8. CPEV-W2 — Network Site Health

### 8.1 Objetivo

Fornecer uma agregação por site dos sinais customer-safe já usados por Network Visibility, sem criar um novo health score.

### 8.2 Flag

Usa a flag existente:

```text
enableNetworkVisibility
```

Alert enrichment adicional continua condicionado a `enableNetworkAlerts`.

### 8.3 Fontes canônicas confirmadas

A implementação atual de Network Visibility já usa:

- `discovered_assets` para inventário;
- `loadReachability()` para estado de reachability — não `discovered_assets.isOnline` como autoridade;
- `network_monitor_results` org-scoped para resultado de monitor;
- `network_monitors` como definição, inclusive partner-wide, sem usar o `lastStatus` compartilhado como estado específico da organização;
- `networkSites()` para sites com ativos visíveis e não dismissed.

### 8.4 Allowlist W2

Por site:

```text
siteName
totalAssets
onlineAssets
offlineAssets
unverifiedAssets
snmpDevicesPolling
monitorsDown
```

Quando `enableNetworkAlerts=true`, podem ser acrescentados:

```text
activeAlertCount
highestAlertSeverity
```

`highestAlertSeverity` fica limitado a:

```text
critical | high | medium | low | info | null
```

`lastValidObservationAt` **não entra na allowlist inicial** até existir uma única fonte canônica e inequívoca para o agregado por site. Não deve ser sintetizado de timestamps heterogêneos.

### 8.5 Excluir W2

- monitor IDs/configuration;
- polling interval;
- thresholds;
- monitor result rows;
- raw alert context;
- alert-rule configuration;
- ticket internals;
- discovery evidence;
- SNMP credentials ou raw metrics;
- qualquer site-health score inventado pela wave.

## 9. CPEV-W3 — Network Asset Detail

### 9.1 Objetivo

Estabilizar uma projeção customer-facing de um único network asset que possa compor blocos de waves aprovadas posteriormente.

### 9.2 Flag

Usa `enableNetworkVisibility`.

### 9.3 Allowlist base W3 — já suportada pelo contrato atual

```text
id
hostname
label
ipAddress
macAddress
assetType
onlineState
lastSeenAt
firstSeenAt
manufacturer
model
siteName
```

`onlineState` mantém a semântica existente:

```text
online | offline | null
```

onde `null` significa unverified e nunca é convertido em offline.

Quando `enableNetworkAlerts=true`, o contrato pode incluir os campos opcionais já existentes:

```text
activeAlertCount
highestAlertSeverity
openTicketCount
```

### 9.4 Excluir W3

- raw fingerprints;
- open ports;
- discovery payloads/evidence;
- collector data;
- monitor IDs/configuration/thresholds;
- raw alert context;
- raw neighbor rows;
- raw SNMP state/OIDs;
- inference/debug metadata.

W3 pode compor `physicalPlacement`, `snmp`, `observedLocation` e relações topology somente quando as respectivas flags estiverem habilitadas e cada bloco seguir sua própria allowlist.

## 10. CPEV-W4 — Advanced SNMP Visibility

### 10.1 Estado

A ideia já apareceu na spec aprovada de Advanced Portal Visibility como opção on-hold. #8775 apresenta um caso concreto, mas o mantenedor ainda não aprovou a reativação nem o nome da flag. Portanto W4 permanece **outline / decisão pendente**, não requisito de implementação.

### 10.2 Gate

Usar uma flag dedicada da família de monitoring, default `false`. Até decisão explícita, ela deve permanecer fora de "Enable all".

### 10.3 Allowlist candidata W4

Se a wave for reativada, limitar a projeção a dados derivados de OIDs/MIBs padrão revisados:

```text
pollingState
uptimeSeconds
interfaces[].name
interfaces[].operState
interfaces[].speedBps
interfaces[].inBps
interfaces[].outBps
interfaces[].inErrors
interfaces[].outErrors
printerSupplies[].description
printerSupplies[].percentRemaining
pageCount
```

`pollingState` deve ser um enum customer-safe e não a linha interna de polling.

### 10.4 Nunca expor W4

```text
community
username
authPassword
privPassword
authProtocol
privProtocol
managementIp
port
pollingInterval
raw OID
raw metric name
raw metric payload
SNMP template
error/backoff internals
monitor rules
```

A implementação futura deve ter uma allowlist fixa de OIDs no backend e serializar somente os campos públicos acima; o OID em si nunca atravessa o contrato.

## 11. CPEV-W5 — Customer-safe Network Topology

### 11.1 Estado

Outline. A wave deve consumir os read models canônicos de topology e reduzir o resultado; não pode construir um segundo topology engine para o Portal.

### 11.2 Flag

Nova flag independente, default `false`, obrigatoriamente fora de "Enable all":

```text
enableNetworkTopology
```

Nome proposto.

### 11.3 Allowlist inicial candidata W5

Nodes:

```text
id
displayName
assetType
manufacturer
model
onlineState
ipAddress
```

Edges:

```text
sourceId
targetId
relationshipType
```

`relationshipType` deve usar um enum customer-safe explicitamente revisado pela wave; não deve repassar os kinds internos automaticamente.

### 11.4 Excluir W5

- raw topology node attributes;
- raw relationship attributes;
- topology epochs/generations;
- observer/collector IDs;
- neighbour evidence;
- routes/default-route evidence;
- fingerprints;
- logical context keys;
- source evidence IDs;
- inference confidence/metadata;
- debug attributes;
- raw interface configuration.

A necessidade de `id`, `sourceId` e `targetId` é funcional para renderizar relações; esses IDs devem ser os mínimos estáveis já autorizados pela projeção e não abrir acesso a endpoints internos adicionais.

## 12. CPEV-W6 — Observed Location Visibility

### 12.1 Estado atual confirmado

Breeze já possui um read model próprio de presence/location. O estado canônico distingue `home`, `visiting`, `unrecognized`, `ambiguous`, `stale` e `unknown` e mantém assignment separado de observation. O modelo também contém `reason`, prefixes, gateway address, MAC corroboration, fingerprints, evidence, suggestions e histórico — esses dados são operacionais e não são apropriados para passthrough ao Portal.

### 12.2 Flag

Nova flag independente, default `false`, obrigatoriamente fora de "Enable all":

```text
enableObservedLocation
```

Nome proposto.

### 12.3 Contrato customer-safe W6

A projeção pública deve ser opcional:

```ts
observedLocation?:
  | { kind: 'corporate_network'; siteName: string }
  | { kind: 'external_network' };
```

### 12.4 Regra de mapeamento

**Confirmado pela spec de presence:** `home` e `visiting` são estados positivos baseados em regras canônicas, enquanto ausência de match não prova que o device está fora de rede corporativa.

Portanto:

- `home` → `corporate_network` com o nome do assigned/current corporate site aplicável;
- `visiting` → `corporate_network` com o customer-safe nome do matched site, somente quando essa informação está autorizada;
- `unrecognized`, `ambiguous`, `stale`, `unknown` → **campo omitido**, por enquanto.

`external_network` permanece **sem fonte autorizada** nesta specification. Ele não pode ser derivado de `unrecognized` nem de ausência de corporate match.

### 12.5 Excluir W6

```text
reason
prefix
gatewayAddress
gatewayMac
macCorroborated
fingerprints
declaredBy
declarationIds
observerDeviceIds
evidence
observedAt/freshUntil quando usados como diagnóstico interno
coverageReason
fingerprintVersion
suggestedSiteId
suggestionDays
suggestionFirstAt
suggestionLastAt
daily presence rows
assignment-confirmation internals
```

Se no futuro um sinal positivo e canônico de external network for aprovado, ele deve ser adicionado primeiro ao modelo canônico e só depois mapeado para `external_network`; não deve nascer como heuristic exclusiva do Portal.

## 13. CPEV-W7 — WAN / Circuit Visibility

### 13.1 Estado

Deferred até a fundação WAN/circuits estar estável em `upstream/main`. A spec de Physical Placement and Circuits já define circuits como customer data org-owned e separa service metadata de operational health. No Portal contract deve anteceder uma implementação canônica estável.

### 13.2 Flag

Nova flag por organização, default `false`:

```text
enableCircuitVisibility
```

Nome proposto.

### 13.3 Allowlist candidata W7

Quando a fundação estiver estável, a wave pode avaliar:

```text
provider
circuitLabelOrCid
bandwidth
serviceType
associatedInterfaceDisplayName
primarySiteName
servedSiteNames[]
```

Os nomes públicos finais devem refletir os campos reais da implementação canônica naquele momento; nenhum campo futuro deve ser criado apenas para satisfazer esta outline.

### 13.4 Operational status

Não expor `up`, `down` ou `degraded` com base em existência, reassociation ou administrative state de circuit.

Status operacional só pode entrar quando houver uma relação de monitoring autoritativa e revisada. `servedSiteNames` descreve associação/impacto potencial e não prova outage de site.

### 13.5 Excluir W7

- credentials;
- provisioning details;
- reassociation internals/state;
- topology lifecycle internals;
- raw interface configuration;
- provider API internals;
- troubleshooting evidence;
- inferred outage sem fonte de monitoring autoritativa.

## 14. Organização, autorização e tenancy

### 14.1 Regra de request

Toda rota CPEV deve:

1. autenticar via Portal;
2. derivar `orgId` de `portalAuth`;
3. ignorar/rejeitar qualquer tentativa do cliente de escolher outra organização como contexto autoritativo;
4. executar leitura sob o mesmo `withDbAccessContext` / organization scope usado pelos read models do Portal;
5. preservar RLS como defesa obrigatória de banco, não apenas filtro de aplicação.

### 14.2 IDs de site e asset em filtros

Quando uma rota aceitar `siteId` ou `assetId`, o valor funciona apenas como selector dentro da organização autenticada. Ele nunca altera o contexto de organização.

Um ID pertencente a outro org deve resultar em ausência/denial segundo o padrão da rota, nunca em dados cross-tenant.

## 15. Segurança e prevenção de field leakage

Cada wave deve possuir:

1. teste de flag ausente / false / true;
2. teste de org isolation A→A, A↛B, B↛A;
3. teste com registros de origem deliberadamente preenchidos com valores sensíveis;
4. assertion sobre a resposta serializada provando que campos proibidos não aparecem;
5. teste de `no_data` onde aplicável;
6. teste que impeça `ok` com zeros fabricados quando a fonte é indisponível;
7. teste de auth-derived org scope, incluindo tentativa de forged org/site/asset ID quando aplicável;
8. teste de comportamento de "Enable all" para flags que devem permanecer fora;
9. real-Postgres integration test para qualquer read model cuja garantia dependa de RLS/joins org-scoped.

Nenhum teste deve depender apenas de TypeScript para provar ausência de segredo; a resposta serializada é o boundary que deve ser verificado.

## 16. Impacto de UI

### 16.1 Customer Portal

A arquitetura alvo pode compor:

```text
Network
├── Overview
├── Sites
│   └── Environment summary (W2)
├── Assets
│   └── Asset detail (W3)
│       ├── Physical placement (W1)
│       ├── SNMP (W4)
│       └── Observed location (W6)
├── Topology (W5)
└── WAN / Circuits (W7)
```

Blocos dependentes de flags devem desaparecer completamente quando desabilitados. O frontend não deve receber dados sensíveis para depois escondê-los visualmente.

### 16.2 MSP / default web console

O MSP continua configurando visibilidade no home existente de Portal settings para a organização. Esta spec não cria uma segunda área de configuração.

Qualquer nova setting deve cumprir a regra do projeto “one concept, one home” e documentar home, level, resolver e número de locais de configuração na PR de implementação.

## 17. Sequenciamento

O agrupamento aprovado para especificação permanece:

```text
CPEV-W1 — Physical Placement
CPEV-W2 — Network Site Health
CPEV-W3 — Network Asset Detail

CPEV-W4 — Advanced SNMP
CPEV-W5 — Customer-safe Topology
CPEV-W6 — Observed Location

CPEV-W7 — WAN / Circuits
```

Recomendação desta specification:

- **W1:** pronta para virar issue/implementation wave depois da revisão desta spec;
- **W2:** fonte canônica suficiente para uma spec de implementação detalhada;
- **W3:** grande parte da allowlist já existe no contrato atual; detalhar endpoint/UX em wave própria;
- **W4:** aguardar decisão explícita sobre reativação e nome/gate da família de monitoring;
- **W5:** detalhar enum de relationships antes de implementar;
- **W6:** corporate network pode usar presence canônico; `external_network` continua bloqueado por falta de sinal positivo autorizado;
- **W7:** aguardar a fundação de circuits estabilizar em `main`.

As waves não devem ser implementadas em uma única PR.

## 18. Acceptance criteria da feature CPEV

CPEV está coerente com a direção aprovada quando:

- [ ] cada família tem gate por organização e default off quando novo;
- [ ] topology e observed location estão fora de "Enable all";
- [ ] todas as respostas públicas possuem allowlists fechadas;
- [ ] nenhum credential, raw OID, raw `jsonb`, evidence ou debug metadata atravessa o boundary;
- [ ] org scope vem de Portal auth;
- [ ] tests provam cross-tenant isolation e ausência de fields sensíveis;
- [ ] W1 usa a authority de placement já existente e deriva site do subject live;
- [ ] W2/W3 reutilizam reachability e monitor-result semantics existentes;
- [ ] W5 não cria um topology engine paralelo;
- [ ] W6 não transforma “sem match corporativo” em external network;
- [ ] W7 não transforma metadata administrativa de circuit em health operacional;
- [ ] não há mutations de infraestrutura a partir dessas surfaces do Portal.

## 19. Decisões abertas

### Q1 — Nomes finais das flags novas

Os nomes `enablePhysicalPlacement`, `enableNetworkTopology`, `enableObservedLocation` e `enableCircuitVisibility` são sugestões. A exigência confirmada é uma flag independente por família, não esses nomes.

### Q2 — Placement e "Enable all"

O mantenedor exigiu explicitamente que topology e observed location fiquem fora de "Enable all". Não houve decisão equivalente para placement. Esta spec não transforma essa ausência em requisito; a sensibilidade de placement deve ser decidida na revisão.

### Q3 — Monitoring / Advanced SNMP

A reativação continua pendente. Se aprovada, W4 precisa de uma nova flag dedicada; `enableNetworkAlerts` não deve ser reutilizada.

### Q4 — External network

Hoje o presence engine prova corporate `home`/`visiting`, mas `unrecognized` não prova external. Até existir um sinal positivo canônico, `external_network` deve ser omitido.

### Q5 — Topology relationship enum

W5 precisa definir em sua wave spec a lista de relationship types customer-safe. Reutilizar todos os internal kinds automaticamente é proibido.

### Q6 — Circuit fields finais

W7 só congela seu contrato após a implementação canônica de circuits estar estável em `upstream/main`.

## 20. Rastreabilidade das decisões

### Confirmado no código

- `enableNetworkVisibility` existe em `portal_branding` e integra `PORTAL_VISIBILITY_FLAG_KEYS`.
- Network Visibility deriva reachability por serviço canônico, mantém `not_enabled`/`no_data` e seleciona explicitamente os campos do asset.
- `NetworkAssetRowDto` já expõe identificação, reachability, inventory básico, site e enrichments opcionais de alert/ticket.
- `asset_physical_placements` já existe, é org-scoped e armazena somente room/rack/U/height além de IDs/timestamps internos.
- placement deriva o site live do subject e possui regra canônica de authority para discovered asset linked a device.
- presence/location já existe como read model separado com estados positivos e inconclusivos, além de evidence interna que não deve ser passada ao Portal.

### Confirmado na spec existente

- Advanced Portal Visibility exige closed field lists e mantém dados mais sensíveis fora de "Enable all".
- Physical Placement and Circuits mantém site fora do row de placement e trata circuit metadata como administrativo, não health.
- Topology site location mantém assignment administrativo separado de observed presence e afirma que unmatched evidence não é absence.

### Confirmado pelo mantenedor

- #8775 foi aceita como spec continuando #5438/#7450.
- opt-in por família, por organização e default off.
- topology e observed location fora de "Enable all".
- field allowlists exatas por wave.
- sem passthrough interno/jsonb; sem credentials, management IPs ou internal hostnames não justificados.
- W1 limitada à fundação já existente e org-scoped.

### Inferências deliberadamente evitadas

- ausência de corporate match não significa external network;
- circuit administrative state não significa link health;
- shared monitor definition/status não significa resultado de uma organização;
- placement row não é uma nova fonte de site assignment;
- topology internal relationship não é automaticamente customer-safe.

### Sugestões desta specification

- nomes das flags novas;
- manter W4 e W7 fora de "Enable all" até revisão específica;
- DTO mínimo de placement W1;
- allowlist inicial dos nodes/edges W5;
- omitir `external_network` até existir sinal positivo canônico.
