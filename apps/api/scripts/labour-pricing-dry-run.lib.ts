export interface LegacyCategoryRow {
  id: string; partnerId: string; parentId: string | null; name: string; isActive: boolean;
  defaultBillable: boolean | null; defaultHourlyRate: string | null; rateCurrency: string | null;
}
export interface LegacyOrgRow {
  orgId: string; orgName: string; partnerId: string; currencyCode: string;
  defaultBillable: boolean | null; defaultHourlyRate: string | null; rateCurrency: string | null;
  /** count of time entries in the last 90 days on tickets with NO category */
  uncategorisedEntryCount: number;
}
export interface PartnerReport {
  partnerId: string; partnerName: string; partnerCurrency: string;
  cardCurrencies: string[];
  workTypesToCreate: Array<{ name: string; fromCategoryIds: string[]; inactive: boolean }>;
  nameCollisions: Array<{ name: string; categoryIds: string[]; resolvedNames: string[] }>;
  rows: Array<{ currency: string; workTypeName: string; coverage: 'billable' | 'included' | 'non_billable'; rate: string | null }>;
  skippedWrongCurrencyRates: Array<{ categoryId: string; name: string; rate: string; enteredIn: string }>;
  droppedNonBillableRates: Array<{ categoryId: string; name: string; rate: string }>;
  orgOverrides: Array<{ orgId: string; orgName: string; cardName: string; currency: string; rate: string | null; billable: boolean | null }>;
  /** THE MONEY-MOVING DIFFERENCE. */
  uncategorisedBecomingBillable: Array<{ orgId: string; orgName: string; orgRate: string | null; currency: string; recentEntryCount: number }>;
}

// Decimal strings stay decimal strings: comparing prices must not lose precision.
function pricingKey(category: LegacyCategoryRow): string {
  const rate = category.defaultHourlyRate?.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '') ?? null;
  return JSON.stringify([category.defaultBillable === false, rate, category.rateCurrency]);
}

function parentPath(category: LegacyCategoryRow, byId: Map<string, LegacyCategoryRow>): string {
  const names: string[] = [];
  const visited = new Set([category.id]);
  let parentId = category.parentId;
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) break;
    names.unshift(parent.name);
    parentId = parent.parentId;
  }
  return names.join(' / ') || 'Root';
}

export function buildDryRunReport(input: {
  partners: Array<{ id: string; name: string; currencyCode: string }>;
  categories: LegacyCategoryRow[];
  orgs: LegacyOrgRow[];
}): PartnerReport[] {
  return input.partners.map((partner) => {
    const categories = input.categories.filter((c) => c.partnerId === partner.id)
      .sort((a, b) => a.id.localeCompare(b.id));
    const orgs = input.orgs.filter((o) => o.partnerId === partner.id);
    const cardCurrencies = [...new Set([
      partner.currencyCode,
      ...orgs.map((o) => o.currencyCode),
      ...categories.flatMap((c) => c.defaultHourlyRate !== null && c.rateCurrency !== null ? [c.rateCurrency] : []),
    ])].sort();
    const report: PartnerReport = {
      partnerId: partner.id, partnerName: partner.name, partnerCurrency: partner.currencyCode,
      cardCurrencies, workTypesToCreate: [], nameCollisions: [], rows: [],
      skippedWrongCurrencyRates: [], droppedNonBillableRates: [], orgOverrides: [],
      uncategorisedBecomingBillable: [],
    };
    const byId = new Map(categories.map((c) => [c.id, c]));
    const byName = new Map<string, LegacyCategoryRow[]>();
    for (const category of categories) {
      if (category.defaultHourlyRate === null && category.defaultBillable !== false) continue;
      const key = category.name.toLowerCase();
      const group = byName.get(key) ?? [];
      group.push(category);
      byName.set(key, group);
    }
    // Reserve original names too, so a generated suffix cannot steal another group's name.
    const reserved = new Set(byName.keys());
    const used = new Set<string>();
    for (const group of byName.values()) {
      const byPricing = new Map<string, LegacyCategoryRow[]>();
      for (const category of group) {
        const key = pricingKey(category);
        const equivalent = byPricing.get(key) ?? [];
        equivalent.push(category);
        byPricing.set(key, equivalent);
      }
      const resolvedNames: string[] = [];
      for (const equivalent of byPricing.values()) {
        const category = equivalent[0]!;
        let name = category.name;
        if (byPricing.size > 1) {
          const base = `${category.name} (${parentPath(category, byId)})`;
          name = base;
          let suffix = 0;
          while (used.has(name.toLowerCase()) || reserved.has(name.toLowerCase())) {
            name = `${base} [${category.id}${suffix ? `-${suffix}` : ''}]`;
            suffix++;
          }
        }
        used.add(name.toLowerCase());
        resolvedNames.push(name);
        report.workTypesToCreate.push({
          name, fromCategoryIds: equivalent.map((c) => c.id),
          inactive: equivalent.every((c) => !c.isActive),
        });
        for (const currency of cardCurrencies) {
          if (category.defaultBillable === false) {
            report.rows.push({ currency, workTypeName: name, coverage: 'non_billable', rate: null });
          } else if (category.defaultHourlyRate !== null && category.rateCurrency === currency) {
            report.rows.push({ currency, workTypeName: name, coverage: 'billable', rate: category.defaultHourlyRate });
          }
        }
      }
      if (byPricing.size > 1) {
        report.nameCollisions.push({ name: group[0]!.name, categoryIds: group.map((c) => c.id), resolvedNames });
      }
      for (const category of group) {
        if (category.defaultHourlyRate === null) continue;
        if (category.defaultBillable === false) {
          report.droppedNonBillableRates.push({ categoryId: category.id, name: category.name, rate: category.defaultHourlyRate });
        } else if (cardCurrencies.some((currency) => currency !== category.rateCurrency)) {
          // Count a category once even when its rate is skipped in several cards.
          report.skippedWrongCurrencyRates.push({
            categoryId: category.id, name: category.name, rate: category.defaultHourlyRate,
            enteredIn: category.rateCurrency ?? 'unknown',
          });
        }
      }
    }
    for (const org of orgs) {
      const matchingRate = org.rateCurrency === org.currencyCode ? org.defaultHourlyRate : null;
      if (org.defaultHourlyRate !== null || org.defaultBillable !== null) {
        report.orgOverrides.push({
          orgId: org.orgId, orgName: org.orgName, cardName: org.orgName, currency: org.currencyCode,
          rate: org.defaultBillable === false ? null : matchingRate, billable: org.defaultBillable,
        });
      }
      if (org.defaultBillable === null && matchingRate !== null) {
        report.uncategorisedBecomingBillable.push({
          orgId: org.orgId, orgName: org.orgName, orgRate: matchingRate,
          currency: org.currencyCode, recentEntryCount: org.uncategorisedEntryCount,
        });
      }
    }
    return report;
  });
}

