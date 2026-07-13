import { i18n } from "@/lib/i18n";

// OS quick-start presets for file-mode backups. Paths that don't exist on a
// device are stat-skipped by the agent, so presets are safe to combine for
// mixed-OS fleets (agent/internal/backup/backup.go collectBackupFilesFromPaths).
export type BackupOsPreset = {
  id: "windows" | "macos" | "linux";
  title: string;
  summary: string;
  paths: string[];
  excludes: string[];
};

export const createOsPresets = (): BackupOsPreset[] => [
  {
    id: "windows",
    title: i18n.t(
      "policies:configurationPolicies.featureTabs.backupTab.presetWindowsTitle",
    ),
    summary: i18n.t(
      "policies:configurationPolicies.featureTabs.backupTab.presetWindowsSummary",
    ),
    paths: ["C:\\Users"],
    excludes: [
      "**/AppData/Local/Temp/**",
      "**/AppData/Local/Microsoft/Windows/INetCache/**",
      "$RECYCLE.BIN/**",
      "Thumbs.db",
      "*.tmp",
    ],
  },
  {
    id: "macos",
    title: i18n.t(
      "policies:configurationPolicies.featureTabs.backupTab.presetMacosTitle",
    ),
    summary: i18n.t(
      "policies:configurationPolicies.featureTabs.backupTab.presetMacosSummary",
    ),
    paths: ["/Users"],
    excludes: [
      "**/Library/Caches/**",
      "**/.Trash/**",
      ".DS_Store",
      "**/Library/Application Support/MobileSync/Backup/**",
    ],
  },
  {
    id: "linux",
    title: i18n.t(
      "policies:configurationPolicies.featureTabs.backupTab.presetLinuxTitle",
    ),
    summary: i18n.t(
      "policies:configurationPolicies.featureTabs.backupTab.presetLinuxSummary",
    ),
    paths: ["/home", "/etc"],
    excludes: ["**/.cache/**", "**/.local/share/Trash/**", "*.tmp"],
  },
];

// Suggested exclusion chips, grouped by platform. Cloud-synced folders
// (OneDrive, Dropbox) are deliberately suggestions rather than preset
// defaults: silently skipping user files is a restore-day surprise.
export type ExclusionSuggestionGroup = {
  id: "general" | "windows" | "macos" | "linux";
  label: string;
  items: { pattern: string; label: string }[];
};

export const createExclusionGroups = (): ExclusionSuggestionGroup[] => [
  {
    id: "general",
    label: i18n.t(
      "policies:configurationPolicies.featureTabs.backupTab.exclusionsGeneral",
    ),
    items: [
      {
        pattern: "*.tmp",
        label: i18n.t(
          "policies:configurationPolicies.featureTabs.backupTab.tempFiles",
        ),
      },
      {
        pattern: "*.log",
        label: i18n.t(
          "policies:configurationPolicies.featureTabs.backupTab.logFiles",
        ),
      },
      {
        pattern: "node_modules/**",
        label: i18n.t(
          "policies:configurationPolicies.featureTabs.backupTab.nodeModules",
        ),
      },
      {
        pattern: "**/Dropbox/**",
        label: i18n.t(
          "policies:configurationPolicies.featureTabs.backupTab.dropboxFolders",
        ),
      },
    ],
  },
  {
    id: "windows",
    label: i18n.t(
      "policies:configurationPolicies.featureTabs.backupTab.exclusionsWindows",
    ),
    items: [
      {
        pattern: "$RECYCLE.BIN/**",
        label: i18n.t(
          "policies:configurationPolicies.featureTabs.backupTab.recycleBin",
        ),
      },
      {
        pattern: "Thumbs.db",
        label: i18n.t(
          "policies:configurationPolicies.featureTabs.backupTab.thumbsDb",
        ),
      },
      {
        pattern: "**/AppData/Local/Temp/**",
        label: i18n.t(
          "policies:configurationPolicies.featureTabs.backupTab.appDataTemp",
        ),
      },
      {
        pattern: "**/AppData/Local/Microsoft/Windows/INetCache/**",
        label: i18n.t(
          "policies:configurationPolicies.featureTabs.backupTab.browserCaches",
        ),
      },
      {
        pattern: "**/OneDrive*/**",
        label: i18n.t(
          "policies:configurationPolicies.featureTabs.backupTab.oneDriveFolders",
        ),
      },
    ],
  },
  {
    id: "macos",
    label: i18n.t(
      "policies:configurationPolicies.featureTabs.backupTab.exclusionsMacos",
    ),
    items: [
      {
        pattern: "**/Library/Caches/**",
        label: i18n.t(
          "policies:configurationPolicies.featureTabs.backupTab.libraryCaches",
        ),
      },
      {
        pattern: "**/.Trash/**",
        label: i18n.t(
          "policies:configurationPolicies.featureTabs.backupTab.trashFolders",
        ),
      },
      {
        pattern: ".DS_Store",
        label: i18n.t(
          "policies:configurationPolicies.featureTabs.backupTab.dsStoreFiles",
        ),
      },
      {
        pattern: "**/Library/Application Support/MobileSync/Backup/**",
        label: i18n.t(
          "policies:configurationPolicies.featureTabs.backupTab.iphoneBackups",
        ),
      },
    ],
  },
  {
    id: "linux",
    label: i18n.t(
      "policies:configurationPolicies.featureTabs.backupTab.exclusionsLinux",
    ),
    items: [
      {
        pattern: "**/.cache/**",
        label: i18n.t(
          "policies:configurationPolicies.featureTabs.backupTab.userCaches",
        ),
      },
      {
        pattern: "**/.local/share/Trash/**",
        label: i18n.t(
          "policies:configurationPolicies.featureTabs.backupTab.trashFolders",
        ),
      },
      {
        pattern: "*.swp",
        label: i18n.t(
          "policies:configurationPolicies.featureTabs.backupTab.swapFiles",
        ),
      },
    ],
  },
];
