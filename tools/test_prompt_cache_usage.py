#!/usr/bin/env python3
"""
验证本地 prompt cache / billed input 行为。

用法：
  python3 tools/test_prompt_cache_usage.py \
    --base-url http://127.0.0.1:8990 \
    --api-key sk-cz

默认发送三轮 /v1/messages 请求，检查：
- 首轮 cache_creation_input_tokens > 0
- 后续轮次 cache_read_input_tokens 递增
- usage.input_tokens 是否已扣减 cache_read_input_tokens
- 是否仍出现 +1 token 抖动
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass
from typing import Any

try:
    import requests
except ImportError:
    print("需要 requests 库，请先安装：pip install requests")
    sys.exit(1)

DEFAULT_BASE_URL = "http://127.0.0.1:8990"
DEFAULT_API_KEY = "sk-cz"
DEFAULT_MODEL = "claude-sonnet-4-5"
DEFAULT_TIMEOUT = 300


@dataclass
class TurnResult:
    turn: int
    status_code: int
    usage: dict[str, Any]
    response_text: str


def build_headers(api_key: str) -> dict[str, str]:
    return {
        "content-type": "application/json",
        "x-api-key": api_key,
        "anthropic-version": "2023-06-01",
    }


def build_system_text() -> str:
    return (
        "You are Claude Code, Anthropic's official CLI for Claude. "
        + ("cacheable prompt chunk " * 256)
    )


def build_turn_payloads(model: str) -> list[dict[str, Any]]:
    system_block = {
        "type": "text",
        "cache_control": {"type": "ephemeral"},
        "text": build_system_text(),
    }

    return [
        {
            "model": model,
            "max_tokens": 64,
            "system": [system_block],
            "messages": [
                {"role": "user", "content": "请只回复 ok"},
            ],
        },
        {
            "model": model,
            "max_tokens": 64,
            "system": [system_block],
            "messages": [
                {"role": "user", "content": "请只回复 ok"},
                {"role": "assistant", "content": "ok"},
                {"role": "user", "content": "继续，只回复 ok"},
            ],
        },
        {
            "model": model,
            "max_tokens": 64,
            "system": [system_block],
            "messages": [
                {"role": "user", "content": "请只回复 ok"},
                {"role": "assistant", "content": "ok"},
                {"role": "user", "content": "继续，只回复 ok"},
                {"role": "assistant", "content": "ok"},
                {"role": "user", "content": "再继续，只回复 ok"},
            ],
        },
    ]


def send_request(base_url: str, api_key: str, payload: dict[str, Any], timeout: int) -> TurnResult:
    response = requests.post(
        f"{base_url.rstrip('/')}/v1/messages",
        headers=build_headers(api_key),
        json=payload,
        timeout=timeout,
    )
    data = response.json()
    content = data.get("content", [])
    response_text = ""
    if content and isinstance(content, list):
        first = content[0]
        if isinstance(first, dict):
            response_text = first.get("text", "")

    return TurnResult(
        turn=0,
        status_code=response.status_code,
        usage=data.get("usage", {}),
        response_text=response_text,
    )


def print_turn_result(result: TurnResult) -> None:
    print(
        json.dumps(
            {
                "turn": result.turn,
                "status": result.status_code,
                "usage": result.usage,
                "text": result.response_text,
            },
            ensure_ascii=False,
            indent=2,
        )
    )


def summarize(results: list[TurnResult]) -> int:
    print("\n=== Summary ===")

    if len(results) < 3:
        print("结果不足，无法验证三轮行为")
        return 1

    u1, u2, u3 = (r.usage for r in results)

    c1 = int(u1.get("cache_creation_input_tokens", 0) or 0)
    r1 = int(u1.get("cache_read_input_tokens", 0) or 0)
    i1 = int(u1.get("input_tokens", 0) or 0)

    c2 = int(u2.get("cache_creation_input_tokens", 0) or 0)
    r2 = int(u2.get("cache_read_input_tokens", 0) or 0)
    i2 = int(u2.get("input_tokens", 0) or 0)

    c3 = int(u3.get("cache_creation_input_tokens", 0) or 0)
    r3 = int(u3.get("cache_read_input_tokens", 0) or 0)
    i3 = int(u3.get("input_tokens", 0) or 0)

    checks = [
        (c1 > 0, f"turn1 creation > 0: {c1}"),
        (r1 == 0, f"turn1 read == 0: {r1}"),
        (r2 > 0, f"turn2 read > 0: {r2}"),
        (r3 > r2, f"turn3 read > turn2 read: {r3} > {r2}"),
        (i2 >= 0 and i3 >= 0, f"billed input non-negative: turn2={i2}, turn3={i3}"),
    ]

    for ok, message in checks:
        print(f"[{'PASS' if ok else 'FAIL'}] {message}")

    print("\n=== Derived metrics ===")
    print(f"turn1: input={i1}, creation={c1}, read={r1}")
    print(f"turn2: input={i2}, creation={c2}, read={r2}")
    print(f"turn3: input={i3}, creation={c3}, read={r3}")
    print(f"turn2 raw-like total(input+read)={i2 + r2}")
    print(f"turn3 raw-like total(input+read)={i3 + r3}")
    print(f"delta read turn2-turn1={r2 - r1}")
    print(f"delta read turn3-turn2={r3 - r2}")

    wobble = abs(c1 - r2)
    print(f"system cache wobble |turn1 creation - turn2 read| = {wobble}")

    failed = any(not ok for ok, _ in checks)
    return 1 if failed else 0


def main() -> int:
    parser = argparse.ArgumentParser(description="验证本地 prompt cache usage 行为")
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL, help="服务地址")
    parser.add_argument("--api-key", default=DEFAULT_API_KEY, help="API Key")
    parser.add_argument("--model", default=DEFAULT_MODEL, help="模型名")
    parser.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT, help="请求超时秒数")
    args = parser.parse_args()

    payloads = build_turn_payloads(args.model)
    results: list[TurnResult] = []

    for idx, payload in enumerate(payloads, start=1):
        try:
            result = send_request(args.base_url, args.api_key, payload, args.timeout)
            result.turn = idx
            results.append(result)
            print_turn_result(result)
        except Exception as exc:
            print(f"[ERROR] turn{idx} 请求失败: {exc}")
            return 1

    return summarize(results)


if __name__ == "__main__":
    raise SystemExit(main())
