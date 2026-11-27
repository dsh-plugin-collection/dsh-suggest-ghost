#!/usr/bin/env node
/**
 * 续写上下文字符上限（Gitea #190）冒烟：默认值一致 + 默认逐字节不变 + min 优先级 + 放宽生效。
 *
 * ## 它挡的是哪四类事故
 *
 * 1. **默认值分叉**。`2000` 这个数活在四个地方：`generate.ts` 的常量定义、schema 的
 *    `.default()`、`flattenConfig` 与 `resolveConfig` 两处 `readVolatile` 兜底。
 *    抄四份数字 ⇒ 任何一处改动都会让「解析层与拍平层给出不同默认值」（#124 记过这个形状）。
 *    本支把它收成**一个常量**，所以第 1 组断言核的是"都引符号、没人抄数字"。
 * 2. **默认行为被改掉**。这道上限今天就在生效，本次只是把它摆到明面上。
 *    ⇒ 第 3 组把"默认下续写带多少上下文"钉成**实测出来的黄金读数**（1488 字符 / 3 条），
 *    而不是写一个看起来合理的期望值 —— 那两个数字来自工单 #190 的实测表。
 * 3. **min 被"顺手优化"掉**。把 `min(预算, 这一项)` 改成直接读新键，会让
 *    「把转录字符预算调到 2000 以下」那批既有配置的续写上下文**悄悄变大**。
 *    第 5 组专门钉这个优先级。
 * 4. **修了实现忘了文案**。这个缺陷的另一半是卡片那句「送进模型的对话记录最多多长」
 *    对续写不成立 ⇒ 第 8 组断言那句文案现在必须提到续写另有上限。
 *
 * ## 为什么从 lib/ 导入
 * `generate.ts` 里有 `using` 声明，`node --experimental-strip-types` 剥不动它
 * （与 `reasoning-effort-smoke.mjs` 同一取舍）。改完 src 记得先
 * `./node_modules/.bin/tsc -p tsconfig.json && node build.mjs`
 * ——不重建就跑冒烟测的是旧字节码（`docs/gitea-workflow.md` §3，本轮又踩过一次）。
 *
 * 用法：`node scripts/completion-context-smoke.mjs`
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_COMPLETION_CONTEXT_CHARS, generateCompletion, resolveConfig } from '../lib/generate.js';
import { trimTranscript } from '../lib/transcript.js';

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

const KEY = 'completionContextChars';
/** 今天那道裸魔数 —— 默认值必须**等于它**，否则就不是"把上限摆到明面上"而是改行为。 */
const LEGACY_CAP = 2000;

// ── 1. 默认值单点：四处都引同一个符号，没有第二份数字 ──────────────────────────
run('默认值单点：常量 = 2000，schema 与两处 readVolatile 都引符号不抄数字', () => {
  assert.equal(DEFAULT_COMPLETION_CONTEXT_CHARS, LEGACY_CAP,
    `默认值变了（${DEFAULT_COMPLETION_CONTEXT_CHARS} ≠ ${LEGACY_CAP}）⇒ 这不是文案修正，是行为变化`);
  const gen = read('src/generate.ts');
  const host = read('src/index.ts');
  assert.match(gen, /export const DEFAULT_COMPLETION_CONTEXT_CHARS = 2000;/,
    '常量定义形态变了');
  assert.match(host, new RegExp(`${KEY}: z\\.natural\\(\\)\\.min\\(1\\)\\.default\\(DEFAULT_COMPLETION_CONTEXT_CHARS\\)\\.volatile\\(\\)`),
    'src/index.ts 的 schema 默认值没引常量（抄了数字 ⇒ 会与兜底分叉）');
  const reads = [...gen.matchAll(new RegExp(`readVolatile\\((?:config|raw)\\.${KEY},\\s*DEFAULT_COMPLETION_CONTEXT_CHARS\\)`, 'g'))];
  assert.equal(reads.length, 2, `应有 2 处 readVolatile 引常量，实得 ${reads.length}`);
  // 抄来的数字：generate.ts 的**代码行**里除了常量定义，不该再有第二个 `2000` 出现在这条链上。
  // 必须先剥注释行 —— 注释里那三处 `2000` 是在**记录这个魔数的历史**（"过去是 min(..., 2000)"），
  // 不剥掉就会把说明当成违规（本仓其它闸同口径：`client-import-surface-smoke` 也跳过注释行）。
  const codeLines = gen.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  const bare = [...codeLines.matchAll(/,\s*2000\)/g)];
  assert.equal(bare.length, 0, `src/generate.ts 的代码行里出现了抄来的 2000 兜底：${bare.map((m) => m[0])}`);
});

