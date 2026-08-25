#!/usr/bin/env python3
"""Replay deterministic actions through the pinned official ADK callbacks/tools.

This file contains transport and import adapters only. Budget, phase, reward, dialogue,
and tool observations are produced by the official sources at PINNED_COMMIT.

The ADK framework itself is stubbed rather than installed, so that this oracle needs nothing
from the network. One piece of it is behaviour and not a stub: `FunctionTool.run_async` refuses
a call whose mandatory arguments are absent, between the two callbacks and after the charge, and
that refusal is part of what the official run does with a malformed call. It is reproduced below,
copied from google-adk==1.0.0, and marked as such.
"""

from __future__ import annotations

import argparse
import asyncio
import importlib.util
import inspect
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


class _FunctionTool:
    """The parts of google-adk's FunctionTool that the official tools are wired through.

    `get_ainteract_tools()` wraps all nine tools in `FunctionTool`, and `run_async` is where a
    call missing a mandatory argument is refused: after `before_tool_callback` has charged for it
    and before the tool body runs, returning an `{"error": ...}` dict that `after_tool_callback`
    then records at the tool's full cost. Calling the plain Python function instead would raise
    `TypeError` and hide the charged refusal the oracle exists to pin. `run_async`, its error
    template and `_get_mandatory_args` are copied verbatim from google-adk==1.0.0
    (`google/adk/tools/function_tool.py`); importing the real class would pull in google-genai and
    the rest of the ADK dependency tree.
    """

    def __init__(self, func):
        self.func = func
        self.name = func.__name__

    async def run_async(self, *, args: dict[str, Any], tool_context: Any) -> Any:
        args_to_call = args.copy()
        signature = inspect.signature(self.func)
        if "tool_context" in signature.parameters:
            args_to_call["tool_context"] = tool_context

        mandatory_args = self._get_mandatory_args()
        missing_mandatory_args = [
            arg for arg in mandatory_args if arg not in args_to_call
        ]

        if missing_mandatory_args:
            missing_mandatory_args_str = "\n".join(missing_mandatory_args)
            error_str = f"""Invoking `{self.name}()` failed as the following mandatory input parameters are not present:
{missing_mandatory_args_str}
You could retry calling this tool, but it is IMPORTANT for you to provide all the mandatory parameters."""
            return {"error": error_str}

        if inspect.iscoroutinefunction(self.func):
            return await self.func(**args_to_call) or {}
        else:
            return self.func(**args_to_call) or {}

    def _get_mandatory_args(self) -> list[str]:
        signature = inspect.signature(self.func)
        mandatory_params = []

        for name, param in signature.parameters.items():
            if param.default == inspect.Parameter.empty and param.kind not in (
                inspect.Parameter.VAR_POSITIONAL,
                inspect.Parameter.VAR_KEYWORD,
            ):
                mandatory_params.append(name)

        return mandatory_params


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
    # Taking the tools from get_ainteract_tools() rather than off the module keeps the oracle
    # honest about how they are wired: the FunctionTool wrapper is what refuses a call missing a
    # mandatory argument, and reaching past it would replay a call the official agent cannot make.
    tools_by_name = {tool.name: tool for tool in tools.get_ainteract_tools()}
    for case in fixture["cases"]:
        state = json.loads(json.dumps(fixture["base_state"]))
        state.update(json.loads(json.dumps(case.get("state", {}))))
        state["dialogue_history"] = []
        state["tool_trajectory"] = []
        state["adk_events"] = []
        context = _Context(state)
        named_tool = tools_by_name[case["tool"]]
        args = case["args"]
        ACTIVE_CASE = case
        POST_CALLS = []

        # google-adk's handle_function_calls_async skips the tool when a before_tool_callback
        # returns a response, but then runs the after_tool_callback chain unconditionally with
        # that response as tool_response. Short-circuiting the whole chain here instead would
        # hide the trajectory entry and the budget note that a refused call still produces.
        rejected_response = asyncio.run(
            callbacks.before_tool_callback(named_tool, args, context)
        )
        rejected = rejected_response is not None
        if rejected:
            tool_response = rejected_response
        else:
            tool_response = asyncio.run(
                named_tool.run_async(args=args, tool_context=context)
            )
        after_response = asyncio.run(
            callbacks.after_tool_callback(named_tool, args, context, tool_response)
        )
        observation = after_response if after_response is not None else tool_response
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
