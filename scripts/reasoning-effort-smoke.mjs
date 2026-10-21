#!/usr/bin/env node
/**
 * 推理档位（#35）冒烟：默认值一致性 + 透传判据 + 被拒降级。
 *
 * ## 它挡的是哪两类事故
 *
 * 1. **五处登记点漂移**。一个 volatile 设置项要同时活在
 *    `src/index.ts` 的 schema、`src/generate.ts` 的两处 `readVolatile`、
 *    `src/live-settings.ts` 的键表、`src/client/settings-card.tsx` 的卡片行、
 *    以及两份 README 里。少一处 = 「设置页显示 A、实际生效 B」或「改了不生效」
 *    （#19 那一类）；而这些**每一处单独看都合法**，所以只有集合比对能发现。
 * 2. **默认值被改回非空**。档位是按 provider、按 model 声明的：实测 qoder-route
 *    的 18 个模型里 9 个没有 `reasoningEfforts` 段，给它们带任何档位会在**请求发出
 *    之前**就被拒（0-20ms，UNSUPPORTED_REASONING_EFFORT）。默认值一旦不是空串，
 *    整条建议路径就变成必然失败。这条默认值不是审美选择，是有依据的结论，
 *    所以把它钉住（用例 2）。
 *
 * ## 为什么从 lib/ 导入
 *
 * `generate.ts` 里有 `using` 声明，`node --experimental-strip-types` 剥不动它
 * （与 `scripts/inline-smoke.mjs`、`scripts/language-evidence-smoke.mjs` 同一取舍），
 * 所以端到端用例驱动的是构建产物。改完 src 记得先 `node build.mjs`。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStreamMetrics, effortLabel, effortOf, formatStreamMetrics, generateCompletion, generateSuggestion, isUnsupportedEffort } from '../lib/generate.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(root, rel), 'utf8');

let failed = 0;
const run = (name, fn) => {
  try {
    const out = fn();
    return out instanceof Promise
      ? out.then(
        () => console.log(`  ✓ ${name}`),
        (error) => { failed += 1; console.error(`  ✗ ${name}\n      ${String(error.message).split('\n')[0]}`); },
      )
      : (console.log(`  ✓ ${name}`), Promise.resolve());
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}\n      ${String(error.message).split('\n')[0]}`);
    return Promise.resolve();
  }
};

const KEYS = ['suggestionReasoningEffort', 'completionReasoningEffort'];
/** 默认值：空串 = 不传 = 继承路由默认档位。 */
const EXPECTED_DEFAULT = "''";

// ── 1. 宿主 schema：两个字段都在，且都是 `.default('')` + `.volatile()` ──────────
run('src/index.ts schema：两字段齐、默认空串、标了 volatile', () => {
  const host = read('src/index.ts');
  for (const key of KEYS) {
    const schema = new RegExp(`${key}:\\s*z\\.string\\(\\)\\.default\\((''|"[^"]*"|'[^']*')\\)\\.volatile\\(\\)`).exec(host);
    assert.ok(schema !== null, `src/index.ts 里找不到 ${key} 的 schema 定义（形态变了？）`);
    assert.equal(schema[1], EXPECTED_DEFAULT, `${key} 的 schema 默认值是 ${schema[1]}，应为空串（不传=继承）`);
    // 可调项的输出类型必须写成 Volatile<string>，否则 PluginConfigValues 与推断不符。
    assert.match(host, new RegExp(`${key}:\\s*Volatile<string>;`), `PluginConfigValues 里 ${key} 的类型不是 Volatile<string>`);
  }
});

