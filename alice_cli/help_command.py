"""``alice help`` command handler (kept out of main.py)."""

from __future__ import annotations

import sys
from typing import Optional


def _print_topic_list() -> None:
    from alice_cli.help_tasks import list_tasks

    tasks = list_tasks()
    print("Alice help topics:")
    for t in tasks:
        print(f"  {t.id:<18} {t.title}")
        if t.description:
            print(f"{'':<20}{t.description}")
    print("\nOpen one with: alice help <topic>")


def _print_topic(topic: str) -> int:
    from alice_cli.help_tasks import get_task, task_markdown

    task = get_task(topic)
    if task is None:
        print(f"error: unknown help topic '{topic}'", file=sys.stderr)
        print("Run 'alice help' to list topics.", file=sys.stderr)
        return 1

    md = task_markdown(task)
    if md is None:
        print(f"error: doc file for '{topic}' is missing ({task.doc_path})", file=sys.stderr)
        return 1

    # Strip front-matter (--- … ---) if present, then print. Best-effort
    # pager: use $PAGER when set, else plain stdout.
    lines = md.splitlines()
    if lines and lines[0].strip() == "---":
        try:
            end = lines[1:].index("---") + 1
            lines = lines[end + 1 :]
        except ValueError:
            pass
    text = "\n".join(lines).strip()

    pager = _pick_pager()
    if pager:
        import subprocess

        proc = subprocess.run([pager], input=text, text=True)
        return proc.returncode or 0
    print(text)
    return 0


def _pick_pager() -> Optional[str]:
    import os

    pager = os.environ.get("PAGER") or ""
    if pager:
        return pager
    import shutil

    for candidate in ("less", "more"):
        if shutil.which(candidate):
            return candidate
    return None


def help_command(args) -> int:
    topic = getattr(args, "topic", None)
    if not topic:
        _print_topic_list()
        return 0
    return _print_topic(topic)
