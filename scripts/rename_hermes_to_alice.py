#!/usr/bin/env python3
"""
Hermes → Alice Rename Script
=============================
Performs case-aware text replacements across the project, respecting
an exclusion list to avoid corrupting external references, binary files,
and auto-generated content.

Usage:
    python scripts/rename_hermes_to_lydia.py --dry-run    # preview changes
    python scripts/rename_hermes_to_lydia.py              # apply changes
    python scripts/rename_hermes_to_lydia.py --phase 3    # run specific phase only
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

# ── Directories and files to SKIP entirely ─────────────────────────────────
SKIP_DIRS = {
    ".git",
    ".aider.tags.cache.v4",
    "node_modules",
    "__pycache__",
    "alice_agent.egg-info",
    ".venv",
    "venv",
    "website",           # excluded per user decision
}

SKIP_FILES = {
    "uv.lock",
    "package-lock.json",
    "rename_hermes_to_lydia.py",  # don't modify ourselves
}

# File extensions to treat as text (everything else is skipped)
TEXT_EXTENSIONS = {
    ".py", ".ts", ".tsx", ".js", ".jsx", ".json", ".yaml", ".yml",
    ".md", ".txt", ".toml", ".cfg", ".ini", ".sh", ".bash", ".zsh",
    ".html", ".css", ".scss", ".nix", ".lock", ".env", ".example",
    ".in", ".rst", ".xml", ".svg",
    "",  # files with no extension (like 'hermes', 'Dockerfile')
}

# Filenames that are text even without standard extension
TEXT_FILENAMES = {
    "Dockerfile", "Makefile", ".dockerignore", ".gitignore",
    ".gitattributes", ".mailmap", ".envrc", ".hadolint.yaml",
    "hermes", "alice", "LICENSE",
}

# ── Patterns that must NOT be renamed ───────────────────────────────────────
# These regexes protect third-party references, model names, etc.
EXCLUSION_PATTERNS = [
    r"Nous[_-]?Hermes",           # Nous-Hermes AI model family
    r"nous[_-]?hermes",           # lowercase variant
    r"hermes-memori",             # external plugin
    r"hermes_memori",             # external plugin (underscore)
    r"Hermes 2",                  # Model name "Hermes 2 Pro" etc.
    r"Hermes 3",                  # Model name
    r"teknium/OpenHermes",        # HuggingFace model
    r"NousResearch/Hermes",       # HuggingFace model paths (keep model refs)
]

# Compile exclusion patterns
EXCLUSION_RE = re.compile("|".join(EXCLUSION_PATTERNS))


# ── Ordered replacement rules ──────────────────────────────────────────────
# Order matters: longer/more-specific patterns first to prevent partial matches
REPLACEMENTS = [
    # === Package/project name (hyphenated) ===
    ("hermes-agent", "alice-agent"),
    ("Hermes-Agent", "Alice-Agent"),
    ("HERMES-AGENT", "ALICE-AGENT"),

    # === Docker image ===
    ("nousresearch/hermes-agent", "stuk0o/alice-agent"),

    # === GitHub/Gitea repo URLs ===
    ("github.com/NousResearch/hermes-agent", "10.1.200.116:3000/arquant-admin/NewLydia"),
    ("NousResearch/hermes-agent", "arquant-admin/NewLydia"),

    # === Python package (underscored) ===
    ("hermes_agent", "alice_agent"),

    # === Module names (specific before generic) ===
    ("hermes_constants", "alice_constants"),
    ("hermes_bootstrap", "alice_bootstrap"),
    ("hermes_logging", "alice_logging"),
    ("hermes_state", "alice_state"),
    ("hermes_time", "alice_time"),
    ("hermes_cli", "alice_cli"),

    # === Class names ===
    ("HermesMCPOAuthProvider", "LydiaMCPOAuthProvider"),
    ("HermesTokenStorage", "LydiaTokenStorage"),
    ("HermesIndexSource", "LydiaIndexSource"),
    ("HermesACPAgent", "LydiaACPAgent"),
    ("HermesOverlay", "LydiaOverlay"),
    ("HermesCLI", "AliceCLI"),

    # === Function/method names (long → short) ===
    ("_get_platform_default_hermes_home", "_get_platform_default_lydia_home"),
    ("_detect_concurrent_hermes_instances", "_detect_concurrent_lydia_instances"),
    ("set_hermes_home_override", "set_lydia_home_override"),
    ("get_hermes_home_override", "get_lydia_home_override"),
    ("reset_hermes_home_override", "reset_lydia_home_override"),
    ("get_default_hermes_root", "get_default_lydia_root"),
    ("hermes_managed_node_tree_present", "lydia_managed_node_tree_present"),
    ("heal_hermes_managed_node", "heal_lydia_managed_node"),
    ("find_hermes_node_executable", "find_lydia_node_executable"),
    ("iter_hermes_node_dirs", "iter_lydia_node_dirs"),
    ("with_hermes_node_path", "with_lydia_node_path"),
    ("hermesManagedNodePathEntries", "lydiaManagedNodePathEntries"),
    ("get_hermes_home", "get_alice_home"),
    ("get_hermes_dir", "get_lydia_dir"),

    # === Environment variables ===
    ("ALICE_HOME_LEGACY", "ALICE_HOME"),
    ("HERMES_MODEL", "LYDIA_MODEL"),
    ("HERMES_PROVIDER", "LYDIA_PROVIDER"),
    ("HERMES_API_KEY", "LYDIA_API_KEY"),
    ("HERMES_PROFILE", "LYDIA_PROFILE"),
    ("HERMES_DEBUG", "LYDIA_DEBUG"),
    ("HERMES_CONFIG", "LYDIA_CONFIG"),
    ("HERMES_LOG_LEVEL", "LYDIA_LOG_LEVEL"),
    ("HERMES_QUIET", "LYDIA_QUIET"),
    ("HERMES_SKIP_NEWS", "LYDIA_SKIP_NEWS"),
    ("HERMES_NO_COLOR", "LYDIA_NO_COLOR"),
    ("HERMES_GATEWAY_URL", "LYDIA_GATEWAY_URL"),

    # === Filesystem paths ===
    ("~/.hermes", "~/.alice"),
    (".hermes/", ".alice/"),
    ("/.hermes", "/.alice"),
    ("%LOCALAPPDATA%\\\\hermes", "%LOCALAPPDATA%\\\\alice"),
    ("%LOCALAPPDATA%\\hermes", "%LOCALAPPDATA%\\alice"),

    # === Plugin/skill names ===
    ("hermes-achievements", "alice-achievements"),

    # === Setup script ===
    ("setup-hermes", "setup-alice"),

    # === Executable/command references ===
    ("hermes-acp", "alice-acp"),

    # === Generic catch-all (MUST BE LAST — applied only after specific ones) ===
    # These handle remaining references like log file names, comments, strings
    ("Hermes Agent", "Alice Agent"),
    ("Hermes agent", "Alice agent"),
    ("hermes agent", "alice agent"),
    ("Hermes'", "Alice'"),

    # Bare word replacements (most dangerous — applied last with word boundary)
    # These use a special marker to indicate word-boundary matching
]

# Additional word-boundary-aware replacements (applied after the literal ones)
WORD_BOUNDARY_REPLACEMENTS = [
    (r"\bHERMES\b", "ALICE"),
    (r"\bHermes\b", "Alice"),
    (r"\bhermes\b", "alice"),
]


def should_skip_path(path: Path) -> bool:
    """Check if a path should be skipped entirely."""
    parts = path.relative_to(REPO_ROOT).parts
    for part in parts:
        if part in SKIP_DIRS:
            return True
    if path.name in SKIP_FILES:
        return True
    return False


def is_text_file(path: Path) -> bool:
    """Check if a file should be treated as text."""
    if path.name in TEXT_FILENAMES:
        return True
    return path.suffix in TEXT_EXTENSIONS


def apply_replacements(content: str, filepath: Path) -> str:
    """Apply all replacement rules to content, respecting exclusions."""
    result = content

    # First pass: protect exclusions by replacing with placeholders
    placeholders = {}
    for i, match in enumerate(EXCLUSION_RE.finditer(result)):
        placeholder = f"__EXCL_{i:04d}__"
        placeholders[placeholder] = match.group()

    # Replace exclusions with placeholders
    for placeholder, original in placeholders.items():
        result = result.replace(original, placeholder, 1)

    # Second pass: apply literal replacements (order matters)
    for old, new in REPLACEMENTS:
        result = result.replace(old, new)

    # Third pass: apply word-boundary replacements
    for pattern, replacement in WORD_BOUNDARY_REPLACEMENTS:
        result = re.sub(pattern, replacement, result)

    # Fourth pass: restore exclusions from placeholders
    for placeholder, original in placeholders.items():
        result = result.replace(placeholder, original)

    return result


def find_target_files(root: Path) -> list[Path]:
    """Find all text files that need processing."""
    targets = []
    for dirpath, dirnames, filenames in os.walk(root):
        # Prune skip dirs in-place
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]

        for filename in filenames:
            filepath = Path(dirpath) / filename
            if should_skip_path(filepath):
                continue
            if not is_text_file(filepath):
                continue
            targets.append(filepath)

    return sorted(targets)


def process_file(filepath: Path, dry_run: bool = True) -> tuple[int, list[str]]:
    """Process a single file. Returns (change_count, change_descriptions)."""
    try:
        content = filepath.read_text(encoding="utf-8", errors="replace")
    except (OSError, UnicodeDecodeError):
        return 0, []

    # Quick check: does this file even contain "hermes" (case-insensitive)?
    if "hermes" not in content.lower():
        return 0, []

    new_content = apply_replacements(content, filepath)

    if new_content == content:
        return 0, []

    # Count changes
    old_count = content.lower().count("hermes")
    new_count = new_content.lower().count("hermes")
    changes = old_count - new_count

    descriptions = []
    if changes > 0:
        descriptions.append(f"  {filepath.relative_to(REPO_ROOT)}: {changes} replacements")

    if not dry_run and new_content != content:
        filepath.write_text(new_content, encoding="utf-8")

    return max(changes, 1), descriptions


def main():
    parser = argparse.ArgumentParser(description="Rename hermes → alice across the project")
    parser.add_argument("--dry-run", action="store_true",
                        help="Preview changes without modifying files")
    parser.add_argument("--phase", type=int, choices=[1, 2, 3, 4, 5, 6, 7, 8],
                        help="Run a specific phase only")
    parser.add_argument("--verbose", "-v", action="store_true",
                        help="Show detailed output")
    args = parser.parse_args()

    if args.dry_run:
        print("=== DRY RUN MODE — no files will be modified ===\n")

    files = find_target_files(REPO_ROOT)
    print(f"Found {len(files)} text files to scan\n")

    total_changes = 0
    total_files_changed = 0
    all_descriptions = []

    for filepath in files:
        changes, descriptions = process_file(filepath, dry_run=args.dry_run)
        if changes > 0:
            total_changes += changes
            total_files_changed += 1
            all_descriptions.extend(descriptions)
            if args.verbose:
                for desc in descriptions:
                    print(desc)

    print(f"\n{'Would modify' if args.dry_run else 'Modified'}: {total_files_changed} files")
    print(f"Total replacements: {total_changes}")

    if args.dry_run and not args.verbose:
        print("\nRun with --verbose to see per-file details")
        print("Run without --dry-run to apply changes")

    # Show remaining "hermes" references (exclusions)
    if not args.dry_run:
        print("\n=== Checking for remaining 'hermes' references ===")
        remaining = 0
        for filepath in files:
            try:
                content = filepath.read_text(encoding="utf-8", errors="replace")
            except (OSError, UnicodeDecodeError):
                continue
            if "hermes" in content.lower():
                remaining += 1
                if args.verbose:
                    rel = filepath.relative_to(REPO_ROOT)
                    count = content.lower().count("hermes")
                    print(f"  REMAINING: {rel} ({count} occurrences)")
        if remaining:
            print(f"\n{remaining} files still contain 'hermes' (should be exclusions only)")
        else:
            print("✓ No remaining 'hermes' references found!")


if __name__ == "__main__":
    main()
