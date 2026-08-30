"""Cron-test fixtures.

Provides a default ``ALICE_MODEL`` for cron run_job tests so each one
doesn't have to spell out a model. The global conftest blanks
ALICE_MODEL hermetically; without this autouse fixture every cron test
that exercises ``run_job`` would hit the fail-fast guard added in
``cron/scheduler.py`` (see issue #23979) and have to be rewritten.

Tests that specifically need ``ALICE_MODEL`` unset — model-resolution
edge cases — call ``monkeypatch.delenv("ALICE_MODEL", raising=False)``
inside the test, which overrides this fixture's value for that scope.
"""

import pytest


@pytest.fixture(autouse=True)
def _default_cron_test_model(monkeypatch):
    """Pin a default ALICE_MODEL so cron run_job tests have a resolvable model."""
    monkeypatch.setenv("ALICE_MODEL", "test-cron-default-model")
    yield
