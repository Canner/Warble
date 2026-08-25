#!/usr/bin/env python3
"""Replay deterministic actions through the pinned official ADK callbacks/tools.

This file contains transport and import adapters only. Budget, phase, reward, dialogue,
and tool observations are produced by the official sources at PINNED_COMMIT.
"""

from __future__ import annotations

import argparse
import asyncio
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
from types import ModuleType, SimpleNamespace
from typing import Any
from urllib.parse import urlparse


sys.dont_write_bytecode = True


PINNED_COMMIT = "451fe2c3518ee1cf908d8139e2913483bd519381"
SOURCE_ROOT = "BIRD-Interact-ADK"


def _package(name: str) -> ModuleType:
    module = ModuleType(name)
    module.__path__ = []  # type: ignore[attr-defined]
    sys.modules[name] = module
    if "." in name:
        parent_name, child_name = name.rsplit(".", 1)
        parent = sys.modules[parent_name]
        setattr(parent, child_name, module)
    return module


def _module(name: str) -> ModuleType:
    module = ModuleType(name)
    sys.modules[name] = module
    if "." in name:
        parent_name, child_name = name.rsplit(".", 1)
        parent = sys.modules[parent_name]
        setattr(parent, child_name, module)
    return module


class _Context:
    def __init__(self, state: dict[str, Any]):
        self.state = state


class _NamedTool:
    def __init__(self, name: str):
        self.name = name


class _FunctionTool:
    def __init__(self, function):
        self.function = function
        self.name = function.__name__


class _Placeholder:
    def __init__(self, *args, **kwargs):
        self.args = args
        self.kwargs = kwargs

    @classmethod
    def from_text(cls, **kwargs):
        return cls(**kwargs)


ACTIVE_CASE: dict[str, Any] | None = None
POST_CALLS: list[dict[str, Any]] = []


class _Response:
    def __init__(self, payload: dict[str, Any], status_code: int = 200):
        self._payload = payload
        self.status_code = status_code
        self.text = json.dumps(payload)

    def json(self) -> dict[str, Any]:
        return self._payload


class _HttpxClient:
    def __init__(self, *args, **kwargs):
        pass

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        return False

    def post(self, url: str, json: dict[str, Any]):
        if ACTIVE_CASE is None:
            raise RuntimeError("reference driver has no active case")
        path = urlparse(url).path
        POST_CALLS.append({"path": path, "json": json})
        if isinstance(ACTIVE_CASE["response"].get("_raise"), str):
            raise RuntimeError(ACTIVE_CASE["response"]["_raise"])
        if path == "/phase_transition":
            return _Response({"status": "ok"})
        payload = ACTIVE_CASE["response"]
        return _Response(payload, int(payload.get("_status_code", 200)))


def _install_import_stubs() -> None:
    _package("google")
    _package("google.adk")
    _package("google.adk.agents")
    callback_context = _module("google.adk.agents.callback_context")
    callback_context.CallbackContext = _Context

    _package("google.adk.models")
    llm_request = _module("google.adk.models.llm_request")
    llm_request.LlmRequest = _Placeholder
    llm_response = _module("google.adk.models.llm_response")
    llm_response.LlmResponse = _Placeholder

    adk_tools = _package("google.adk.tools")
    adk_tools.FunctionTool = _FunctionTool
    tool_context = _module("google.adk.tools.tool_context")
    tool_context.ToolContext = _Context

    genai = _package("google.genai")
    genai_types = _module("google.genai.types")
    genai_types.Content = _Placeholder
    genai_types.Part = _Placeholder
    genai.types = genai_types

    shared = _package("shared")
    shared_config = _module("shared.config")
    shared_config.settings = SimpleNamespace(db_env_port=6002, user_sim_port=6001)
    shared.config = shared_config

    httpx = _module("httpx")
    httpx.Client = _HttpxClient


