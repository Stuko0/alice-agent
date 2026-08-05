"""Task-scoped help: "¿cómo hago X?" → the exact doc page.

A small curated index maps everyday tasks to markdown files under
``website/docs/``. The desktop Help panel and ``alice help <task>`` share
this index, so a task added here shows up in both surfaces.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Optional

DOCS_ROOT = Path(__file__).resolve().parents[1] / "website" / "docs"

# task id → (title, one-line description, doc file relative to website/docs/)
_HELP_TASKS: dict[str, tuple[str, str, str]] = {
    "add-provider": (
        "Add a model provider",
        "Connect OpenAI, Anthropic, OpenRouter or a custom endpoint.",
        "user-guide/configuring-models.md",
    ),
    "custom-provider": (
        "Add a custom provider (any OpenAI-compatible endpoint)",
        "Register an endpoint manually — Together, Groq, local Ollama, …",
        "user-guide/configuring-models.md",
    ),
    "first-run": (
        "First run / quick setup",
        "Install Alice and get your first model working without a terminal.",
        "getting-started/quickstart.md",
    ),
    "windows": (
        "Windows setup",
        "Run Alice on Windows — native or WSL2.",
        "getting-started/windows-native.md",
    ),
    "backup": (
        "Backup and restore",
        "Snapshot ~/.alice and roll back after a bad update.",
        "user-guide/checkpoints-and-rollback.md",
    ),
    "sessions": (
        "Conversations (sessions)",
        "Resume, archive and search your chat history.",
        "user-guide/sessions.md",
    ),
    "telegram": (
        "Connect Telegram",
        "Chat with Alice from Telegram.",
        "user-guide/multi-profile-gateways.md",
    ),
    "voice": (
        "Voice mode",
        "Talk to Alice with speech.",
        "guides/use-voice-mode-with-alice.md",
    ),
    "update": (
        "Update Alice",
        "Install the latest version and see what changed.",
        "getting-started/updating.md",
    ),
    "cli": (
        "CLI reference",
        "Every alice command, explained.",
        "user-guide/cli.md",
    ),
    "terminal-backend": (
        "Terminal / tool execution",
        "Which terminal backend Alice uses for tools, and how to change it.",
        "user-guide/desktop.md",
    ),
}


@dataclass(frozen=True)
class HelpTask:
    id: str
    title: str
    description: str
    doc_path: Path


def list_tasks() -> list[HelpTask]:
    """All indexed help tasks, in registration order."""
    return [
        HelpTask(id=tid, title=title, description=desc, doc_path=DOCS_ROOT / rel)
        for tid, (title, desc, rel) in _HELP_TASKS.items()
    ]


def get_task(task_id: str) -> Optional[HelpTask]:
    """Look up a task by id (case-insensitive); None when unknown."""
    target = task_id.strip().lower()
    for task in list_tasks():
        if task.id == target:
            return task
    return None


def task_markdown(task: HelpTask, max_chars: int = 24_000) -> Optional[str]:
    """Read + trim the task's doc file to renderable markdown.

    Returns None when the file is missing — the UI shows a fallback link to
    the docs site instead of a dead panel.
    """
    if not task.doc_path.exists():
        return None
    text = task.doc_path.read_text(encoding="utf-8", errors="replace")
    # Cut to a sane panel size, preferring a heading boundary.
    if len(text) > max_chars:
        text = text[:max_chars]
        last_newline = text.rfind("\n")
        if last_newline > 0:
            text = text[:last_newline]
        text += "\n\n…"
    return text
