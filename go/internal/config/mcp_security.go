package config

import (
	"fmt"
	"path/filepath"
	"regexp"
	"strings"
)

// Port of alice_cli.mcp_security.validate_mcp_server_entry: three narrow abuse
// shapes plus a hardcoded alice-0day IOC blocklist.

var shellInterpreters = map[string]bool{
	"bash": true, "sh": true, "zsh": true, "dash": true, "fish": true,
	"cmd": true, "cmd.exe": true, "powershell": true, "powershell.exe": true,
	"pwsh": true, "pwsh.exe": true,
}

// Go's RE2 has no lookbehind, so the Python boundary assertions are expressed
// as explicit character classes/anchors.
var (
	egressPattern = regexp.MustCompile(`(?i)(^|[^\w.-])(curl|wget|nc|ncat|socat)([^\w.-]|$)` +
		`|/dev/tcp/|` +
		`\bInvoke-WebRequest\b|\bInvoke-RestMethod\b|\bSystem\.Net\.WebClient\b`)

	exfilHintPattern = regexp.MustCompile(`(?i)\.env\b|--data-binary|--data-raw|\b-X\s+POST\b|\bPOST\b|<\s*[^\s]+`)

	persistencePattern = regexp.MustCompile(`(?i)` +
		`authorized_keys|` +
		`\.ssh/|` +
		`/etc/ssh\b|` +
		`/etc/pam\.d\b|pam_[\w-]+\.so|` +
		`/etc/sudoers|` +
		`/etc/cron|crontab\b|` +
		`/etc/rc\.local|/etc/systemd|` +
		`\.bashrc\b|\.bash_profile\b|\.profile\b|\.zshrc\b`)
)

var mcpIOCs = []string{
	"AAAAC3NzaC1lZDI1NTE5AAAAICBoh1oDC4DnsO1m5mJ4yfEKrQebaFh",
	"alice-0day",
	"60.165.167.",
	"118.182.244.156",
	"61.178.123.196",
}

// ValidateMCPServerEntry returns warnings for a suspicious MCP entry; empty
// means nothing matched.
func ValidateMCPServerEntry(name string, entry map[string]any) []string {
	if entry == nil {
		return nil
	}

	flat := mcpEntryText(entry)
	for _, ioc := range mcpIOCs {
		if strings.Contains(flat, ioc) {
			return []string{fmt.Sprintf(
				"MCP server '%s' contains a known alice-0day indicator-of-compromise ('%s')",
				name, ioc,
			)}
		}
	}

	command := stringValue(entry["command"])
	base := commandBasename(command)
	if !shellInterpreters[base] {
		return nil
	}

	script := inlineScript(entry["args"])
	if script == "" {
		return nil
	}

	var issues []string
	if egressPattern.MatchString(script) {
		issue := fmt.Sprintf(
			"MCP server '%s' uses shell interpreter '%s' with network egress in args",
			name, command,
		)
		if exfilHintPattern.MatchString(script) {
			issue += " and exfiltration-shaped arguments"
		}
		issues = append(issues, issue)
	}

	if persistencePattern.MatchString(script) {
		issues = append(issues, fmt.Sprintf(
			"MCP server '%s' uses shell interpreter '%s' to write to an OS persistence surface (SSH keys / PAM / sudoers / cron / shell rc) — this is the alice-0day backdoor shape, not a real MCP server",
			name, command,
		))
	}

	return issues
}

// disableSuspiciousMCPServers mirrors migrate_config's post-migration step:
// keep the stanza for auditability but mark it disabled.
func (d *Document) disableSuspiciousMCPServers(result *MigrationResult) bool {
	raw, ok := d.Get("mcp_servers")
	if !ok {
		return false
	}
	servers, ok := raw.(map[string]any)
	if !ok {
		return false
	}

	touched := false
	for name, value := range servers {
		entry, ok := value.(map[string]any)
		if !ok {
			continue
		}
		if len(ValidateMCPServerEntry(name, entry)) == 0 {
			continue
		}
		entry["enabled"] = false
		servers[name] = entry
		touched = true
		result.Warnings = append(result.Warnings, fmt.Sprintf("Disabled suspicious MCP server '%s'", name))
	}

	if touched {
		_ = d.SetAny("mcp_servers", servers)
	}
	return touched
}

func mcpEntryText(entry map[string]any) string {
	parts := []string{stringValue(entry["command"])}
	parts = append(parts, inlineScript(entry["args"]))
	if env, ok := entry["env"].(map[string]any); ok {
		for _, value := range env {
			parts = append(parts, fmt.Sprint(value))
		}
	}
	return strings.Join(parts, " ")
}

func inlineScript(args any) string {
	switch typed := args.(type) {
	case nil:
		return ""
	case []any:
		parts := make([]string, 0, len(typed))
		for _, item := range typed {
			parts = append(parts, fmt.Sprint(item))
		}
		return strings.Join(parts, " ")
	case []string:
		return strings.Join(typed, " ")
	default:
		return fmt.Sprint(typed)
	}
}

func commandBasename(command string) string {
	text := strings.TrimSpace(command)
	if text == "" {
		return ""
	}
	first := strings.Fields(text)[0]
	first = strings.Trim(first, `"'`)
	return strings.ToLower(filepath.Base(first))
}
