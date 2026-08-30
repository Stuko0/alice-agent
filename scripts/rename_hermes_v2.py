#!/usr/bin/env python3
"""
Hermes → Alice Rename Script v2
================================
Aggressive pass that catches ALL remaining hermes references including
compound identifiers like hermes_home, _hermes_bin, display_hermes_home etc.
"""

from __future__ import annotations

import os
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

SKIP_DIRS = {
    ".git", ".aider.tags.cache.v4", "node_modules", "__pycache__",
    "alice_agent.egg-info", ".venv", "venv", ".docusaurus", "build",
}

SKIP_FILES = {
    "uv.lock", "package-lock.json",
    "rename_hermes_to_alice.py", "rename_hermes_v2.py",
}

TEXT_EXTENSIONS = {
    ".py", ".ts", ".tsx", ".js", ".jsx", ".json", ".yaml", ".yml",
    ".md", ".mdx", ".txt", ".toml", ".cfg", ".ini", ".sh", ".bash", ".zsh",
    ".html", ".css", ".scss", ".nix", ".lock", ".env", ".example",
    ".in", ".rst", ".xml", ".svg", ".cjs", ".mjs", ".ps1", ".bat",
    ".cmd", ".rb", ".service", ".rs", ".tmpl",
    "",
}

TEXT_FILENAMES = {
    "Dockerfile", "Makefile", ".dockerignore", ".gitignore",
    ".gitattributes", ".mailmap", ".envrc", ".hadolint.yaml",
    "alice_entry", "alice", "LICENSE",
}

# Words/phrases that must be PROTECTED from replacement
# We mark them with unique tokens, do the replacement, then restore
PROTECT_PATTERNS = [
    # Model names
    (re.compile(r"Nous[_\- ]?Hermes", re.IGNORECASE), "__PROT_NOUS_HERMES__"),
    (re.compile(r"Stuko0/alice-agent"), "__PROT_NR_HERMES__"),
    (re.compile(r"teknium/OpenHermes"), "__PROT_OPEN_HERMES__"),
    # Hermes 2, Hermes 3 model names (but only when it's clearly a model name)
    (re.compile(r"Hermes (?:2|3)\b"), "__PROT_HERMES_MODEL__"),
]


def should_skip(path: Path) -> bool:
    parts = path.relative_to(REPO_ROOT).parts
    for part in parts:
        if part in SKIP_DIRS:
            return True
    if path.name in SKIP_FILES:
        return True
    return False


def is_text(path: Path) -> bool:
    if path.name in TEXT_FILENAMES:
        return True
    return path.suffix in TEXT_EXTENSIONS


def replace_hermes(content: str) -> str:
    """Replace ALL hermes variants with alice, protecting exclusions."""
    result = content

    # Step 1: Protect exclusions
    protections = []
    for pattern, token in PROTECT_PATTERNS:
        matches = list(pattern.finditer(result))
        for m in reversed(matches):
            protections.append((token, m.group()))
            result = result[:m.start()] + token + result[m.end():]

    # Step 2: Do replacements (order: specific long patterns before short generic)
    # GitHub URLs first
    result = result.replace("github.com/Stuko0/alice-agent", "10.1.200.116:3000/arquant-admin/NewAlice")
    result = result.replace("Stuko0/alice-agent", "arquant-admin/NewAlice")
    result = result.replace("nousresearch/alice-agent", "stuk0o/alice-agent")

    # Case-sensitive replacements using regex for word-level accuracy
    # UPPER
    result = re.sub(r"HERMES", "ALICE", result)
    # Title
    result = re.sub(r"Hermes", "Alice", result)
    # lower
    result = re.sub(r"hermes", "alice", result)

    # Step 3: Restore protections (reverse order to maintain positions)
    for token, original in reversed(protections):
        result = result.replace(token, original, 1)

    return result


def main():
    dry_run = "--dry-run" in sys.argv
    verbose = "--verbose" in sys.argv or "-v" in sys.argv

    # Get target paths from args, ignore flags
    targets = [arg for arg in sys.argv[1:] if not arg.startswith("-")]
    if not targets:
        targets = [str(REPO_ROOT)]

    if dry_run:
        print("=== DRY RUN ===\n")

    total_files = 0
    total_changes = 0

    for target_str in targets:
        target_path = Path(target_str).resolve()
        
        if target_path.is_file():
            files_to_process = [target_path]
        else:
            files_to_process = []
            for dirpath, dirnames, filenames in os.walk(target_path):
                # Filter out skip dirs from traversal
                dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
                for filename in filenames:
                    files_to_process.append(Path(dirpath) / filename)

        for filepath in files_to_process:
            if should_skip(filepath):
                continue
            if not is_text(filepath):
                continue

            try:
                content = filepath.read_text(encoding="utf-8", errors="replace")
            except (OSError, UnicodeDecodeError):
                continue

            if "hermes" not in content.lower():
                continue

            new_content = replace_hermes(content)
            if new_content != content:
                total_files += 1
                old_c = len(re.findall(r"hermes", content, re.IGNORECASE))
                new_c = len(re.findall(r"hermes", new_content, re.IGNORECASE))
                changes = old_c - new_c
                total_changes += max(changes, 0)
                if verbose:
                    rel = filepath.relative_to(REPO_ROOT)
                    print(f"  {rel}: {changes} replacements")
                if not dry_run:
                    filepath.write_text(new_content, encoding="utf-8")

    print(f"\n{'Would modify' if dry_run else 'Modified'}: {total_files} files")
    print(f"Total replacements: {total_changes}")

    # Show remaining
    if not dry_run:
        print("\n=== Checking remaining ===")
        remaining = 0
        for target_str in targets:
            target_path = Path(target_str).resolve()
            if target_path.is_file():
                files_to_check = [target_path]
            else:
                files_to_check = []
                for dirpath, dirnames, filenames in os.walk(target_path):
                    dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
                    for filename in filenames:
                        files_to_check.append(Path(dirpath) / filename)

            for filepath in files_to_check:
                if should_skip(filepath) or not is_text(filepath):
                    continue
                try:
                    content = filepath.read_text(encoding="utf-8", errors="replace")
                except (OSError, UnicodeDecodeError):
                    continue
                matches = re.findall(r"hermes", content, re.IGNORECASE)
                if matches:
                    remaining += 1
                    if verbose:
                        rel = filepath.relative_to(REPO_ROOT)
                        print(f"  REMAINING: {rel} ({len(matches)} occurrences)")
        print(f"\n{remaining} files still contain 'hermes'")


if __name__ == "__main__":
    main()
