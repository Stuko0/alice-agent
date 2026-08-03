"""Resolve ALICE_HOME for standalone skill scripts.

Skill scripts may run outside the Alice process (e.g. system Python,
nix env, CI) where ``alice_constants`` is not importable.  This module
provides the same ``get_alice_home()`` and ``display_alice_home()``
contracts as ``alice_constants`` without requiring it on ``sys.path``.

When ``alice_constants`` IS available it is used directly so that any
future enhancements (profile resolution, Docker detection, etc.) are
picked up automatically.  The fallback path replicates the core logic
from ``alice_constants.py`` using only the stdlib.

All scripts under ``google-workspace/scripts/`` should import from here
instead of duplicating the ``ALICE_HOME = Path(os.getenv(...))`` pattern.
"""

from __future__ import annotations

import os
from pathlib import Path

try:
    from alice_constants import display_alice_home as display_alice_home
    from alice_constants import get_alice_home as get_alice_home
except (ModuleNotFoundError, ImportError):

    def get_alice_home() -> Path:
        """Return the Alice home directory (default: ~/.alice).

        Mirrors ``alice_constants.get_alice_home()``."""
        val = os.environ.get("ALICE_HOME", "").strip()
        return Path(val) if val else Path.home() / ".alice"

    def display_alice_home() -> str:
        """Return a user-friendly ``~/``-shortened display string.

        Mirrors ``alice_constants.display_alice_home()``."""
        home = get_alice_home()
        try:
            return "~/" + str(home.relative_to(Path.home()))
        except ValueError:
            return str(home)
