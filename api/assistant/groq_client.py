"""Groq behind the same interface the assistant loop uses for Anthropic.

Groq's API is OpenAI-compatible, so this translates the loop's Anthropic-shaped request
(system, tools, messages with tool_use / tool_result blocks) to chat-completions and the
reply back into Anthropic-shaped blocks. The loop in service.py stays unchanged.
"""

import json
from types import SimpleNamespace

import requests

GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"
DEFAULT_MODEL = "openai/gpt-oss-120b"


class GroqError(Exception):
    """Groq answered with an error; the message is safe to show."""


def to_openai_messages(system: str, messages: list) -> list:
    out = [{"role": "system", "content": system}]
    for message in messages:
        content = message["content"]
        if isinstance(content, str):
            out.append({"role": message["role"], "content": content})
        elif message["role"] == "assistant":      # blocks from an earlier reply
            calls = [{"id": b.id, "type": "function", "function": {"name": b.name, "arguments": json.dumps(b.input)}}
                     for b in content if b.type == "tool_use"]
            text = "\n".join(b.text for b in content if b.type == "text") or None
            out.append({"role": "assistant", "content": text, **({"tool_calls": calls} if calls else {})})
        else:                                     # tool results, one message each
            out.extend({"role": "tool", "tool_call_id": r["tool_use_id"], "content": str(r["content"])} for r in content)
    return out


def to_blocks(choice: dict) -> list:
    message = choice["message"]
    blocks = [SimpleNamespace(type="text", text=message["content"])] if message.get("content") else []
    for call in message.get("tool_calls") or []:
        try:
            arguments = json.loads(call["function"]["arguments"] or "{}")
        except json.JSONDecodeError:
            arguments = {}
        blocks.append(SimpleNamespace(type="tool_use", id=call["id"], name=call["function"]["name"], input=arguments))
    return blocks


class GroqClient:
    """Just enough of anthropic.Anthropic for AssistantService: .api_key and .messages.create(**params)."""

    def __init__(self, api_key: str, timeout: float = 120.0):
        self.api_key = api_key
        self.timeout = timeout
        self.messages = self

    def create(self, model, system, tools, messages, max_tokens=4096, **_ignored):
        body = {
            "model": model,
            "max_tokens": min(max_tokens, 8192),
            "messages": to_openai_messages(system[0]["text"], messages),
            "tools": [{"type": "function", "function": {"name": t["name"], "description": t["description"], "parameters": t["input_schema"]}} for t in tools],
        }
        try:
            response = requests.post(GROQ_URL, json=body, headers={"Authorization": f"Bearer {self.api_key}"}, timeout=self.timeout)
        except requests.RequestException as error:
            raise GroqError("Could not reach the Groq API.") from error
        if response.status_code == 401:
            raise GroqError("Groq rejected the API key (GROQ_API_KEY).")
        if response.status_code == 429:
            raise GroqError("Groq is rate limiting this key. Try again in a minute.")
        if not response.ok:
            raise GroqError(f"Groq returned an error ({response.status_code}).")
        data = response.json()
        choice = data["choices"][0]
        blocks = to_blocks(choice)
        stop = "tool_use" if any(b.type == "tool_use" for b in blocks) else "max_tokens" if choice.get("finish_reason") == "length" else "end_turn"
        usage = data.get("usage", {})
        return SimpleNamespace(content=blocks, stop_reason=stop, model=data.get("model", model),
                               usage=SimpleNamespace(input_tokens=usage.get("prompt_tokens", 0), output_tokens=usage.get("completion_tokens", 0)))
