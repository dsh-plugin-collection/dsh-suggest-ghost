#!/usr/bin/env node
/**
 * 流式增量留痕（#39）与终帧字段冒烟。
 *
 * ## 钉住的四件事
 *
 * 1. **计数正确**：`observeChunk` 是纯函数，喂假流逐块断言。两个首块延迟必须
 *    **分开**（`first_text_delta_ms` / `first_reasoning_delta_ms`）：推理模型先出
 *    reasoning、很久之后才出正文，合成一个数会把「用户在干等」记成正常
 *    （沙箱实测 qfmodel 缺省档 reasoning 806ms / text 1410ms，efficient 首块 6147ms）。
 * 2. **归因分得开**：`outcome=empty` 与 `outcome=filtered` 是两条不同的病因
 *    （前者指向提示词/档位/路由，后者指向净化链）。`src/generate.ts` 里那条注释
 *    早就声称有归因日志而代码里没有，这条断言就是把它钉成可执行的。
 * 3. **既有留痕前缀与既有键不许变**：`package.json` 的 `sandbox.greps` 与
 *    `scripts/dev-sandbox.mjs` 靠它们抓行。新键一律行尾追加。
 * 4. **终帧字段不许被静默丢掉**：载荷重建有三个出口（生成、重启对账、投影 fold），
 *    投影面的 zod 默认**剥未知键**。漏任何一个，客户端就按「旧载荷」兜底，
 *    表现为重启后判据凭空失效。
 *
 * 端到端用例从构建产物 `lib/` 导入（`generate.ts` 里有 `using`，
 * `--experimental-strip-types` 剥不动），改完 src 记得先 `node build.mjs`。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStreamMetrics, formatStreamMetrics, generateCompletion, generateSuggestion, observeChunk } from '../lib/generate.js';
import { parsePersistedPush } from '../lib/coldstart.js';
import { applySuggestGhostProjection, initSuggestGhostProjection, suggestGhostSchema } from '../lib/projection.js';

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

// ── 1. observeChunk：纯函数逐块断言 ─────────────────────────────────────────────
run('observeChunk：正文/推理分开计数，两个首块延迟各自成数', () => {
  const m = createStreamMetrics('low');
  const t0 = 1000;
  // 推理先到（档位带来的就是这段），正文晚到。
  observeChunk(m, { type: 'block-start', index: 0, blockType: 'reasoning' }, t0, 1200);
  observeChunk(m, { type: 'reasoning-delta', index: 0, text: '让我想想' }, t0, 1206);
  observeChunk(m, { type: 'reasoning-delta', index: 0, text: '下一步' }, t0, 1300);
  observeChunk(m, { type: 'block-start', index: 1, blockType: 'text' }, t0, 1400);
  observeChunk(m, { type: 'text-delta', index: 1, text: '跑测试' }, t0, 1410);
  observeChunk(m, { type: 'text-delta', index: 1, text: ' 并观察' }, t0, 1500);
  observeChunk(m, { type: 'usage', usage: { input: 1, output: 2 } }, t0, 1501);
  observeChunk(m, { type: 'finish', reason: { kind: 'stop' } }, t0, 1502);

  assert.equal(m.firstReasoningDeltaMs, 206, 'first_reasoning_delta_ms 应是推理增量距起点的耗时');
  assert.equal(m.firstTextDeltaMs, 410, 'first_text_delta_ms 应是正文增量距起点的耗时');
  assert.equal(m.reasoningDeltas, 2);
  assert.equal(m.reasoningChars, 7, '推理字符数按增量累加（让我想想=4 + 下一步=3）');
  assert.equal(m.contentDeltas, 2);
  assert.equal(m.contentChars, 7, '正文字符数只算正文（跑测试=3 + ␣并观察=4）');
  assert.equal(m.finishKind, 'stop');
  assert.equal(m.effortRequested, 'low', '留痕记的是**请求**的档位，不是宿主终值');
});

run('observeChunk：非推理模型只出正文；空流两个首块都留 -1', () => {
  const textOnly = createStreamMetrics('inherit');
  observeChunk(textOnly, { type: 'text-delta', index: 0, text: 'x' }, 0, 50);
  assert.equal(textOnly.firstReasoningDeltaMs, -1, '没有推理增量必须是 -1，不是 0');
  assert.equal(textOnly.firstTextDeltaMs, 50);
  assert.equal(textOnly.reasoningChars, 0);

  const nothing = createStreamMetrics('inherit');
  observeChunk(nothing, { type: 'finish', reason: { kind: 'max-tokens' } }, 0, 999);
  assert.equal(nothing.firstTextDeltaMs, -1);
  assert.equal(nothing.firstReasoningDeltaMs, -1);
  assert.equal(nothing.finishKind, 'max-tokens', '终止原因要落进留痕（max-tokens 与 stop 是两种病）');
});

run('formatStreamMetrics：只打计数与耗时，不打正文', () => {
  const m = createStreamMetrics('low');
  observeChunk(m, { type: 'text-delta', index: 0, text: '这段正文绝不能出现在留痕里' }, 0, 10);
  const line = formatStreamMetrics(m);
  assert.ok(!line.includes('这段正文'), `留痕抄了正文：${line}`);
  assert.match(line, /first_text_delta_ms=10 .*content_chars=13.*effort_requested=low effort_rejected=0 outcome=empty/s);
});

// ── 2. 归因：空回复 vs 被过滤 ───────────────────────────────────────────────────
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
const fakeSession = () => ({
  id: 'session-metrics-smoke',
  snapshotEvents: () => [
    turnStart(1, 1), userMsg(2, '把冒烟跑一遍'), asstMsg(3, '跑完了，全绿。'), turnEnd(4, 1),
  ],
  requestHeader: () => ({ config: { provider: 'p-smoke', model: 'm-smoke' } }),
});
const baseConfig = (over = {}) => ({
  maxInputBytes: 4096, maxOutputTokens: 512, timeoutMs: 5000,
  maxTranscriptChars: 12000, maxSuggestionChars: 240, ...over,
});
const abortOf = () => new AbortController().signal;
/** 用给定文本回一次流。 */
const ctxReturning = (text) => {
  const calls = [];
  return {
    calls,
    llm: {
      stream(options) {
        calls.push(options);
        return (async function* () {
          yield { type: 'block-start', index: 0, blockType: 'text' };
          if (text.length > 0) yield { type: 'text-delta', index: 0, text };
          yield { type: 'block-end', index: 0, block: { type: 'text', text } };
          yield { type: 'finish', reason: { kind: 'stop' } };
        })();
      },
    },
  };
};