// ── 2. 其余登记点 ─────────────────────────────────────────────────────────────
run('登记点在场：Config / FlatConfig / SETTING_SPECS / 卡片 / 两份 README', () => {
  const gen = read('src/generate.ts');
  assert.match(gen, new RegExp(`${KEY}\\?: number;`), 'Config 里没有这一项');
  assert.match(gen, new RegExp(`${KEY}: number;`), 'FlatConfig 里不是裸 number');
  assert.match(read('src/live-settings.ts'), new RegExp(`^\\s*${KEY}: POS\\(1\\),`, 'm'),
    `${KEY} 不在 SETTING_SPECS 里 → 设置页改了不生效（#19 那一类）`);
  const card = read('src/client/settings-card.tsx');
  assert.match(card, new RegExp(`key: '${KEY}',`), '设置卡片里没有这一行');
  for (const file of ['README.md', 'README.en.md']) {
    assert.ok(read(file).includes(KEY), `${file} 里没有 ${KEY}`);
  }
});

// ── 3. 默认下的续写上下文 = 工单 #190 实测的那两个读数（黄金判据）──────────────
const mkFixture = (n) => Array.from({ length: n }, (_, i) => ({
  role: i % 2 === 0 ? 'user' : 'assistant',
  text: `msg${i} ${'x'.repeat(490)}`,
}));
const sumChars = (pairs) => pairs.reduce((a, p) => a + p.text.length, 0);

run('默认（预算 12000、上限 2000）：续写侧保持 1488 字符 / 3 条 —— 与 #190 实测逐字相同', () => {
  const pairs = mkFixture(60);
  const eff = Math.min(12000, DEFAULT_COMPLETION_CONTEXT_CHARS);
  const kept = trimTranscript(pairs, [], eff, 1 << 30).pairs;
  assert.equal(sumChars(kept), 1488, `默认上下文应为 1488 字符（今天的行为），实得 ${sumChars(kept)}`);
  assert.equal(kept.length, 3, `默认应保 3 条，实得 ${kept.length}`);
});

// ── 4. 放宽生效：把这一项调大，续写真的多带上下文 ──────────────────────────────
run('放宽到 8000：续写上下文真的变大（这一项不再是装饰品）', () => {
  const pairs = mkFixture(60);
  const before = trimTranscript(pairs, [], Math.min(12000, LEGACY_CAP), 1 << 30).pairs;
  const after = trimTranscript(pairs, [], Math.min(12000, 8000), 1 << 30).pairs;
  assert.ok(sumChars(after) > sumChars(before) * 3,
    `放宽后应显著变大：${sumChars(before)} → ${sumChars(after)}`);
});

// ── 5. min 优先级：预算被调到 2000 以下时，仍然以预算为准 ──────────────────────
run('min 语义保留：预算 1000 + 上限 8000 ⇒ 生效 1000（既有配置的行为不被悄悄改掉）', () => {
  const pairs = mkFixture(60);
  const eff = Math.min(1000, 8000);
  const kept = trimTranscript(pairs, [], eff, 1 << 30).pairs;
  assert.ok(sumChars(kept) <= 1000 + 490,
    `生效上限应是 1000 而不是 8000，实得 ${sumChars(kept)} 字符`);
  // 源码侧也必须还是 min —— 有人"简化"成直接读新键，这条当场红。
  const gen = read('src/generate.ts');
  assert.match(gen, /const completionContextChars = Math\.min\(\s*config\.maxTranscriptChars,\s*config\.completionContextChars \?\? DEFAULT_COMPLETION_CONTEXT_CHARS,?\s*\)/,
    '续写上下文不再是 min(预算, 这一项) ⇒ 会把"预算调到 2000 以下"那批用户的续写上下文悄悄放大');
});

// ── 6. 端到端：假 llm 收到的 user 文本长度随这一项变化 ────────────────────────
const userMsg = (seq, text) => ({
  type: 'user/message', seq, time: 0,
  data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] },
});
const asstMsg = (seq, turn, text) => ({
  type: 'assistant/message', seq, time: 0,
  data: { turn, message: { role: 'assistant', content: [{ type: 'text', text }] } },
});
const turnStart = (seq, turn) => ({ type: 'turn/start', seq, time: 0, data: { turn } });
const turnEnd = (seq, turn) => ({ type: 'turn/end', seq, time: 0, data: { turn, reason: { kind: 'completed' } } });