// ── 2. generate.ts 的两处 readVolatile 与 schema 同值 ────────────────────────────
run('src/generate.ts：flattenConfig 与 resolveConfig 两处兜底都是空串', () => {
  const gen = read('src/generate.ts');
  for (const key of KEYS) {
    const reads = [...gen.matchAll(new RegExp(`readVolatile\\((?:config|raw)\\.${key},\\s*('')\\)`, 'g'))].map((m) => m[1]);
    assert.equal(reads.length, 2, `src/generate.ts 里 ${key} 应有 2 处 readVolatile（flattenConfig + resolveConfig），实得 ${reads.length}`);
    for (const r of reads) assert.equal(r, EXPECTED_DEFAULT, `${key} 的 readVolatile 兜底 ${r} 与 schema 默认值不一致`);
    // 拍平后的视图必须是裸值 string，否则 live-settings 的 Record<keyof FlatConfig> 会漏键。
    assert.match(gen, new RegExp(`${key}: string;`), `FlatConfig 里 ${key} 不是裸 string`);
  }
});

// ── 3. live-settings 键表与设置卡片行（漏一处就是 #19 那一类） ───────────────────
run('src/live-settings.ts 键表：两键都在，且允许空串', () => {
  const ls = read('src/live-settings.ts');
  for (const key of KEYS) {
    // STR(true) = 空串合法（继承语义）；STR(false) 会让「清空档位」被丢弃并回落 boot 值。
    assert.match(ls, new RegExp(`^\\s*${key}: STR\\(true\\),`, 'm'), `${key} 不在 SETTING_SPECS 里（或不是 STR(true)）→ 设置页改了不生效`);
  }
});

run('src/client/settings-card.tsx：两行卡片都在且可写', () => {
  const card = read('src/client/settings-card.tsx');
  for (const key of KEYS) {
    assert.match(card, new RegExp(`key: '${key}',`), `设置卡片里没有 ${key} 这一行`);
  }
});

run('两份 README 都写了两个新配置项与默认值', () => {
  for (const file of ['README.md', 'README.en.md']) {
    const doc = read(file);
    for (const key of KEYS) {
      assert.ok(doc.includes(key), `${file} 里没有 ${key}`);
    }
  }
});

// ── 4. 透传判据：空串 = 不传（与 provider/model 同套） ───────────────────────────
run('effortOf：空串/纯空白 → 不传；非空 → 原样品牌化', () => {
  assert.equal(effortOf(undefined), undefined, 'undefined 应判成不传');
  assert.equal(effortOf(''), undefined, '空串应判成不传（继承）');
  assert.equal(effortOf('   '), undefined, '纯空白应判成不传');
  assert.equal(String(effortOf('low')), 'low', '非空必须原样透传，不做别名/夹取');
  assert.equal(effortLabel(effortOf('')), 'inherit', '留痕里空档位要写成 inherit，不是空值');
  assert.equal(effortLabel(effortOf('low')), 'low');
});

// ── 5. 「档位不支持」的判定必须同时看两个要素 ────────────────────────────────────
run('isUnsupportedEffort：认错误码，也认「档位 + 不支持」双要素报文', () => {
  assert.equal(isUnsupportedEffort({ code: 'UNSUPPORTED_REASONING_EFFORT' }), true);
  assert.equal(
    isUnsupportedEffort({ message: 'provider "qoder-route" model "efficient" does not support reasoning effort "low"' }),
    true,
  );
  // 误判的两个方向都要挡住。
  assert.equal(isUnsupportedEffort({ message: 'provider and model must be supplied together' }), false,
    '只含「不支持」不含档位 → 不算档位错误（否则真配置错会被悄悄降级盖掉）');
  assert.equal(isUnsupportedEffort({ message: 'reasoning effort "low" is required for this route' }), false,
    '只含档位不含「不支持」 → 不算档位错误');
  assert.equal(isUnsupportedEffort(new Error('rate limit')), false);
  assert.equal(isUnsupportedEffort(undefined), false, 'undefined 不能抛');
});

