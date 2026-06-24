# AI Excel Add-ins and Spreadsheet AI Product Matrix

Research date: 2026-06-13

## Scope

This is a market map of publicly discoverable AI products that either:

- run inside Microsoft Excel as an add-in, plugin, sidebar, or local desktop agent;
- support Excel files directly through upload/import/export; or
- are spreadsheet-native AI products adjacent to Excel, especially Google Sheets products that buyers often compare against Excel add-ins.

This is not guaranteed to be literally exhaustive. The long tail includes many single-purpose formula generators, clones, dormant listings, Chrome extensions, and SEO directory entries with weak evidence. I included products with public product pages, marketplace listings, support docs, or credible vendor documentation that described current spreadsheet/Excel capability.

## Capability Key

- `Native Excel`: Runs directly in Microsoft Excel or through a Microsoft Office add-in/local Excel agent.
- `Excel files`: Can upload, import, export, or operate on `.xls`/`.xlsx`/CSV files outside Excel.
- `Formula`: Generates, explains, debugs, or optimizes spreadsheet formulas.
- `Bulk AI`: In-cell or row-wise prompts/functions for classification, extraction, generation, enrichment, translation, etc.
- `Edit workbook`: Can directly modify cells, formatting, formulas, pivots, charts, or workbooks.
- `Analysis`: Natural-language analysis, insights, statistics, trends, forecasting, or anomaly detection.
- `Charts/reports`: Produces charts, dashboards, reports, slides, or narrative output.
- `Automation/code`: Generates or runs VBA, Apps Script, SQL, Python, regex, or automation workflows.
- `Connectors`: Web search, external data sources, databases, financial data, BI/warehouse, or app integrations.
- `Governance`: Publicly documented enterprise/privacy/security controls beyond basic website policy.

## At-a-Glance Matrix

