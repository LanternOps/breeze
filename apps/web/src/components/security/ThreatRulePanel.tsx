import { useState } from "react";
import { Check, Copy, FileCode } from "lucide-react";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";
import type { YaraThreatRuleView } from "@breeze/shared";

const BADGE = "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium";

/**
 * Which detection rule fired on a threat (#6263 W04-5), from
 * `GET /security/threats/:id/details`. `matchedStrings[].data` is already
 * escaped by the agent (`\xNN`) — it is rendered as text and never escaped
 * again. The rule's version at detection time is not reported by the agent,
 * so none is shown.
 */
export default function ThreatRulePanel({ rule }: { rule: YaraThreatRuleView }) {
  const { t } = useTranslation("security");
  const [copied, setCopied] = useState(false);

  const copySha = async () => {
    if (!rule.sha256) return;
    try {
      await navigator.clipboard.writeText(rule.sha256);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable (insecure context / permission): the hash stays selectable.
    }
  };

  const label = (text: string) => <p className="text-xs uppercase text-muted-foreground">{text}</p>;

  return (
    <div data-testid="threat-rule-panel" className="rounded-lg border bg-card p-6 shadow-xs">
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        <FileCode className="h-4 w-4" />
        {t("securityThreatDetail.rule.title")}
      </h3>

      {rule.engine === "legacy" ? (
        <p data-testid="threat-rule-legacy" className="mt-3 text-sm text-muted-foreground">
          {t("securityThreatDetail.rule.legacy")}
        </p>
      ) : (
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            {label(t("securityThreatDetail.rule.ruleName"))}
            <p data-testid="threat-rule-name" className="break-all font-mono text-sm font-medium">
              {rule.ruleName ?? "-"}
            </p>
          </div>
          <div>
            {label(t("securityThreatDetail.rule.ruleSet"))}
            {rule.ruleSet ? (
              <div className="flex flex-wrap items-center gap-2">
                <a
                  data-testid="threat-rule-set-link"
                  href={`/security/detection-rules#${rule.ruleSet.id}`}
                  className="text-sm font-medium text-primary hover:underline"
                >
                  {rule.ruleSet.name}
                </a>
                {rule.ruleSet.isBuiltin && (
                  <span data-testid="threat-rule-set-badge-builtin" className={`${BADGE} border-primary/40 bg-primary/10 text-primary`}>
                    {t("detectionRules.badges.builtin")}
                  </span>
                )}
                {rule.ruleSet.partnerWide && (
                  <span data-testid="threat-rule-set-badge-all-orgs" className={`${BADGE} border-blue-500/40 bg-blue-500/10 text-blue-700`}>
                    {t("detectionRules.badges.allOrgs")}
                  </span>
                )}
              </div>
            ) : rule.ruleSetId ? (
              <p data-testid="threat-rule-set-missing" className="text-sm text-muted-foreground">
                {t("securityThreatDetail.rule.ruleSetMissing")}{" "}
                <span className="font-mono text-xs">{rule.ruleSetId}</span>
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">-</p>
            )}
          </div>
          {rule.tags.length > 0 && (
            <div className="sm:col-span-2">
              {label(t("securityThreatDetail.rule.tags"))}
              <div data-testid="threat-rule-tags" className="mt-1 flex flex-wrap gap-1">
                {rule.tags.map((tag) => (
                  <span key={tag} className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                    {tag}
                  </span>
                ))}
              </div>
            </div>
          )}
          <div className="sm:col-span-2">
            {label(t("securityThreatDetail.rule.matchedStrings"))}
            {rule.matchedStrings.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("securityThreatDetail.rule.noMatchedStrings")}</p>
            ) : (
              <ul data-testid="threat-rule-strings" className="mt-1 space-y-0.5 rounded-md border bg-muted/30 p-2 font-mono text-xs">
                {rule.matchedStrings.map((s, i) => (
                  <li key={i} data-testid={`threat-rule-string-${i}`} className="break-all">
                    <span className="text-muted-foreground">
                      {s.id} @ {s.offset}:{" "}
                    </span>
                    {s.data}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      {(rule.sha256 || rule.quarantinedTo || rule.quarantineFailed) && (
        <div className="mt-4 grid gap-4 border-t pt-4 sm:grid-cols-2">
          {rule.sha256 && (
            <div className="sm:col-span-2">
              {label(t("securityThreatDetail.rule.sha256"))}
              <div className="flex items-center gap-2">
                <p data-testid="threat-rule-sha256" className="break-all font-mono text-xs">
                  {rule.sha256}
                </p>
                <button
                  type="button"
                  data-testid="threat-rule-sha256-copy"
                  onClick={() => void copySha()}
                  aria-label={t("securityThreatDetail.rule.copy")}
                  title={t("securityThreatDetail.rule.copy")}
                  className="shrink-0 rounded-md border p-1.5 hover:bg-muted"
                >
                  {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                </button>
              </div>
            </div>
          )}
          {rule.quarantinedTo && (
            <div data-testid="threat-rule-quarantined-to" className="sm:col-span-2">
              {label(t("securityThreatDetail.rule.quarantinedTo"))}
              <p className="break-all font-mono text-xs">{rule.quarantinedTo}</p>
            </div>
          )}
          {rule.quarantineFailed && (
            <p data-testid="threat-rule-quarantine-failed" role="alert" className="text-sm font-medium text-destructive sm:col-span-2">
              {t("securityThreatDetail.rule.quarantineFailed")}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