/** 20 个长回合：保证字符预算是绑住的那一道（ASCII，排除字节预算干扰）。 */
const bigSession = () => {
  const events = [];
  let seq = 0;
  for (let t = 1; t <= 20; t += 1) {
    events.push(turnStart(++seq, t));
    events.push(userMsg(++seq, `u${t} ${'y'.repeat(500)}`));
    events.push(asstMsg(++seq, t, `a${t} ${'z'.repeat(500)}`));
    events.push(turnEnd(++seq, t));
  }
  return { id: 'session-completion-context', snapshotEvents: () => events, requestHeader: () => ({ config: { provider: 'p', model: 'm' } }) };
};

const baseConfig = (over = {}) => ({
  provider: 'p-smoke', model: 'm-smoke',
  maxInputBytes: 1 << 30, maxOutputTokens: 256, timeoutMs: 5000,
  maxTranscriptChars: 12000, maxSuggestionChars: 240, inlineMaxChars: 160,
  maxRecentTurns: 20,
  ...over,
});

const textStream = (text) => (async function* () {
  yield { type: 'block-start', index: 0, blockType: 'text' };
  yield { type: 'text-delta', index: 0, text };
  yield { type: 'block-end', index: 0, block: { type: 'text', text } };
  yield { type: 'finish', reason: { kind: 'stop' } };
})();
const fakeCtx = () => {
  const calls = [];
  return { calls, llm: { stream: (o) => { calls.push(o); return textStream('然后推到远端'); } } };
};
const abortOf = () => new AbortController().signal;
const userTextOf = (options) => options.messages[0].content.map((b) => b.text).join('');

await run('端到端：默认配置下续写请求的上下文字符数 = 今天那道上限算出来的值', async () => {
  const ctx = fakeCtx();
  await generateCompletion(ctx, baseConfig(), bigSession(), '把改动', abortOf());
  const len = userTextOf(ctx.calls[0]).length;
  // min(12000, 2000) = 2000 ⇒ 上下文块 + 草稿标签，量级必须落在 2000 附近而不是 12000
  assert.ok(len < 2600, `默认应受 2000 约束，实得 user 文本 ${len} 字符`);
  const ctxWide = fakeCtx();
  await generateCompletion(ctxWide, baseConfig({ completionContextChars: 8000 }), bigSession(), '把改动', abortOf());
  const lenWide = userTextOf(ctxWide.calls[0]).length;
  assert.ok(lenWide > len * 2.5, `放宽后请求文本应显著变长：${len} → ${lenWide}`);
});

// ── 7. 0 / 负数硬拒（否则 min 交出 0 ⇒ 续写一条上下文都不带，且零留痕）──────────
run('0 与负数被 resolveConfig 硬拒，不静默退化成"只重复草稿"', () => {
  for (const bad of [0, -1, 1.5]) {
    assert.throws(
      () => resolveConfig(baseConfig({ completionContextChars: bad })),
      /completionContextChars must be a positive integer/,
      `${bad} 应当被拒`,
    );
  }
  assert.doesNotThrow(() => resolveConfig(baseConfig({ completionContextChars: 4000 })));
});

// ── 8. 文案与实现相符（这个缺陷的另一半）─────────────────────────────────────
run('「转录字符预算」的说明现在必须点明续写另有上限（**zh 与 en 两侧都要**）', () => {
  const card = read('src/client/settings-card.tsx');
  const row = /key: 'maxTranscriptChars',[\s\S]{0,700}?\n  \},/.exec(card);
  assert.ok(row !== null, '找不到 maxTranscriptChars 那一行');
  // 只核一侧会漏掉"改了中文忘了英文"——那正是 copy-source-check 整条闸要防的形状：
  // 中文界面下看着是对的，切到英文才露。上一版这里写成 zh|en 的或，
  // 变异自证当场把它打回（只改 zh 时全绿），所以两侧分别断言。
  // 必须从 **hint 块**里取：行内先出现的是 `label: { zh: … }`，
  // 上一版直接抓第一个 `zh:` 结果拿到的是字段名而不是说明（真实代码当场误红）。
  const hint = /hint: \{\s*zh: '([^']*)',\s*\n?\s*en: '([^']*)',/.exec(row[0]);
  assert.ok(hint !== null, `hint 块形态变了，取不到双语说明：${row[0].slice(0, 120)}`);
  const [, zh, en] = hint;
  assert.match(zh, /续写上下文上限/, `中文说明没提续写另有上限：${zh}`);
  assert.match(en, /Completion context cap/i, `英文说明没提续写另有上限：${en}`);
});

console.log('');
if (failed > 0) {
  console.error(`❌ completion-context-smoke: ${failed} 组失败`);
  process.exit(1);
}
console.log('✅ completion-context-smoke: 全部通过（默认值单点、默认逐字节不变、min 优先级、放宽生效、0/负数硬拒、文案相符）');