await run('outcome=empty：模型一个字没吐（有流、有 finish、没有 delta）', async () => {
  const result = await generateSuggestion(ctxReturning(''), baseConfig(), fakeSession(), 1, abortOf());
  assert.equal(result.suggestion, undefined, '空回复 = 无建议（不是失败）');
  assert.equal(result.metrics.outcome, 'empty');
  assert.equal(result.metrics.finishKind, 'stop', '传输层是成功的——病因在模型没说话');
  assert.equal(result.metrics.contentDeltas, 0);
});

await run('outcome=filtered：模型吐了字但被过滤链丢掉', async () => {
  // 助手口吻 + 问句：cleanSuggestion 有产出，shouldFilterSuggestion 判为不合格。
  const ctx = ctxReturning('Let me know if you would like me to continue?');
  const result = await generateSuggestion(ctx, baseConfig(), fakeSession(), 1, abortOf());
  assert.equal(result.suggestion, undefined, '不合格回复 = 无建议');
  assert.equal(result.metrics.outcome, 'filtered',
    `吐了字却被丢掉必须记 filtered（记成 empty 会把病因指向提示词，而真凶是净化链）`);
  assert.ok(result.metrics.contentChars > 0, 'filtered 的判据就是「原文有内容」');
});

await run('outcome=ok：正常产出，并带上终帧字段 frame=1 / final=true', async () => {
  const result = await generateSuggestion(ctxReturning('跑一下测试'), baseConfig(), fakeSession(), 7, abortOf());
  const suggestion = result.suggestion;
  assert.ok(suggestion !== undefined);
  assert.equal(suggestion.outcome, undefined, 'outcome 只在 metrics 上，不混进载荷');
  assert.equal(result.metrics.outcome, 'ok');
  assert.equal(suggestion.frame, 1, '本期宿主一次生成只出一帧，帧号恒 1');
  assert.equal(suggestion.final, true, '本期恒终帧');
  assert.equal(suggestion.version, 1, 'version 不升：新字段可缺省，客户端兜底');
});

