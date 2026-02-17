#!/usr/bin/env python3
"""
向自建网关发送 hyb_bug.txt 中的请求体，用于复现/排查 400。

支持两种输入格式：
1) 第一行是 `# POST <url>`，后面跟 JSON（hyb_bug.txt 当前格式）
2) 纯 JSON 文件

默认行为：
- 若未显式指定 --url，则尝试从 `# POST ...` 自动提取 URL
- 默认以“JSON 模式”发送（会跳过开头的 `#` 注释/空行）
- 默认会解析并重新序列化 JSON（便于覆盖字段与做基本校验）

示例：
  python3 tools/probe_hyb_gateway.py "/Users/petaflops/Downloads/hyb_bug.txt"
  python3 tools/probe_hyb_gateway.py "/Users/petaflops/Downloads/hyb_bug.txt" --url "http://127.0.0.1:8080/claude/v1/messages"
  HYB_API_KEY="xxx" python3 tools/probe_hyb_gateway.py "/Users/petaflops/Downloads/hyb_bug.txt" --auth bearer
  python3 tools/probe_hyb_gateway.py "/Users/petaflops/Downloads/hyb_bug.txt" --set-max-tokens 8192 --set-stream false
  python3 tools/probe_hyb_gateway.py "/Users/petaflops/Downloads/hyb_bug.txt" --dry-run
"""

from __future__ import annotations

import argparse
import json
import os
import re
import ssl
import sys
from typing import Any, Dict, List, Optional, Sequence, Tuple
from urllib import error, request

POST_HINT_RE = re.compile(r"^\s*#\s*POST\s+(\S+)\s*$")


def _extract_url_hint(lines: Sequence[str]) -> Optional[str]:
    # 只看前几行，避免把正文里的 “# POST …” 当作 hint。
    for line in lines[:5]:
        m = POST_HINT_RE.match(line)
        if m:
            return m.group(1)
        if line.strip() and not line.lstrip().startswith("#"):
            break
    return None


def _strip_leading_comments(lines: Sequence[str]) -> List[str]:
    i = 0
    while i < len(lines):
        s = lines[i].strip()
        if s == "" or s.startswith("#"):
            i += 1
            continue
        break
    return list(lines[i:])


def load_body_text(path: str, *, mode: str) -> Tuple[Optional[str], str]:
    text = open(path, "r", encoding="utf-8", errors="replace").read()
    lines = text.splitlines()
    url_hint = _extract_url_hint(lines)

    if mode == "raw":
        body = text
    elif mode == "json":
        body = "\n".join(_strip_leading_comments(lines))
    else:
        raise ValueError(f"unknown mode: {mode}")

    body = body.strip()
    if body:
        body += "\n"
    return url_hint, body


def parse_headers(header_kvs: Sequence[str]) -> List[Tuple[str, str]]:
    parsed: List[Tuple[str, str]] = []
    for raw in header_kvs:
        if ":" not in raw:
            raise ValueError(f"invalid --header (missing ':'): {raw!r}")
        name, value = raw.split(":", 1)
        name = name.strip()
        value = value.strip()
        if not name:
            raise ValueError(f"invalid --header (empty name): {raw!r}")
        parsed.append((name, value))
    return parsed


def coerce_bool(s: str) -> bool:
    v = s.strip().lower()
    if v in {"1", "true", "t", "yes", "y", "on"}:
        return True
    if v in {"0", "false", "f", "no", "n", "off"}:
        return False
    raise ValueError(f"invalid bool: {s!r} (expected true/false)")


def maybe_pretty_print_json(data: bytes, *, max_print_bytes: int) -> None:
    text = data.decode("utf-8", errors="replace")
    if len(data) > max_print_bytes:
        text = text[: max_print_bytes].rstrip("\n") + "\n\n...(truncated)\n"

    try:
        obj = json.loads(text)
    except json.JSONDecodeError:
        sys.stdout.write(text)
        return

    sys.stdout.write(json.dumps(obj, ensure_ascii=False, indent=2))
    sys.stdout.write("\n")