| Product | Category | Native Excel | Excel files | Formula | Bulk AI | Edit workbook | Analysis | Charts/reports | Automation/code | Connectors | Governance | Best fit |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| Microsoft 365 Copilot in Excel | Native platform AI | Yes | Yes | Yes | Partial | Yes | Yes | Yes | No VBA/Python execution positioned | Microsoft 365 graph/work context | Yes | Microsoft 365 users who want built-in AI with enterprise controls |
| ChatGPT for Excel and Google Sheets | Official OpenAI add-in | Yes | Yes | Yes | Partial | Yes | Yes | Partial | No VBA/Power Query/macros yet | ChatGPT apps, selected financial data integrations | Yes for Business/Enterprise/Edu | General spreadsheet creation, analysis, model updates |
| Claude for Excel | Official Anthropic add-in | Yes | Yes | Yes | Partial | Yes | Yes | Yes | No VBA/macros/data tables | Claude connectors, skills, LLM gateway | Partial/enterprise controls noted with gaps | Finance/model review, cell citations, controlled workbook edits |
| Google Gemini in Sheets | Adjacent native Sheets AI | No | Sheets import/export | Yes | Yes via AI functions/columns | Yes in Sheets | Yes | Yes | No | Google Workspace | Yes | Google Workspace teams comparing Sheets-native AI |
| GPT for Excel Word / GPT for Work | Excel/Sheets add-in | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Apps Script/VBA support advertised in external docs | Model choice, enterprise options | Yes | Power users needing agentic Excel/Sheets workflows |
| TwistlyCells / GPT for MS Excel | Excel add-in | Yes | Not primary | Yes | Yes | Partial | Yes | Table outputs | No | Not emphasized | Not found | In-cell ChatGPT-style formulas and structured functions |
| Formula Bot | Excel add-in + web AI analyst | Yes | Yes | Yes | Yes | Partial | Yes | Yes | VBA/SQL/App Script tools on site | Data connectors on site | Basic public docs | Formula help plus lightweight AI analyst/charts |
| Numerous.ai | Excel/Sheets add-in | Yes | Spreadsheet-native | Yes | Yes | Partial | Partial | No | No | No | Team plan/support only | Row-wise text generation, classification, summarization |
| Ajelix Excel Add-in | Excel add-in + web tools | Yes | Yes | Yes | Translation-focused | Partial | AI analyst/graphs via suite | Yes via suite | VBA/App Script generators | No | Not found | Formula generation/explanation and spreadsheet translation |
| AI Agent for Excel by Matrix Lead | Excel add-in | Yes | Add external workbooks | Yes | Partial | Yes | Yes | Partial | No clear code execution | Web search, memory, external workbook context | Not found | One-click suggested workbook edits and model generation |
| Shortcut AI | Excel plugin/local agent | Yes | Yes | Yes | Partial | Yes | Yes | Financial models | Finance workflows | Not emphasized | Not found | Finance users building/editing DCF, LBO, 3-statement models |
| ExcelMaster.ai | Windows Excel add-in/local agent | Yes, Windows desktop | `.xlsx`/`.xlsm` | Yes | Partial | Yes | Yes | Yes | Runs VBA/Python automation | No | Local-file/backup claims | Desktop Excel automation with code execution and rollback |
| SheetXAI | Excel/Sheets automation platform | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Workflow automation; media/document processing | MCP/apps/services | Not found | Cross-platform spreadsheet automation, bulk media/document tasks |
| PromptLoop | Sheets/Excel data automation | Claimed Excel support | Spreadsheet data | No formula focus | Yes | No | Yes for text/web tasks | Custom reports | Custom tasks | Web browsing/scraping, enrichment | Not found | GTM research, enrichment, extraction at spreadsheet scale |
| Cube AI Analyst | FP&A Excel/Sheets sidebar | Yes via Cube sidebar | Cube data into sheets | No formula focus | No | Inserts live Cube ranges | Yes | Reports | No | Cube source systems/transaction detail | Yes via Cube permissions | FP&A teams already using Cube |
| DataSnipper Excel Agents | Audit/finance Excel agent | Yes | Supporting docs/workbooks | No formula focus | No | Yes within workpapers | Yes for audit tests | Audit-ready evidence docs | Structured procedures | Documents/evidence | Yes | Audit/finance teams needing evidence-linked outputs |
| GPTExcel | Web spreadsheet assistant | No add-in confirmed | Yes | Yes | Partial | Web chat/file outputs | Yes | Yes | SQL, VBA, Apps Script, regex | No | Basic security claim | Formula/code generation and chat with Excel/CSV files |
| Formulas HQ | Web formula/code toolkit | No | Not primary | Yes | No | No | Partial | No | Python beta, VBA, Apps Script, regex | No | Not found | Formula, regex, VBA, Python generation/explanation |
| AI Excel Bot | Web formula assistant | No | Not primary | Yes | No | No | No | No | VBA explanation/generation | No | Not found | Simple formula/VBA generation and explanation |
| ExcelBot.io | Browser spreadsheet | Browser spreadsheet | Yes | Yes | No | Adds formulas in browser sheet | No | No | No | No | Local/browser privacy claim | Privacy-sensitive quick formula generation in browser |
| Excelly-AI | Browser/Slack formula tool | No | XLS upload described by third parties | Yes | No | No | No | No | VBA support mentioned by third parties | Slack | Not found | Plain-text to formula generation in browser/Slack |
| Sheet+ | Web formula assistant | No | Excel/Sheets formulas | Yes | No | No | No | No | Debug/explain formulas | No | Not found | Formula generation, explanation, debugging |
| SheetGod | Web formula/code assistant | No | Excel/Sheets formulas | Yes | No | No | No | No | Macros, regex, Apps Script | No | Not found | Plain-English formula/macro snippets |
| Julius AI | Standalone AI data analyst | No | Yes | Yes | No | Outputs outside Excel | Yes | Yes | Python/R behind scenes | Databases/files | Not found | Upload Excel/Sheets and get charts, summaries, reports |
| Powerdrill Bloom | Standalone AI analyst | No | Yes | No formula focus | No | No | Yes | Yes, slides/infographics/Notion | No | File upload; DB on other plan | Not found | Automated Excel/CSV exploration and visual reports |
| Sourcetable | AI spreadsheet/data platform | No | Yes | Yes | Partial | Yes in Sourcetable | Yes | Yes | Python, SQL, data science stack | 100+ apps/DBs advertised | Yes | AI spreadsheet with live data, Python/SQL, big file support |
| Quadratic | AI spreadsheet | No | Excel import positioned | Formula/code cells | No | Yes in Quadratic | Yes | Yes | Python, SQL, JavaScript | Databases/PDFs/Excel positioned | Not found | Transparent code-based AI spreadsheet analysis |
| Rows AI | AI spreadsheet | No | Import/export adjacent | Yes | Yes | Yes in Rows | Yes | Yes | No-code advanced analysis | Rows integrations | Privacy claims | Teams wanting AI spreadsheet with SaaS integrations |
| Arcwise | Enterprise analytics assistant; Sheets history | No current Excel evidence | Data warehouses/BI | No formula focus | No | Embedded workflow outputs | Yes | Reports/explanations | No | Snowflake, BigQuery, Databricks, BI context | Yes | Enterprise data questions with business context |
| Kimi Sheets | AI sheets/spreadsheet agent | Not verified as Excel add-in | Excel/CSV positioned | Yes | Partial | Generates/edits spreadsheet files | Yes | Yes | No | Live web insights claimed | Security claims | General AI spreadsheet creation, pivots, charts, cleanup |
| Kuse AI | AI workspace with spreadsheet generation | No | Excel/CSV upload positioned | Partial | No | Generates spreadsheets | Yes | Dashboards/recs | No | Not emphasized | Not found | AI workspace that can create/analyze spreadsheets |

