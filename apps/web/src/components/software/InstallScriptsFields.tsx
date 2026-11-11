import type { InstallSpecIssue } from "@breeze/shared";
import { cn } from "@/lib/utils";
import { i18n } from "@/lib/i18n";

// Literal template tokens, rendered outside translation strings (i18next would
// treat `{{...}}` as interpolation).
const INSTALL_SCRIPT_TOKENS = [
  "{{org.*}}",
  "{{site.*}}",
  "{{device.hostname}}",
  "{{device.customField.<key>}}",
  "{{var.<key>}}",
  "{{install.dir}}",
  "{{install.file}}",
] as const;

export function installSpecIssueMessage(code: InstallSpecIssue): string {
  switch (code) {
    case "zip_requires_post_install_script":
      return i18n.t("policies:software.addPackageModal.issueZipRequiresPostInstallScript");
    case "scripts_require_single_os":
      return i18n.t("policies:software.addPackageModal.issueScriptsRequireSingleOs");
    case "script_too_large":
      return i18n.t("policies:software.addPackageModal.issueScriptTooLarge");
    case "args_unsupported_for_file_type":
      return i18n.t("policies:software.addPackageModal.issueArgsUnsupportedForFileType");
  }
}

const labelCls = "text-xs font-semibold uppercase text-muted-foreground";

interface InstallScriptsFieldsProps {
  /** Prefix for the textarea ids, so two forms on one page never collide. */
  idPrefix: string;
  preInstallScript: string;
  postInstallScript: string;
  onPreInstallScriptChange?: (value: string) => void;
  onPostInstallScriptChange?: (value: string) => void;
  /** Client-side mirror of the API's install-spec rules (#6958). */
  issues?: InstallSpecIssue[];
  /** Shown instead of being editable — e.g. an existing version, whose
   *  scripts the PATCH route keeps immutable. */
  readOnly?: boolean;
  /** Rendered under the heading, e.g. why the scripts are read-only. */
  notice?: React.ReactNode;
}

/** Pre/post-install script editor shared by AddPackageModal and
 *  SoftwareVersionManager (#6958, #10037). */
export default function InstallScriptsFields({
  idPrefix,
  preInstallScript,
  postInstallScript,
  onPreInstallScriptChange,
  onPostInstallScriptChange,
  issues = [],
  readOnly = false,
  notice,
}: InstallScriptsFieldsProps) {
  const textareaCls = cn(
    "mt-1 w-full rounded-md border bg-background px-3 py-2 font-mono text-xs",
    readOnly && "bg-muted/40 text-muted-foreground",
  );
  return (
    <div data-testid="install-scripts">
      <span className={labelCls}>
        {i18n.t("policies:software.addPackageModal.installScripts")}
      </span>
      {notice}
      <p className="mt-1 text-xs text-muted-foreground">
        {i18n.t("policies:software.addPackageModal.installScriptsHelp")}
      </p>
      <p className="mt-1 flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
        {i18n.t("policies:software.addPackageModal.availableTokens")}
        {INSTALL_SCRIPT_TOKENS.map((t) => (
          <code key={t} className="rounded bg-muted px-1 font-mono">
            {t}
          </code>
        ))}
      </p>
      <label className={cn(labelCls, "mt-3 block")} htmlFor={`${idPrefix}-pre-install-script`}>
        {i18n.t("policies:software.addPackageModal.preInstallScript")}
      </label>
      <textarea
        id={`${idPrefix}-pre-install-script`}
        data-testid="pre-install-script"
        value={preInstallScript}
        onChange={(e) => onPreInstallScriptChange?.(e.target.value)}
        readOnly={readOnly}
        placeholder={
          readOnly
            ? undefined
            : i18n.t("policies:software.addPackageModal.preInstallScriptPlaceholder")
        }
        rows={4}
        spellCheck={false}
        className={textareaCls}
      />
      <label className={cn(labelCls, "mt-3 block")} htmlFor={`${idPrefix}-post-install-script`}>
        {i18n.t("policies:software.addPackageModal.postInstallScript")}
      </label>
      <textarea
        id={`${idPrefix}-post-install-script`}
        data-testid="post-install-script"
        value={postInstallScript}
        onChange={(e) => onPostInstallScriptChange?.(e.target.value)}
        readOnly={readOnly}
        placeholder={
          readOnly
            ? undefined
            : i18n.t("policies:software.addPackageModal.postInstallScriptPlaceholder")
        }
        rows={4}
        spellCheck={false}
        className={textareaCls}
      />
      {issues.map((code) => (
        <p
          key={code}
          role="alert"
          data-testid={`install-spec-issue-${code}`}
          className="mt-2 text-xs text-destructive"
        >
          {installSpecIssueMessage(code)}
        </p>
      ))}
    </div>
  );
}