await run('续写的归因同样分得开（sanitizeCompletion 丢掉但不区分，由留痕层分）', async () => {
  // 原文非空但净化链判不合格 → filtered
  const filtered = await generateCompletion(
    ctxReturning('这是一段成段的回答，明显不是在续写草稿，而是把草稿里的问题回答了一遍，长度也远超草稿的形态兜底阈值，所以应当被 shouldFilterCompletionFor 拦下。'),
    baseConfig(),
    fakeSession(),
    '跑测试',
    abortOf(),
  );
  assert.equal(filtered.text, undefined);
  assert.equal(filtered.metrics.outcome, 'filtered');
  // 原文为空 → empty
  const empty = await generateCompletion(ctxReturning(''), baseConfig(), fakeSession(), '跑测试', abortOf());
  assert.equal(empty.metrics.outcome, 'empty');
});

// ── 3. 既有留痕行：前缀与既有键不许变，新键只许行尾追加 ─────────────────────────
run('src/index.ts：两条既有续写留痕的前缀与既有键原样，新键追加在行尾', () => {
  const host = read('src/index.ts');
  const generated = /traceOps\(`(completion generated session=\$\{sessionId\} draftChars=\$\{draftChars\} chars=\$\{value\.text\.length\} in \$\{elapsedMs\}ms)(.*)`\)/.exec(host);
  assert.ok(generated !== null, '`completion generated` 那行的前缀与既有键被改了（sandbox.greps 依赖它）');
  assert.ok(generated[2].trimStart().startsWith('${stream}'),
    `新增键必须追加在行尾且不动既有部分，实得：${generated[2]}`);
  const dropped = /traceOps\(`(completion dropped \(empty or filtered\) session=\$\{sessionId\} draftChars=\$\{draftChars\} in \$\{elapsedMs\}ms)(.*)`\)/.exec(host);
  assert.ok(dropped !== null, '`completion dropped (empty or filtered)` 那行的前缀与既有键被改了');
  assert.ok(dropped[2].trimStart().startsWith('${stream}'), '同上：只允许行尾追加');
});