## Product Notes and Sources

### Native and Official Platform Add-ins

**Microsoft 365 Copilot in Excel**

Microsoft positions Copilot as Excel's built-in AI, covering data cleaning, trend identification, formulas, smart suggestions, and automated reports. Microsoft also announced agentic capabilities as generally available in Word, Excel, and PowerPoint, including multi-step app-native actions directly in worksheets.

Sources: [Microsoft AI in Excel](https://www.microsoft.com/en-us/microsoft-365/excel/ai-for-excel), [Microsoft 365 Copilot agentic GA announcement](https://www.microsoft.com/en-us/microsoft-365/blog/2026/04/22/copilots-agentic-capabilities-in-word-excel-and-powerpoint-are-generally-available/).

**ChatGPT for Excel and Google Sheets**

OpenAI's official add-in is globally available across ChatGPT plans and works in a spreadsheet sidebar. It can build/update formatted spreadsheets, summarize across tabs, explain/fix formulas, preserve formulas and formatting, link answers to cells, and ask permission before changes. Current limitations include no Office Scripts, Power Query, Pivot/Data Model, data validation, named ranges manager, slicers/timelines, external connection administration, advanced chart breadth, or VBA automation.

Sources: [ChatGPT for Excel and Google Sheets](https://chatgpt.com/apps/spreadsheets/), [OpenAI launch/update post](https://openai.com/index/chatgpt-for-excel/), [Microsoft Marketplace listing](https://marketplace.microsoft.com/en-us/product/office/wa200010215?tab=overview).

**Claude for Excel**

Claude for Excel is an Anthropic/Microsoft 365 add-in for Pro, Max, Team, and Enterprise plans. It can answer workbook questions with cell-level citations, update assumptions while preserving formula dependencies, debug formula errors, build or fill templates, navigate multi-tab workbooks, sort/filter, edit pivots/charts, apply conditional formatting, set validation, and use connectors/skills. Anthropic also highlights finance-focused use cases such as DCFs, coverage reports, due diligence packs, and real-time financial data connectors. Limitations include no VBA/macros/data tables, warnings for sensitive data, and some enterprise audit/compliance gaps.

Sources: [Claude Help Center: Use Claude for Excel](https://support.claude.com/en/articles/12650343-use-claude-for-excel), [Anthropic financial services announcement](https://www.anthropic.com/news/advancing-claude-for-financial-services), [Microsoft Marketplace listing](https://pages.store.office.com/addinsinstallpage.aspx?assetid=WA200009404).

**Google Gemini in Sheets**

Not an Excel add-in, but relevant because spreadsheet buyers compare it directly with Excel Copilot and AI add-ins. Gemini in Sheets supports spreadsheet/table creation, visualizations, formula generation, edits/formatting, and AI functions/columns in Workspace contexts.

Sources: [Gemini in Google Sheets](https://workspace.google.com/resources/spreadsheet-ai/), [Google Sheets AI function support](https://support.google.com/docs/answer/15820999).

### Excel-Native Add-ins and Agents

**GPT for Excel Word / GPT for Work**

Microsoft Marketplace lists GPT for Excel Word by Talarian as an Excel/Word add-in for formulas, formatting, cleanup, lookups, pivots, charts, analysis, and bulk row-wise workflows such as translation, content generation, normalization, enrichment, and scoring. The listing advertises enterprise options such as ZDR, SSO, BYOK, ISO 27001, and GDPR.

Sources: [Microsoft Marketplace listing](https://marketplace.microsoft.com/en-us/product/office/wa200005502?tab=overview), [GPT for Work](https://gptforwork.com/).

**TwistlyCells / GPT for MS Excel**

TwistlyCells is an Excel add-in listed as GPT for MS Excel. Its described functions include AI.ASK, AI.TABLE, AI.TRANSLATE, AI.FORMAT, AI.EXTRACT, AI.FILL, AI.LIST, and AI.CHOICE.

Sources: [Microsoft Marketplace listing](https://marketplace.microsoft.com/en-us/product/office/wa200005271?tab=overview), [TwistlyCells how-to](https://twistlycells.ai/how-to-use/).

**Formula Bot**

Formula Bot appears both as an Excel add-in and a standalone AI analyst. The AppSource listing covers formula translation/explanation plus text classification, extraction, sentiment, retrieval, example-based inference, and PDF-to-Excel. The web product lets users upload Excel files, ask questions, manipulate/reorganize spreadsheets, generate formulas, clean data, build visualizations, and derive insights.

Sources: [Microsoft Marketplace listing](https://marketplace.microsoft.com/en-us/product/office/wa200004935?tab=overview), [Formula Bot Excel AI](https://www.formulabot.com/excel-ai).

**Numerous.ai**

Numerous.ai is an Excel/Google Sheets add-in focused on AI formulas in cells. It uses functions such as `=NUM.AI` and `=NUM.INFER` for prompts, summarization, categorization, sentiment analysis, formatting examples, and row-wise repetition.

Sources: [Microsoft Marketplace listing](https://marketplace.microsoft.com/en-us/product/office/wa200005281?tab=overview), [Numerous.ai](https://numerous.ai/).

**Ajelix Excel Add-in**

Ajelix's Excel add-in focuses on formula generation, formula explanation, formula libraries/sharing, and AI translation of spreadsheets in 28 languages while preserving formatting/formulas. The broader Ajelix suite also includes AI analyst, graph, VBA, and Apps Script tools.

Sources: [Ajelix Excel add-in](https://ajelix.com/tools/excel-add-in/), [Ajelix VBA generator](https://ajelix.com/tools/excel-vba-script-generator/).

**AI Agent for Excel by Matrix Lead**

This AppSource add-in positions itself as an autonomous Excel agent. It supports model generation/review/improvement, data consolidation/cleaning/summarization/analysis/validation/prediction/enrichment, formula optimization/debugging, single-click suggested edits, external workbook context, web search, optional memory, and result verification/retries.

Source: [Microsoft Marketplace listing](https://marketplace.microsoft.com/en-us/product/wa200008627?tab=overview).

**Shortcut AI**

Shortcut is a finance-oriented Excel AI agent with an Excel plugin and a Windows-only terminal/local workflow. It is aimed at analysts/funds and highlights DCFs, LBOs, 3-statement models, and editing/building real desktop Excel files.

Sources: [Shortcut AI](https://shortcut.ai/), [Shortcut AI product post](https://shortcut.ai/blog/posts/shortcut-ai).

**ExcelMaster.ai**

ExcelMaster is a Windows Excel add-in/local agent that writes formulas, runs code, builds charts, cleans data, creates backups, and rolls back on failure. It claims support for `.xlsx` and `.xlsm`, desktop Excel 2016+, VBA and Python execution, visible reasoning/logs, and local file handling with only relevant cell content sent to models.

Source: [ExcelMaster.ai](https://excelmaster.ai/).

**SheetXAI**

SheetXAI markets itself as cross-platform Excel and Google Sheets automation via plain English. Public pages describe formula generation, data analysis, content generation, workflow automation, bulk operations, multi-sheet operations, media generation, document processing, PDF/image extraction, integrations, and multiple LLM/BYOK support.

Sources: [SheetXAI](https://www.sheetxai.com/), [SheetXAI vs SheetMagic comparison](https://www.sheetxai.com/resources/comparisons/sheetxai-vs-sheetmagic).

**PromptLoop**

PromptLoop is primarily GTM/data enrichment automation for spreadsheets. It supports Google Sheets and claims Excel integration. Capabilities include Autoloop scheduled data tasks, custom AI tasks, labeling, browsing, inference, extraction, summarization, web research, enrichment, and spreadsheet functions such as `=PROMPTLOOP`.

Sources: [PromptLoop Excel docs](https://www.promptloop.com/docs/excel/excel-enable), [Google Workspace Marketplace listing](https://workspace.google.com/marketplace/app/promptloop_ai_in_sheets/831127607357).

**Cube AI Analyst**

Cube's AI Analyst lives inside the Cube sidebar for Excel and Google Sheets. Users can ask questions about forecasts, budgets, variances, trends, and transaction-level details, then add generated results into sheets as live Cube ranges. It respects Cube user-level permissions.

Source: [Cube help: AI Analyst in Excel and Google Sheets](https://help.cubesoftware.com/hc/en-us/articles/46655615972116-Use-AI-Analyst-in-Excel-and-Google-Sheets).

**DataSnipper Excel Agents**

DataSnipper is a vertical Excel-native agent platform for audit and finance. It emphasizes multi-step audit/finance procedures, reconciliation across structured/unstructured data, extraction from supporting documents, evidence-linked "Snips," audit-ready documentation, and human-in-the-loop review.

Sources: [DataSnipper generic vs audit-grade AI](https://www.datasnipper.com/resources/generic-vs-audit-ai-excel-comparison), [DataSnipper Excel agents use case](https://www.datasnipper.com/resources/excel-agents-use-case-blog), [DataSnipper homepage](https://www.datasnipper.com/).

### Web Tools and Formula Assistants

**GPTExcel**

GPTExcel is a browser-based spreadsheet assistant for formula generation/explanation, SQL, automation scripts, regex, table templates, chat with Excel files, image-to-table conversion, charts/graphs, and Excel/CSV data analysis. It supports Excel, Google Sheets, LibreOffice Calc, and Airtable.

Source: [GPTExcel](https://gptexcel.uk/).

**Formulas HQ**

Formulas HQ offers AI generation/explanation for Excel and Google Sheets formulas, regex, VBA and Apps Script, Python beta, and prompt templates/system prompts.

Source: [Formulas HQ](https://formulashq.com/).

**AI Excel Bot**

AI Excel Bot is a lightweight formula/VBA assistant. Public search snippets describe Excel/Google Sheets formula generation, formula explanation, and VBA writing/explanation.

Source: [AI Excel Bot](https://aiexcelbot.com/).

**ExcelBot.io**

ExcelBot is a browser spreadsheet that accepts `.xlsx`, `.xls`, and `.csv`, generates formulas from plain English, places formulas into the sheet, and exports `.xlsx`. It claims spreadsheet privacy through browser-local handling.

Source: [ExcelBot.io](https://excelbot.io/).

**Excelly-AI**

Excelly-AI is a browser/Slack formula-generation tool. Public pages and third-party descriptions position it as text-to-Excel/Google Sheets formulas, with formula explanation and Slack access.

Sources: [Excelly-AI](https://www.excelly-ai.io/), [Cube roundup mention](https://www.cubesoftware.com/blog/ai-tools-for-excel).

**Sheet+**

Sheet+ is a formula helper for Google Sheets and Excel: text-to-formula, formula explanation, and formula debugging. Evidence found was directory-style rather than a rich current product page, so confidence is lower.

Source: [AI Valley Sheet+ profile](https://aivalley.ai/sheet/).

**SheetGod**

SheetGod is described in directories and competitor writeups as an AI tool for complex Excel/Google Sheets formulas, macros, regex, basic tasks, and Google Apps Script snippets. Evidence found was mostly third-party, so confidence is lower.

Sources: [AI Valley SheetGod profile](https://aivalley.ai/sheetgod/), [Numerous.ai SheetGod alternatives](https://numerous.ai/blog/sheetgod-alternative).

### Standalone Spreadsheet AI and Data Analyst Products

**Julius AI**

Julius is a standalone AI analyst that can analyze Excel and Google Sheets, generate formulas, create charts, and handle spreadsheet file formats including `.xls`, `.xlsx`, and `.csv`.

Source: [Julius Excel AI](https://julius.ai/home/excel-ai).

**Powerdrill Bloom**

Powerdrill Bloom is a standalone AI Excel/CSV analysis product. It uploads Excel/CSV files, automatically explores data, detects patterns/trends/correlations/key metrics, generates visual reports, and exports insights as slides, infographics, or Notion pages.

Source: [Powerdrill Excel AI Assistant](https://powerdrill.ai/features/excel-ai-assistant).

**Sourcetable**

Sourcetable is an AI spreadsheet and data analyst platform. It supports spreadsheet files, databases, apps, up to 10GB file claims, multi-tab analysis, AI charting, formula fixing, SQL/Python, NumPy/Pandas/SciPy/scikit-learn/StatsModels/Matplotlib/Plotly/Seaborn, and enterprise compliance claims.

Source: [Sourcetable](https://sourcetable.com/).

**Quadratic**

Quadratic is an AI spreadsheet with transparent code-based analysis. It emphasizes editable Python-generated methods inside cells and supports formulas, SQL, Python, and JavaScript in a collaborative spreadsheet environment.

Sources: [Quadratic](https://www.quadratichq.com/), [Quadratic product post](https://dev.to/quadraticai/quadratic-the-ai-powered-spreadsheet-for-modern-teams-gh2).

**Rows AI**

Rows is an AI spreadsheet where AI is embedded in the workflow. It can add columns, edit cells, build charts, summarize tables, clean messy inputs, merge datasets, compute stats, run predictions/significance tests/clustering, enrich data, and create sample datasets/models/calculators. It has privacy claims including not using customer data to train models.

Source: [Rows AI](https://rows.com/ai).

**Arcwise**

Arcwise has shifted toward enterprise data/BI context rather than a pure spreadsheet add-in, but it remains relevant because it historically operated as an AI copilot for Sheets and now positions itself as embedded in existing workflows. Current pages emphasize connections to Snowflake, BigQuery, Databricks, docs/definitions/operating logic, grounded/auditable explanations, and enterprise controls.

Sources: [Arcwise](https://arcwise.app/), [Chrome Web Store Arcwise listing](https://chromewebstore.google.com/detail/ai-copilot-for-sheets-by/icpldamjhggegoohndlphlchjgjkdifd).

**Kimi Sheets**

Kimi Sheets is a spreadsheet agent for formula writing, data cleaning, spreadsheet creation, pivot tables, charts, dashboards, multi-sheet analysis, and live web insights. It is best treated as an adjacent AI spreadsheet/file-generation product unless Excel add-in distribution is verified.

Source: [Kimi Sheets](https://www.kimi.com/features/sheets).

**Kuse AI**

Kuse is an AI workspace that includes spreadsheet generation/analyzing as one artifact type. It is adjacent rather than Excel-native. Public pages and roundups describe uploading Excel/CSV, analyzing trends/anomalies, generating recommendations, and creating multi-sheet workbooks with formulas/charts/formatting from prompts.

Sources: [Kuse AI](https://www.kuse.ai/), [Kuse AI Excel tools roundup](https://www.kuse.ai/blog/insight/10-best-ai-tools-for-excel-in-2026).

## Shortlist by Buyer Need

| Need | Best-fit products to evaluate first |
|---|---|
| Built-in enterprise Microsoft workflow | Microsoft 365 Copilot in Excel |
| General-purpose official LLM add-in inside Excel | ChatGPT for Excel, Claude for Excel |
| Finance/model review with cell citations | Claude for Excel, ChatGPT for Excel, Shortcut AI |
| Row-wise classification/extraction/generation | GPT for Work, Numerous.ai, Formula Bot, SheetXAI, PromptLoop |
| Formula/code generation only | GPTExcel, Formulas HQ, AI Excel Bot, Sheet+, SheetGod, Excelly-AI |
| Agentic workbook editing | Microsoft Copilot, ChatGPT for Excel, Claude for Excel, GPT for Work, AI Agent for Excel, Shortcut, ExcelMaster |
| Desktop Excel plus VBA/Python execution | ExcelMaster.ai; GPTExcel/Formulas HQ for generation only |
| FP&A inside existing finance systems | Cube AI Analyst |
| Audit/reconciliation/evidence workflows | DataSnipper Excel Agents |
| Standalone upload-and-analyze Excel files | Julius, Powerdrill, Formula Bot, Sourcetable |
| Spreadsheet replacement with AI/data connectors | Sourcetable, Rows, Quadratic |
| Google Sheets-native AI | Gemini in Sheets, PromptLoop, SheetMagic, Rows, Numerous.ai |

## Observations

1. The market has moved from formula generation to workbook agents. In 2023-2024 most products were formula helpers; by 2026 the serious differentiation is whether the tool can read workbook structure, modify cells/formulas/formatting, preserve dependencies, cite cells, and let users review changes.

2. Microsoft, OpenAI, and Anthropic now define the high end of general-purpose Excel AI. Third-party add-ins compete by narrowing the workflow: bulk row processing, finance modeling, audit evidence, VBA/Python execution, or GTM/web enrichment.

3. Governance is uneven. Microsoft/OpenAI/Anthropic/Cube/Sourcetable/DataSnipper publish more enterprise or security context. Many smaller tools provide little beyond a privacy policy.

4. "Excel support" means different things. Some products are real Office add-ins, some are desktop/local agents, some upload/export `.xlsx`, and some only generate formulas compatible with Excel. Procurement should separate these before evaluating features.

5. Direct workbook editing creates new risk. Prompt injection in spreadsheet cells/comments/formulas, accidental destructive edits, and unreviewed financial/accounting outputs are explicit risks in the official Claude and ChatGPT docs.

## Watchlist / Lower-Confidence Products

These appeared in searches or third-party roundups but need deeper verification before procurement:

- Ghostwriter Ultimate: Office add-in covering Word/Excel/PowerPoint, but public evidence is broad writing assistant positioning rather than Excel-specialized workflow.
- AI-aided Formula Editor: AppSource formula generator/explainer with preview/validation, but narrower than most included products.
- GPT for Excel App: Older AppSource-style GPT custom-function add-in; appears basic compared with current products.
- Polymer, Datarails, Daloopa, DataRails, Causal, and other FP&A/data products: relevant for finance workflows but not primarily general AI Excel add-ins.
- Mobile apps and Chrome extensions branded "Sheets AI", "Excel AI", etc.: many exist, but evidence and differentiation are weak.

## Suggested Evaluation Criteria

For a hands-on vendor evaluation, test each finalist with the same workbook set:

1. Small clean table: formula generation, charting, and summary.
2. Messy import: dedupe, standardize dates/currency, split columns, detect missing values.
3. Multi-tab workbook: explain dependencies, update assumptions, preserve formulas.
4. Finance model: scenario analysis, sensitivity table, trace changed cells.
5. Bulk text task: classify/extract/summarize 500 rows with repeatability/cost tracking.
6. Safety: external/untrusted sheet with hidden prompt-injection text; verify the tool resists or warns.
7. Governance: SSO, data retention, training opt-out, audit logs, SIEM/DLP support, regional processing, BYOK/ZDR if required.
8. Rollback/review: before/after diffs, cell citations, change logs, undo, and backups.