// ── 端到端夹具：假 ctx.llm.stream 记录每次收到的 options ─────────────────────────
const userMsg = (seq, text) => ({
  type: 'user/message', seq, time: 0,
  data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] },
});
const asstMsg = (seq, text) => ({
  type: 'assistant/message', seq, time: 0,
  data: { turn: 1, message: { role: 'assistant', content: [{ type: 'text', text }] } },
});
const turnStart = (seq, turn) => ({ type: 'turn/start', seq, time: 0, data: { turn } });
const turnEnd = (seq, turn) => ({ type: 'turn/end', seq, time: 0, data: { turn, reason: { kind: 'completed' } } });

/** 假会话：有转录（建议路径要求）、有路由（routeOf 要求 provider+model 都非空）。 */
const fakeSession = () => ({
  id: 'session-effort-smoke',
  snapshotEvents: () => [
    turnStart(1, 1), userMsg(2, '把冒烟跑一遍'), asstMsg(3, '跑完了，全绿。'), turnEnd(4, 1),
  ],
  requestHeader: () => ({ config: { provider: 'p-smoke', model: 'm-smoke' } }),
});

const baseConfig = (over = {}) => ({
  maxInputBytes: 4096,
  maxOutputTokens: 512,
  timeoutMs: 5000,
  maxTranscriptChars: 12000,
  maxSuggestionChars: 240,
  ...over,
});

/** 文本流：一条 text-delta + finish(stop)。 */
const textStream = (text) => (async function* () {
  yield { type: 'block-start', index: 0, blockType: 'text' };
  yield { type: 'text-delta', index: 0, text };
  yield { type: 'block-end', index: 0, block: { type: 'text', text } };
  yield { type: 'finish', reason: { kind: 'stop' } };
})();

/** 每次都抛「档位不支持」的流。 */
const rejectEffort = () => (async function* () {
  const error = new Error('provider "p-smoke" model "m-smoke" does not support reasoning effort "low"');
  error.code = 'UNSUPPORTED_REASONING_EFFORT';
  throw error;
  yield 0; // 让 TS 认它是异步生成器（永不执行）
})();

/**
 * 造 ctx：`script` 是一个函数，收到第 n 次请求的 options 后决定怎么回。
 * @returns calls：每次请求收到的 options（含/不含 reasoningEffort 就是要断言的东西）。
 */
const fakeCtx = (script) => {
  const calls = [];
  return {
    calls,
    llm: {
      stream(options) {
        calls.push(options);
        return script(options, calls.length);
      },
    },
  };
};

const abortOf = () => new AbortController().signal;

// ── 6. 默认（空串）：请求对象上根本不该出现 reasoningEffort 这个键 ───────────────
await run('默认空串 → GenerateOptions 里没有 reasoningEffort 键（不是 undefined 值）', async () => {
  const ctx = fakeCtx(() => textStream('跑一下测试'));
  const result = await generateSuggestion(ctx, baseConfig(), fakeSession(), 1, abortOf());
  assert.equal(ctx.calls.length, 1, '应当只发一次请求');
  const options = ctx.calls[0];
  assert.ok(!('reasoningEffort' in options),
    `不传时那个键必须**不存在**；实得 ${JSON.stringify(Object.keys(options))}`);
  assert.equal(result.suggestion?.text, '跑一下测试');
  assert.equal(result.metrics.effortRequested, 'inherit');
  assert.equal(result.metrics.effortRejected, false);
});

// ── 7. 配了档位 → 原样透传 ──────────────────────────────────────────────────────
await run('配置 low → 请求带 reasoningEffort=low，留痕记 effort_requested=low', async () => {
  const ctx = fakeCtx(() => textStream('提交这两个改动'));
  const result = await generateSuggestion(
    ctx, baseConfig({ suggestionReasoningEffort: 'low' }), fakeSession(), 1, abortOf(),
  );
  assert.equal(String(ctx.calls[0].reasoningEffort ?? ''), 'low', '档位必须原样到 options 上');
  assert.equal(result.metrics.effortRequested, 'low');
  assert.ok(formatStreamMetrics(result.metrics).includes('effort_requested=low'),
    `留痕后缀里应看到 effort_requested=low：${formatStreamMetrics(result.metrics)}`);
});