def main(argv: List[str]) -> int:
    parser = argparse.ArgumentParser(description="发送 hyb_bug.txt 请求到自建网关并打印响应")
    parser.add_argument("input", help="hyb_bug.txt 或纯 JSON 文件路径")
    parser.add_argument("--url", default=None, help="目标 URL（默认从 # POST 自动提取）")
    parser.add_argument(
        "--mode",
        choices=["json", "raw"],
        default="json",
        help="json=跳过开头注释后发送 JSON；raw=原样发送整个文件",
    )
    parser.add_argument(
        "--header",
        action="append",
        default=[],
        help="额外 HTTP Header，格式：'Name: value'（可重复）",
    )
    parser.add_argument(
        "--auth",
        choices=["none", "bearer", "x-api-key"],
        default="none",
        help="鉴权方式：none / bearer(Authorization: Bearer) / x-api-key",
    )
    parser.add_argument(
        "--api-key",
        default=None,
        help="API Key（默认从环境变量 HYB_API_KEY 读取；仅在 --auth != none 时使用）",
    )
    parser.add_argument("--timeout", type=float, default=60.0, help="请求超时（秒）")
    parser.add_argument("--insecure", action="store_true", help="跳过 TLS 证书校验（仅用于自签名环境）")
    parser.add_argument("--dry-run", action="store_true", help="只解析/校验并打印请求摘要，不发送请求")
    parser.add_argument("--print-request", action="store_true", help="打印将要发送的请求 JSON（可能很长）")
    parser.add_argument("--max-print-bytes", type=int, default=16384, help="打印响应/请求时的最大字节数")

    # 便于快速排除 400：按需覆盖常见字段
    parser.add_argument("--set-max-tokens", type=int, default=None, help="覆盖 max_tokens")
    parser.add_argument("--set-model", default=None, help="覆盖 model")
    parser.add_argument("--set-stream", default=None, help="覆盖 stream（true/false）")

    args = parser.parse_args(argv)

    url_hint, body_text = load_body_text(args.input, mode=args.mode)
    url = args.url or url_hint
    if not url:
        print("ERROR: 未指定 --url，且输入文件也没有 `# POST <url>` 提示", file=sys.stderr)
        return 2

    body_bytes: bytes
    parsed_json: Optional[Dict[str, Any]] = None
    parse_error: Optional[str] = None
    try:
        parsed = json.loads(body_text)
        if not isinstance(parsed, dict):
            print("ERROR: JSON 顶层不是 object", file=sys.stderr)
            return 2
        parsed_json = parsed
    except json.JSONDecodeError as e:
        parse_error = str(e)

    if args.set_max_tokens is not None or args.set_model is not None or args.set_stream is not None:
        if parsed_json is None:
            print(f"ERROR: 需要覆盖字段，但 JSON 解析失败：{parse_error}", file=sys.stderr)
            return 2
        if args.set_max_tokens is not None:
            parsed_json["max_tokens"] = args.set_max_tokens
        if args.set_model is not None:
            parsed_json["model"] = args.set_model
        if args.set_stream is not None:
            parsed_json["stream"] = coerce_bool(args.set_stream)

    if args.mode == "raw":
        # 原样发送（即使不是合法 JSON，也允许用于验证网关的 400 行为）
        body_bytes = body_text.encode("utf-8")
    else:
        if parsed_json is None:
            print(f"ERROR: JSON 解析失败：{parse_error}", file=sys.stderr)
            return 2
        body_bytes = json.dumps(parsed_json, ensure_ascii=False, separators=(",", ":")).encode("utf-8")

    try:
        extra_headers = parse_headers(args.header)
    except ValueError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 2

    api_key = args.api_key or ("" if args.auth == "none" else (os.environ.get("HYB_API_KEY") or ""))
    if args.auth != "none" and not api_key:
        print("ERROR: --auth != none 但未提供 --api-key 且环境变量 HYB_API_KEY 为空", file=sys.stderr)
        return 2

    # 请求摘要
    if parsed_json is None:
        mt = model = stream = None
        msg_n = tool_n = -1
    else:
        mt = parsed_json.get("max_tokens")
        model = parsed_json.get("model")
        stream = parsed_json.get("stream")
        msg_n = len(parsed_json.get("messages") or []) if isinstance(parsed_json.get("messages"), list) else -1
        tool_n = len(parsed_json.get("tools") or []) if isinstance(parsed_json.get("tools"), list) else -1
    print(
        f"[probe] url={url}\n"
        f"[probe] bytes={len(body_bytes)} model={model!r} max_tokens={mt!r} stream={stream!r} messages={msg_n} tools={tool_n}"
    )

    if args.print_request:
        print("\n[probe] request(json):")
        maybe_pretty_print_json(body_bytes, max_print_bytes=args.max_print_bytes)

    if args.dry_run:
        return 0

    req = request.Request(url, data=body_bytes, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("Accept", "application/json, text/event-stream")
    req.add_header("User-Agent", "kiro-probe/1.0")

    if args.auth == "bearer":
        req.add_header("Authorization", f"Bearer {api_key}")
    elif args.auth == "x-api-key":
        req.add_header("x-api-key", api_key)

    for name, value in extra_headers:
        req.add_header(name, value)

    ssl_context = ssl._create_unverified_context() if args.insecure else None

    try:
        with request.urlopen(req, timeout=args.timeout, context=ssl_context) as resp:
            status = resp.getcode()
            resp_body = resp.read()
            ct = resp.headers.get("Content-Type", "")
            print(f"\n[probe] http_status={status} content_type={ct!r}")
            maybe_pretty_print_json(resp_body, max_print_bytes=args.max_print_bytes)
            return 0 if 200 <= status < 300 else 1
    except error.HTTPError as e:
        # 4xx/5xx 也会走异常分支；仍然把 body 打出来便于定位。
        resp_body = e.read()
        ct = e.headers.get("Content-Type", "") if e.headers else ""
        print(f"\n[probe] http_status={e.code} content_type={ct!r}")
        maybe_pretty_print_json(resp_body, max_print_bytes=args.max_print_bytes)
        return 1
    except Exception as e:
        print(f"ERROR: 请求失败：{e}", file=sys.stderr)
        return 3


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