def _load(name: str, path: Path) -> ModuleType:
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load official source: {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def _normalize_observation(tool: str, value: Any) -> str:
    return str(value)


def _model_response_text(response: Any) -> str | None:
    if response is None:
        return None
    content = response.kwargs["content"]
    part = content.kwargs["parts"][0]
    return str(part.kwargs["text"])


def _verify_checkout(checkout: Path) -> Path:
    if not checkout.is_dir():
        raise RuntimeError(f"official checkout is not a directory: {checkout}")
    result = subprocess.run(
        ["git", "-C", str(checkout), "rev-parse", "HEAD"],
        check=True,
        capture_output=True,
        text=True,
    )
    head = result.stdout.strip()
    if head != PINNED_COMMIT:
        raise RuntimeError(f"official checkout HEAD is {head}; expected {PINNED_COMMIT}")
    source = (checkout / SOURCE_ROOT).resolve()
    if source.parent != checkout.resolve():
        raise RuntimeError("official source root escaped checkout")
    for relative in ("system_agent/callbacks.py", "system_agent/tools.py"):
        if not (source / relative).is_file():
            raise RuntimeError(f"missing pinned official source: {relative}")
    return source


def _replay(callbacks: ModuleType, tools: ModuleType, fixture: dict[str, Any]) -> list[dict[str, Any]]:
    global ACTIVE_CASE, POST_CALLS
    output: list[dict[str, Any]] = []
    for case in fixture["cases"]:
        state = json.loads(json.dumps(fixture["base_state"]))
        state.update(json.loads(json.dumps(case.get("state", {}))))
        state["dialogue_history"] = []
        state["tool_trajectory"] = []
        state["adk_events"] = []
        context = _Context(state)
        named_tool = _NamedTool(case["tool"])
        args = case["args"]
        ACTIVE_CASE = case
        POST_CALLS = []

        rejected_response = asyncio.run(
            callbacks.before_tool_callback(named_tool, args, context)
        )
        if rejected_response is not None:
            observation = rejected_response["error"]
            rejected = True
            cost = 0
        else:
            function = getattr(tools, case["tool"])
            tool_response = function(**args, tool_context=context)
            after_response = asyncio.run(
                callbacks.after_tool_callback(
                    named_tool, args, context, tool_response
                )
            )
            observation = after_response if after_response is not None else tool_response
            rejected = False
            trajectory = state.get("tool_trajectory", [])
            cost = trajectory[-1]["cost"] if trajectory else 0

        terminal_response = asyncio.run(
            callbacks.before_model_callback(context, _Placeholder())
        )
        output.append({
            "id": case["id"],
            "observation": _normalize_observation(case["tool"], observation),
            "executed": len(POST_CALLS) > 0,
            "post_calls": POST_CALLS,
            "rejected": rejected,
            "cost": cost,
            "trajectory_result": (
                state["tool_trajectory"][-1]["result"]
                if state.get("tool_trajectory")
                else None
            ),
            "budget_remaining": state["budget_remaining"],
            "current_phase": state["current_phase"],
            "phase1_completed": state["phase1_completed"],
            "phase2_completed": state["phase2_completed"],
            "total_reward": state["total_reward"],
            "dialogue_history": state["dialogue_history"],
            "task_done": bool(state["task_done"]),
            "terminal_observation": _model_response_text(terminal_response),
            "model_turns": state.get("model_turns"),
        })
    combined_state = json.loads(json.dumps(fixture["base_state"]))
    combined_state.update({
        "task_done": True,
        "budget_remaining": -1,
        "model_turns": 60,
    })
    combined_response = asyncio.run(
        callbacks.before_model_callback(_Context(combined_state), _Placeholder())
    )
    output.append({
        "id": "model_limit_precedes_terminal_state",
        "terminal_observation": _model_response_text(combined_response),
        "model_turns": combined_state.get("model_turns"),
    })
    ACTIVE_CASE = None
    return output


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--official-checkout", required=True, type=Path)
    parser.add_argument("--actions", required=True, type=Path)
    args = parser.parse_args()

    source = _verify_checkout(args.official_checkout.resolve())
    fixture = json.loads(args.actions.read_text(encoding="utf-8"))
    _install_import_stubs()
    callbacks = _load("official_bird_callbacks", source / "system_agent/callbacks.py")
    tools = _load("official_bird_tools", source / "system_agent/tools.py")
    print(json.dumps(_replay(callbacks, tools, fixture), separators=(",", ":")))


if __name__ == "__main__":
    main()
