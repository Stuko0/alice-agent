"""Conformance tests for ``tools.registry_protocol.ToolRegistryProtocol``.

These assert the relationship between the protocol and the concrete registry
(every declared member exists and is callable, and the real class satisfies
the structural check), not any particular set of tool names.
"""

import inspect

from tools.registry import ToolRegistry
from tools.registry_protocol import ToolRegistryProtocol


def _protocol_members():
    return [
        name
        for name, value in vars(ToolRegistryProtocol).items()
        if callable(value) and not name.startswith("_")
    ]


def test_concrete_registry_satisfies_protocol():
    assert isinstance(ToolRegistry(), ToolRegistryProtocol)


def test_every_protocol_member_is_implemented_by_registry():
    for name in _protocol_members():
        assert callable(getattr(ToolRegistry, name, None)), name


def test_protocol_signatures_are_compatible_with_registry():
    # Parameter names must match, so keyword calls through the protocol work
    # against the concrete class.
    for name in _protocol_members():
        proto_params = list(inspect.signature(getattr(ToolRegistryProtocol, name)).parameters)
        impl_params = list(inspect.signature(getattr(ToolRegistry, name)).parameters)
        assert proto_params[0] == "self" and impl_params[0] == "self", name
        assert proto_params[1:] == impl_params[1:][: len(proto_params) - 1], name


def test_protocol_dispatch_round_trips_through_registry():
    reg = ToolRegistry()
    reg.register(
        name="proto_probe",
        toolset="proto_probe",
        schema={"name": "proto_probe", "description": "d", "parameters": {"type": "object", "properties": {}}},
        handler=lambda args, **kw: '{"ok": true}',
    )
    tool: ToolRegistryProtocol = reg
    assert tool.get_toolset_for_tool("proto_probe") == "proto_probe"
    assert "proto_probe" in tool.get_all_tool_names()
    assert tool.dispatch("proto_probe", {}) == '{"ok": true}'
    tool.deregister("proto_probe")
    assert tool.get_entry("proto_probe") is None
