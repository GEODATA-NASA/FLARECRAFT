"""The Groq adapter turns the assistant loop's Anthropic-shaped messages into chat-completions and back."""

from types import SimpleNamespace

from api.assistant.groq_client import nullable_optionals, to_blocks, to_openai_messages


def test_round_trip_of_a_tool_call():
    reply = {"message": {"content": None, "tool_calls": [{"id": "c1", "type": "function", "function": {"name": "get_model_info", "arguments": "{}"}}]}}
    blocks = to_blocks(reply)
    assert [(b.type, b.name, b.input) for b in blocks] == [("tool_use", "get_model_info", {})]

    messages = [
        {"role": "user", "content": "How good is the model?"},
        {"role": "assistant", "content": blocks},
        {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "c1", "content": "{\"roc_auc\": 0.89}"}]},
    ]
    out = to_openai_messages("system text", messages)
    assert [m["role"] for m in out] == ["system", "user", "assistant", "tool"]
    assert out[2]["tool_calls"][0]["function"]["name"] == "get_model_info" and out[2]["content"] is None
    assert out[3] == {"role": "tool", "tool_call_id": "c1", "content": "{\"roc_auc\": 0.89}"}


def test_only_optional_arguments_may_be_null():
    schema = {"type": "object", "required": ["start_date"], "properties": {"start_date": {"type": "string"}, "bbox": {"type": "array", "items": {"type": "number"}},
                                                                           "daynight": {"type": "string", "enum": ["D", "N"]}}}
    out = nullable_optionals(schema)
    assert out["properties"]["start_date"] == {"type": "string"}
    assert out["properties"]["bbox"]["type"] == ["array", "null"] and out["properties"]["bbox"]["items"] == {"type": "number"}
    assert out["properties"]["daynight"]["enum"] == ["D", "N", None]
    assert schema["properties"]["bbox"]["type"] == "array" and schema["properties"]["daynight"]["enum"] == ["D", "N"]   # shared definitions unchanged


def test_a_short_rate_limit_is_waited_out_once(monkeypatch):
    from api.assistant import groq_client

    ok = {"choices": [{"message": {"content": "done"}, "finish_reason": "stop"}], "usage": {}}
    replies = [SimpleNamespace(status_code=429, ok=False, headers={"retry-after": "1.5"}),
               SimpleNamespace(status_code=200, ok=True, headers={}, json=lambda: ok)]
    waits = []
    monkeypatch.setattr(groq_client.requests, "post", lambda *a, **k: replies.pop(0))
    monkeypatch.setattr(groq_client.time, "sleep", waits.append)
    out = groq_client.GroqClient("key").create(model="m", system=[{"text": "s"}], tools=[], messages=[{"role": "user", "content": "q"}])
    assert waits == [1.5] and out.content[0].text == "done"


def test_a_long_rate_limit_is_reported_not_waited(monkeypatch):
    import pytest

    from api.assistant import groq_client

    monkeypatch.setattr(groq_client.requests, "post", lambda *a, **k: SimpleNamespace(status_code=429, ok=False, headers={"retry-after": "90"}))
    monkeypatch.setattr(groq_client.time, "sleep", lambda s: pytest.fail("should not wait 90 seconds"))
    with pytest.raises(groq_client.GroqError, match="rate limiting"):
        groq_client.GroqClient("key").create(model="m", system=[{"text": "s"}], tools=[], messages=[{"role": "user", "content": "q"}])


def test_bad_tool_arguments_become_an_empty_input():
    reply = {"message": {"content": "thinking", "tool_calls": [{"id": "c2", "type": "function", "function": {"name": "list_fires", "arguments": "{not json"}}]}}
    blocks = to_blocks(reply)
    assert blocks[0].text == "thinking" and blocks[1].input == {}