run('src/index.ts：「下一条建议」路径补了耗时留痕（此前只有续写有）', () => {
  const host = read('src/index.ts');
  // 三条出口都要有行：产出 / 无产出（带归因）/ 失败。
  for (const prefix of [
    'suggestion generated session=',
    'suggestion dropped (empty or filtered) session=',
    'suggestion failed session=',
  ]) {
    assert.ok(host.includes(prefix), `建议路径缺留痕行：${prefix}`);
  }
  // 生成的那行必须带耗时（这是 #39 的本体），且带上帧号。
  const line = /traceOps\(`suggestion generated session=\$\{session\.id\}[^`]*`\)/.exec(host);
  assert.ok(line !== null, '`suggestion generated` 行形态变了');
  assert.ok(/in \$\{Date\.now\(\) - genStartedAt\}ms/.test(line[0]), '建议那行必须报耗时');
  assert.ok(/frame=/.test(line[0]), '建议那行要能把帧号带出来（终帧判据的可观测面）');
  assert.ok(/effort_rejected=/.test(formatProbe()), '增量后缀必须含 effort_rejected（这类失败要能统计）');
});
/** 上面那条断言的取值器：留痕后缀由 formatStreamMetrics 单点产出。 */
function formatProbe() {
  return formatStreamMetrics(createStreamMetrics('inherit'));
}

run('package.json：sandbox.greps 覆盖了两条既有前缀与新增的建议前缀', () => {
  const greps = JSON.parse(read('package.json')).sandbox.greps;
  for (const need of [
    'completion generated',
    'completion dropped (empty or filtered)',
    'suggestion generated',
    'suggestion dropped (empty or filtered)',
    'suggestion failed',
  ]) {
    assert.ok(greps.includes(need), `sandbox.greps 少了 ${JSON.stringify(need)}：沙箱验收抓不到这一行`);
  }
});

// ── 4. 终帧字段的三个重建出口都不许丢 ───────────────────────────────────────────
const SUGGEST_EVENT = 'suggest-ghost/suggested';

run('domain.ts / settings.ts：载荷形状声明了 frame/final（客户端按这两个键名读）', () => {
  const domain = read('src/domain.ts');
  assert.match(domain, /readonly frame\?: number;/, 'SuggestGhostSuggested 里没有 frame?: number');
  assert.match(domain, /readonly final\?: boolean;/, 'SuggestGhostSuggested 里没有 final?: boolean');
  const settings = read('src/settings.ts');
  // GhostPushPayload 里这两个键是**必填**：pushToClient 是统一补值的出口。
  assert.match(settings, /readonly frame: number;/, 'GhostPushPayload.suggestion.frame 没登记');
  assert.match(settings, /readonly final: boolean;/, 'GhostPushPayload.suggestion.final 没登记');
});

run('coldstart.parsePersistedPush：盘上有就原样带回，盘上没有就补 1/true', () => {
  const push = (over) => JSON.stringify({
    suggestion: { turn: 3, baseSeq: 9, text: '跑测试', truncated: false, acceptKey: 'Tab', ...over },
    suggestionSessionId: 'session-1',
  });
  const carried = parsePersistedPush(push({ frame: 2, final: true }));
  assert.equal(carried.suggestion?.frame, 2, '盘上是 2 就必须带 2，不能被重置成 1');
  assert.equal(carried.suggestion?.final, true);
  const legacy = parsePersistedPush(push({}));
  assert.equal(legacy.suggestion?.frame, 1, '旧载荷缺键 → 补 1（本期一次生成只有一帧）');
  assert.equal(legacy.suggestion?.final, true);
  // 终帧标记为 false 的载荷不能被悄悄改成 true（那是把「不可采纳」说成「可采纳」）。
  const provisional = parsePersistedPush(push({ frame: 3, final: false }));
  assert.equal(provisional.suggestion?.final, false, 'final:false 必须原样保留');
});

run('projection：zod 不剥 frame/final，fold 也逐字段带上（否则重启后判据像随机失效）', () => {
  const parsed = suggestGhostSchema.parse({
    suggestion: { version: 1, turn: 3, baseSeq: 9, text: 'x', truncated: false, acceptKey: 'Tab', frame: 2, final: true },
    hot: null,
  });
  assert.equal(parsed.suggestion.frame, 2, 'suggestionSchema 没登记 frame → zod 会静默剥键');
  assert.equal(parsed.suggestion.final, true, 'suggestionSchema 没登记 final → zod 会静默剥键');
  const folded = applySuggestGhostProjection(
    initSuggestGhostProjection(),
    { type: SUGGEST_EVENT, seq: 1, data: { version: 1, turn: 3, baseSeq: 9, text: 'x', truncated: false, acceptKey: 'Tab', frame: 2, final: true } },
  );
  assert.equal(folded.suggestion?.frame, 2, 'fold 的逐字段重建漏了 frame');
  assert.equal(folded.suggestion?.final, true, 'fold 的逐字段重建漏了 final');
  // 旧事件（没有帧字段）fold 后仍是 null 兜底而不是 0：0 留给「客户端按旧载荷处理」这一档。
  const legacyFolded = applySuggestGhostProjection(
    initSuggestGhostProjection(),
    { type: SUGGEST_EVENT, seq: 2, data: { version: 1, turn: 4, baseSeq: 10, text: 'y', truncated: false, acceptKey: 'Tab' } },
  );
  assert.equal(legacyFolded.suggestion?.frame, undefined, '事件里没有帧语义时不要伪造一个 1 出来');
});

// ── 5. 契约：续写载荷只加 final，不加 frame ─────────────────────────────────────
run('src/index.ts：suggestion 载荷带 frame+final，completion 载荷只带 final', () => {
  const host = read('src/index.ts');
  const suggestionBlock = /suggestion: p\.suggestion === null \? null : \{[\s\S]*?\},\n\s*suggestionSessionId/.exec(host);
  assert.ok(suggestionBlock !== null, '找不到 _push 里 suggestion 载荷的构造处');
  assert.match(suggestionBlock[0], /frame: p\.suggestion\.frame \?\? 1/);
  assert.match(suggestionBlock[0], /final: p\.suggestion\.final \?\? true/);
  const completionBlock = /completion: \{ draft: p\.completion\.draft[^}]*\}/.exec(host);
  assert.ok(completionBlock !== null, '找不到 _push 里 completion 载荷的构造处');
  assert.match(completionBlock[0], /final: true/, '续写载荷必须带 final:true');
  assert.ok(!/frame/.test(completionBlock[0]),
    '续写载荷**不许**带 frame：续写的代次只能靠 draft 判定（#33 之后草稿允许继续变长）');
});

console.log('');
if (failed > 0) {
  console.error(`❌ stream-metrics-smoke: ${failed} 组失败`);
  process.exit(1);
}
console.log('✅ stream-metrics-smoke: 全部通过（增量计数、空/过滤归因、既有前缀不变、终帧字段三处不丢）');
