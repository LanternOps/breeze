package selfuninstall

// AgentUpgradeCodes are the UpgradeCodes of the agent's MSI editions: Hosted
// and Self-Hosted (agent/installer/build-msi.ps1 $hostedUpgradeCode and
// $selfHostUpgradeCode, agent/installer/breeze.wxs). They never change; the
// ProductCode changes with every build, so the product to remove is looked up
// through these. Pinned to the installer by TestAgentUpgradeCodesMatchTheInstaller.
var AgentUpgradeCodes = []string{
	"{70A57B7A-4F72-4E18-B8D3-7D2783C2C1A9}", // Hosted
	"{787838E2-1A3E-4B61-8514-75DD922A6B1B}", // Self-Hosted
}