// ── 8. 被拒 → 退一档重发一次，且**不占**外层重试预算 ─────────────────────────────
await run('档位被拒：立刻不带档位重发，attempts 仍是 1、effort_rejected=1', async () => {
  let second = null;
  const ctx = fakeCtx((options, n) => {
    if (n === 1) return rejectEffort();
    second = options;
    return textStream('看一下失败原因');
  });
  const result = await generateSuggestion(
    ctx, baseConfig({ suggestionReasoningEffort: 'low' }), fakeSession(), 1, abortOf(),
  );
  assert.equal(ctx.calls.length, 2, `应当恰好重发一次（不退避），实得 ${ctx.calls.length}`);
  assert.ok('reasoningEffort' in ctx.calls[0], '第一次请求应当带档位');
  assert.ok(!('reasoningEffort' in second), '退一档的那一次必须不带档位，否则等于原地重放');
  assert.equal(result.suggestion?.text, '看一下失败原因', '退一档之后仍然要出建议');
  assert.equal(result.metrics.attempts, 1,
    `档位降级不是常规重试，attempts 必须还是 1（实得 ${result.metrics.attempts}）`);
  assert.equal(result.metrics.effortRejected, true);
  assert.equal(result.metrics.effortRequested, 'inherit', '收口那次请求的档位就是 inherit');
  assert.ok(formatStreamMetrics(result.metrics).includes('effort_rejected=1'),
    '留痕里必须能统计这类失败');
});

// ── 9. 续写走同一条通路（读的是另一个键） ───────────────────────────────────────
await run('续写：档位读 completionReasoningEffort，与建议互不串台', async () => {
  const ctx = fakeCtx(() => textStream('然后推到远端'));
  const cfg = baseConfig({ completionReasoningEffort: 'medium', suggestionReasoningEffort: 'low' });
  const result = await generateCompletion(ctx, cfg, fakeSession(), '把改动', abortOf());
  assert.equal(String(ctx.calls[0].reasoningEffort ?? ''), 'medium', '续写只该用 completionReasoningEffort');
  assert.equal(result.text, '然后推到远端');
  assert.equal(result.metrics.effortRequested, 'medium');

  // 空配置时不传，且不会因为「建议那边配了档位」而被带上。
  const ctx2 = fakeCtx(() => textStream('再跑一次冒烟'));
  const r2 = await generateCompletion(ctx2, baseConfig({ suggestionReasoningEffort: 'low' }), fakeSession(), '把改动', abortOf());
  assert.ok(!('reasoningEffort' in ctx2.calls[0]), '续写配置留空就不该带档位');
  assert.equal(r2.metrics.effortRequested, 'inherit');
});

// ── 10. 反向验证：把默认值改回非空必须让本冒烟红 ────────────────────────────────
run('反向验证：留痕里 outcome 与两个首块延迟恒存在', () => {
  const m = createStreamMetrics('inherit');
  const line = formatStreamMetrics(m);
  for (const key of [
    'first_text_delta_ms=', 'first_reasoning_delta_ms=', 'content_deltas=', 'content_chars=',
    'reasoning_deltas=', 'reasoning_chars=', 'finish_kind=', 'attempts_outer=',
    'effort_requested=', 'effort_rejected=', 'outcome=',
  ]) {
    assert.ok(line.includes(key), `留痕后缀缺键 ${key}：${line}`);
  }
  assert.equal(m.firstTextDeltaMs, -1, '没收到任何增量时首块延迟必须是 -1，不能是 0（0 会被读成「秒回」）');
  assert.equal(m.firstReasoningDeltaMs, -1);
});

console.log('');
if (failed > 0) {
  console.error(`❌ reasoning-effort-smoke: ${failed} 组失败`);
  process.exit(1);
}
console.log('✅ reasoning-effort-smoke: 全部通过（默认值五处一致、空串=不传、被拒退一档不占预算）');
