"""The Groq adapter turns the assistant loop's Anthropic-shaped messages into chat-completions and back."""

from types import SimpleNamespace

from api.assistant.groq_client import to_blocks, to_openai_messages


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


def test_bad_tool_arguments_become_an_empty_input():
    reply = {"message": {"content": "thinking", "tool_calls": [{"id": "c2", "type": "function", "function": {"name": "list_fires", "arguments": "{not json"}}]}}
    blocks = to_blocks(reply)
    assert blocks[0].text == "thinking" and blocks[1].input == {}
