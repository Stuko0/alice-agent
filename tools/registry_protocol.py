"""Protocol for the tool registry surface consumed by the agent loop.

``ToolRegistry`` (``tools/registry.py``) is the only implementation shipped
today. This module names the subset of its methods that the agent loop,
``model_tools`` and the plugin layer actually depend on, so that callers can
be typed against a contract instead of the concrete class, and so that a
future plugin-provided registry can be checked against the same contract.

It is purely declarative: nothing here is imported at runtime by the registry
itself, and no behaviour changes. Conformance is verified by
``tests/tools/test_registry_protocol.py``.
"""

from __future__ import annotations

from typing import Callable, Dict, List, Optional, Protocol, Set, runtime_checkable


@runtime_checkable
class ToolRegistryProtocol(Protocol):
    """Methods the agent loop depends on for tool registration and dispatch."""

    def register(
        self,
        name: str,
        toolset: str,
        schema: dict,
        handler: Callable,
        check_fn: Callable = ...,
        requires_env: list = ...,
        is_async: bool = False,
        description: str = "",
        emoji: str = "",
        max_result_size_chars=None,
        dynamic_schema_overrides: Callable = ...,
        override: bool = False,
    ): ...

    def deregister(self, name: str) -> None: ...

    def get_entry(self, name: str) -> Optional[object]: ...

    def get_definitions(self, tool_names: Set[str], quiet: bool = False) -> List[dict]: ...

    def dispatch(self, name: str, args: dict, **kwargs) -> str: ...

    def get_schema(self, name: str) -> Optional[dict]: ...

    def get_all_tool_names(self) -> List[str]: ...

    def get_toolset_for_tool(self, name: str) -> Optional[str]: ...

    def get_available_toolsets(self) -> Dict[str, dict]: ...

    def check_tool_availability(self, quiet: bool = False): ...

    def get_max_result_size(self, name: str, default=None): ...

    def get_emoji(self, name: str, default: str = "⚡") -> str: ...