export function formatReport(reports: PartnerReport[]): string {
  const affectedCount = reports.reduce((count, r) => count + r.uncategorisedBecomingBillable.length, 0);
  const lines = [
    '=== WILL START BILLING (money-moving difference, spec §3.6) ===',
    `${affectedCount} organization${affectedCount === 1 ? '' : 's'} have a default rate but never set a billable default. Their`,
    'UNCATEGORISED tickets are silently non-billable today and will become billable',
    'at that rate after the conversion. Review each one before the cut-over merges.',
    '',
  ];
  for (const report of reports) {
    for (const org of report.uncategorisedBecomingBillable) {
      lines.push(`  ${report.partnerName} / ${org.orgName} [${org.orgId}]  ${org.orgRate} ${org.currency}  ${org.recentEntryCount} entries on uncategorised tickets (last 90d)`);
    }
  }
  for (const report of reports) {
    lines.push('', `=== ${report.partnerName} [${report.partnerId}] (${report.partnerCurrency}) ===`,
      `Default cards: ${report.cardCurrencies.map((c) => `Standard rates (${c})`).join(', ')}`,
      'Each default card: All other work = billable, no rate.',
      `Work types to create (${report.workTypesToCreate.length}):`);
    for (const type of report.workTypesToCreate) {
      lines.push(`  ${type.name}${type.inactive ? ' [inactive]' : ''} ← ${type.fromCategoryIds.join(', ')}`);
    }
    lines.push(`Name collisions (${report.nameCollisions.length}):`);
    for (const collision of report.nameCollisions) {
      lines.push(`  ${collision.name} [${collision.categoryIds.join(', ')}] → ${collision.resolvedNames.join('; ')}`);
    }
    lines.push(`Work type rows (${report.rows.length}):`);
    for (const row of report.rows) {
      lines.push(`  ${row.currency} / ${row.workTypeName}: ${row.coverage}, ${row.rate ?? 'no rate'}`);
    }
    lines.push(`Category rates skipped in non-matching cards (${report.skippedWrongCurrencyRates.length}):`);
    for (const skip of report.skippedWrongCurrencyRates) {
      lines.push(`  ${skip.name} [${skip.categoryId}]: ${skip.rate}, entered in ${skip.enteredIn}; skipped in ${report.cardCurrencies.filter((c) => c !== skip.enteredIn).join(', ')}`);
    }
    lines.push(`Dropped non-billable category rates (${report.droppedNonBillableRates.length}):`);
    for (const drop of report.droppedNonBillableRates) {
      lines.push(`  ${drop.name} [${drop.categoryId}]: ${drop.rate}`);
    }
    lines.push(`Org override cards (${report.orgOverrides.length}):`);
    for (const org of report.orgOverrides) {
      lines.push(`  ${org.orgName} [${org.orgId}] → ${org.cardName} (${org.currency}): coverage ${org.billable === null ? 'unchanged' : org.billable ? 'billable' : 'non_billable'}, rate ${org.rate ?? 'no rate override'}`);
    }
  }
  return `${lines.join('\n')}\n`;
}
