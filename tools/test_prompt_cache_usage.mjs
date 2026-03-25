#!/usr/bin/env node
/**
 * 验证本地 prompt cache / billed input 行为。
 *
 * 用法：
 *   node tools/test_prompt_cache_usage.mjs \
 *     --base-url http://127.0.0.1:8990 \
 *     --api-key sk-cz
 */

const DEFAULT_BASE_URL = 'http://127.0.0.1:8990';
const DEFAULT_API_KEY = 'sk-cz';
const DEFAULT_MODEL = 'claude-sonnet-4-5';
const DEFAULT_TIMEOUT_MS = 300_000;

function parseArgs(argv) {
  const args = {
    baseUrl: DEFAULT_BASE_URL,
    apiKey: DEFAULT_API_KEY,
    model: DEFAULT_MODEL,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];

    if (key === '--base-url' && value) {
      args.baseUrl = value;
      i += 1;
    } else if (key === '--api-key' && value) {
      args.apiKey = value;
      i += 1;
    } else if (key === '--model' && value) {
      args.model = value;
      i += 1;
    } else if (key === '--timeout' && value) {
      args.timeoutMs = Number(value) * 1000;
      i += 1;
    }
  }

  return args;
}

function buildSystemText() {
  return "You are Claude Code, Anthropic's official CLI for Claude. " + 'cacheable prompt chunk '.repeat(256);
}

function buildTurnPayloads(model) {
  const systemBlock = {
    type: 'text',
    cache_control: { type: 'ephemeral' },
    text: buildSystemText(),
  };

  return [
    {
      model,
      max_tokens: 64,
      system: [systemBlock],
      messages: [
        { role: 'user', content: '请只回复 ok' },
      ],
    },
    {
      model,
      max_tokens: 64,
      system: [systemBlock],
      messages: [
        { role: 'user', content: '请只回复 ok' },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: '继续，只回复 ok' },
      ],
    },
    {
      model,
      max_tokens: 64,
      system: [systemBlock],
      messages: [
        { role: 'user', content: '请只回复 ok' },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: '继续，只回复 ok' },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: '再继续，只回复 ok' },
      ],
    },
  ];
}

function buildHeaders(apiKey) {
  return {
    'content-type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
  };
}

async function sendRequest(baseUrl, apiKey, payload, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/v1/messages`, {
      method: 'POST',
      headers: buildHeaders(apiKey),
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`响应不是合法 JSON: ${text.slice(0, 500)}`);
    }

    const firstBlock = Array.isArray(data.content) ? data.content[0] : null;
    return {
      statusCode: response.status,
      usage: data.usage || {},
      responseText:
        firstBlock && typeof firstBlock === 'object' && firstBlock !== null
          ? firstBlock.text || ''
          : '',
    };
  } catch (error) {
    const cause = error && typeof error === 'object' ? error.cause : undefined;
    const causeMessage = cause && typeof cause === 'object' && 'message' in cause
      ? cause.message
      : '';
    const code = cause && typeof cause === 'object' && 'code' in cause
      ? cause.code
      : '';
    const detail = [error?.message, code, causeMessage].filter(Boolean).join(' | ');
    throw new Error(detail || '请求失败');
  } finally {
    clearTimeout(timeout);
  }
}

async function trySendWithFallback(baseUrl, apiKey, payload, timeoutMs) {
  const candidates = [baseUrl];

  if (baseUrl.includes('127.0.0.1')) {
    candidates.push(baseUrl.replace('127.0.0.1', 'localhost'));
  } else if (baseUrl.includes('localhost')) {
    candidates.push(baseUrl.replace('localhost', '127.0.0.1'));
  }

  let lastError;
  for (const candidate of [...new Set(candidates)]) {
    try {
      return await sendRequest(candidate, apiKey, payload, timeoutMs);
    } catch (error) {
      lastError = new Error(`${candidate}: ${error.message}`);
    }
  }

  throw lastError;
}

function printTurnResult(result) {
  console.log(
    JSON.stringify(
      {
        turn: result.turn,
        status: result.statusCode,
        usage: result.usage,
        text: result.responseText,
      },
      null,
      2,
    ),
  );
}

function summarize(results) {
  console.log('\n=== Summary ===');

  if (results.length < 3) {
    console.log('结果不足，无法验证三轮行为');
    return 1;
  }

  const [u1, u2, u3] = results.map((r) => r.usage || {});

  const c1 = Number(u1.cache_creation_input_tokens || 0);
  const r1 = Number(u1.cache_read_input_tokens || 0);
  const i1 = Number(u1.input_tokens || 0);

  const c2 = Number(u2.cache_creation_input_tokens || 0);
  const r2 = Number(u2.cache_read_input_tokens || 0);
  const i2 = Number(u2.input_tokens || 0);

  const c3 = Number(u3.cache_creation_input_tokens || 0);
  const r3 = Number(u3.cache_read_input_tokens || 0);
  const i3 = Number(u3.input_tokens || 0);

  const checks = [
    [c1 > 0, `turn1 creation > 0: ${c1}`],
    [r1 === 0, `turn1 read == 0: ${r1}`],
    [r2 > 0, `turn2 read > 0: ${r2}`],
    [r3 > r2, `turn3 read > turn2 read: ${r3} > ${r2}`],
    [i2 >= 0 && i3 >= 0, `billed input non-negative: turn2=${i2}, turn3=${i3}`],
  ];

  for (const [ok, message] of checks) {
    console.log(`[${ok ? 'PASS' : 'FAIL'}] ${message}`);
  }

  console.log('\n=== Derived metrics ===');
  console.log(`turn1: input=${i1}, creation=${c1}, read=${r1}`);
  console.log(`turn2: input=${i2}, creation=${c2}, read=${r2}`);
  console.log(`turn3: input=${i3}, creation=${c3}, read=${r3}`);
  console.log(`turn2 raw-like total(input+read)=${i2 + r2}`);
  console.log(`turn3 raw-like total(input+read)=${i3 + r3}`);
  console.log(`delta read turn2-turn1=${r2 - r1}`);
  console.log(`delta read turn3-turn2=${r3 - r2}`);

  const wobble = Math.abs(c1 - r2);
  console.log(`system cache wobble |turn1 creation - turn2 read| = ${wobble}`);

  return checks.some(([ok]) => !ok) ? 1 : 0;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const payloads = buildTurnPayloads(args.model);
  const results = [];

  for (let i = 0; i < payloads.length; i += 1) {
    const turn = i + 1;
    try {
      const result = await trySendWithFallback(
        args.baseUrl,
        args.apiKey,
        payloads[i],
        args.timeoutMs,
      );
      result.turn = turn;
      results.push(result);
      printTurnResult(result);
    } catch (error) {
      console.error(`[ERROR] turn${turn} 请求失败: ${error.message}`);
      process.exit(1);
    }
  }

  process.exit(summarize(results));
}

main();
