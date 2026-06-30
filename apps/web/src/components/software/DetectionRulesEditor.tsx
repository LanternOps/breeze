import type { DetectionRule, RegistryHive } from '@breeze/shared';

interface DetectionRulesEditorProps {
  rules: DetectionRule[];
  onChange: (rules: DetectionRule[]) => void;
}

const REGISTRY_HIVES: RegistryHive[] = ['HKLM', 'HKCU', 'HKCR', 'HKU', 'HKCC'];

const RULE_TYPE_LABELS: Record<DetectionRule['type'], string> = {
  registry: 'Registry key/value',
  file_exists: 'File or folder exists',
  msi_product_code: 'MSI product code',
};

// A fresh clause for a given type, with sensible defaults.
function blankRule(type: DetectionRule['type']): DetectionRule {
  switch (type) {
    case 'registry':
      return { type: 'registry', hive: 'HKLM', path: '' };
    case 'file_exists':
      return { type: 'file_exists', path: '' };
    case 'msi_product_code':
      return { type: 'msi_product_code', productCode: '' };
  }
}

const inputClass =
  'h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring';

/**
 * Authoring UI for a software version's detection rules (issue #2022). The agent
 * evaluates these against the device's real state to decide install/uninstall
 * status independent of the installer exit code, and to skip install when the
 * package is already present. All clauses must match (AND).
 */
export default function DetectionRulesEditor({ rules, onChange }: DetectionRulesEditorProps) {
  const updateRule = (index: number, next: DetectionRule) => {
    onChange(rules.map((rule, i) => (i === index ? next : rule)));
  };

  const removeRule = (index: number) => {
    onChange(rules.filter((_, i) => i !== index));
  };

  const addRule = () => {
    onChange([...rules, blankRule('registry')]);
  };

  return (
    <div className="mt-4" data-testid="detection-rules-editor">
      <div className="flex items-center justify-between">
        <label className="text-xs font-semibold uppercase text-muted-foreground">Detection Rules</label>
        <button
          type="button"
          onClick={addRule}
          data-testid="detection-rule-add"
          className="rounded-md border px-2 py-1 text-xs font-medium hover:bg-muted"
        >
          + Add rule
        </button>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        Optional. When set, install/uninstall status reflects the device&apos;s real state instead of the
        installer exit code, and installs are skipped when the package is already present. All rules must match.
      </p>

      {rules.length === 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">No detection rules — status falls back to the installer exit code.</p>
      ) : (
        <div className="mt-3 space-y-3">
          {rules.map((rule, index) => (
            <div key={index} className="rounded-md border bg-muted/30 p-3" data-testid="detection-rule-row">
              <div className="flex items-center gap-2">
                <select
                  value={rule.type}
                  data-testid="detection-rule-type"
                  onChange={(event) => updateRule(index, blankRule(event.target.value as DetectionRule['type']))}
                  className="h-9 rounded-md border bg-background px-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                >
                  {(Object.keys(RULE_TYPE_LABELS) as DetectionRule['type'][]).map((type) => (
                    <option key={type} value={type}>
                      {RULE_TYPE_LABELS[type]}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => removeRule(index)}
                  data-testid="detection-rule-remove"
                  className="ml-auto rounded-md border px-2 py-1 text-xs text-destructive hover:bg-muted"
                  aria-label="Remove detection rule"
                >
                  Remove
                </button>
              </div>

              {rule.type === 'registry' && (
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  <select
                    value={rule.hive ?? 'HKLM'}
                    aria-label="Registry hive"
                    onChange={(event) => updateRule(index, { ...rule, hive: event.target.value as RegistryHive })}
                    className="h-9 rounded-md border bg-background px-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                  >
                    {REGISTRY_HIVES.map((hive) => (
                      <option key={hive} value={hive}>
                        {hive}
                      </option>
                    ))}
                  </select>
                  <input
                    type="text"
                    value={rule.path}
                    placeholder="SOFTWARE\\Vendor\\App"
                    aria-label="Registry key path"
                    onChange={(event) => updateRule(index, { ...rule, path: event.target.value })}
                    className={inputClass}
                  />
                  <input
                    type="text"
                    value={rule.valueName ?? ''}
                    placeholder="Value name (optional)"
                    aria-label="Registry value name"
                    onChange={(event) =>
                      updateRule(index, { ...rule, valueName: event.target.value || undefined })
                    }
                    className={inputClass}
                  />
                  <input
                    type="text"
                    value={rule.valueData ?? ''}
                    placeholder="Expected value data (optional)"
                    aria-label="Registry expected value data"
                    onChange={(event) =>
                      updateRule(index, { ...rule, valueData: event.target.value || undefined })
                    }
                    className={inputClass}
                  />
                </div>
              )}

              {rule.type === 'file_exists' && (
                <div className="mt-2">
                  <input
                    type="text"
                    value={rule.path}
                    placeholder="C:\\Program Files\\Vendor\\App\\app.exe"
                    aria-label="File or folder path"
                    onChange={(event) => updateRule(index, { ...rule, path: event.target.value })}
                    className={inputClass}
                  />
                </div>
              )}

              {rule.type === 'msi_product_code' && (
                <div className="mt-2">
                  <input
                    type="text"
                    value={rule.productCode}
                    placeholder="{3F2504E0-4F89-41D3-9A0C-0305E82C3301}"
                    aria-label="MSI product code"
                    onChange={(event) => updateRule(index, { ...rule, productCode: event.target.value })}
                    className={inputClass}
                  />
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
