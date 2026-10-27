#!/usr/bin/env node
/**
 * (a3) 真实回合：接线层在**一次真回合里**确实把留痕行打出来了（Gitea #54；task-15）。
 *
 * ## 这条脚本存在的理由
 *
 * `scripts/ghost-frame-e2e.mjs` 里 (a3) 一直是 NOT-COVERED，理由写得诚实：那个 harness
 * 直接调 `generateSuggestion` / `generateCompletion`，而留痕行是**接线层**（`src/index.ts`）
 * 打的，函数被直接调用时 `apply()` 不在场 ⇒ 捕获 0 行是必然。
 * 本脚本补的就是「apply() 在场」这一层：真 `Context` + 真 `dsh-session` + 内存 settings 面
 * + **注入假 llm 作为 `llm` 服务** + 喂一个真的 `turn/end` 事件，然后断言 stdout 里
 * 真的出现 `suggestion generated …` / `completion generated …` 这些**既有前缀**
 * （`package.json` 的 `sandbox.greps` 认的就是它们），并核行尾键名与数值。
 *
 * ## 三种失败必须分开报（这是 #54 点名要的能力）
 *
 * 旧现象是三者混成「捕获 0 行」：
 *  - **产物没构建** → NOT-COVERED（`lib/index.js` 不在，谈不上行为）
 *  - **接线层没跑到**（`apply called` 都没有 / 事件没进 handler）→ FAIL，并列出实际打过的
 *    留痕前缀，让人一眼分清「根本没跑」与「跑了没打」
 *  - **留痕行打了但值不对** → FAIL，逐键打期望与实际
 *
 * ## 与另两条脚本的分工
 *
 *  - `ghost-frame-e2e.mjs`：纯函数层（数值算得对）+ 静态在场（打点还在）
 *  - `ghost-frame-cell-e2e.mjs`：客户端读侧行为（纯热度变化不重解析建议格）
 *  - 本脚本：接线层真打这一行
 * 三条各自证据源，谁也不替代谁。
 *
 * 用法：`node scripts/ghost-frame-real-e2e.mjs [--repo <dir>]`
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { Context, Service } from '@deepseek-ai/cordis';
import { SessionStore } from '@deepseek-ai/dsh-session';
// 留痕自 2026-10-26 起分级：默认只有 warn/error 到达用户侧（心跳类走 console.debug 静默）。
// 本脚本靠抓 `[ops-trace]` 文本断言行为，故在加载插件前把门槛放到 debug。
// 这是**测试自己开档**，不改生产默认。
process.env.DSH_SUGGEST_GHOST_TRACE ??= 'debug';

const argv = process.argv.slice(2);
const i = argv.indexOf('--repo');
const repo = resolve(i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dirname(dirname(fileURLToPath(import.meta.url))));
const libDir = join(repo, 'lib');
const NS = 'suggest-ghost';

const STATUS = { PASS: 'PASS', FAIL: 'FAIL', NC: 'NOT-COVERED' };
const results = [];
function record(name, status, detail) {
  results.push({ name, status, detail });
  const mark = status === STATUS.PASS ? '✅' : status === STATUS.FAIL ? '❌' : '⚪';
  console.log(`${mark} [${status}] ${name}${detail ? `\n     ${detail.replace(/\n/g, '\n     ')}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 假流的形状（与 `ghost-frame-e2e.mjs` 同一份口径，两条脚本的期望值因此可交叉核对）。 */
const REASONING_DELTAS = 3;
const TEXT_DELTAS = 5;
const REASONING_TEXTS = ['想', '一下', '怎么构', '建'];
const TEXT_CHUNKS = ['把', '构建', '脚本', '改', '一下'];
const FINISH_KIND = 'stop';
const expectedReasoningChars = REASONING_TEXTS.slice(0, REASONING_DELTAS).join('').length;
const expectedContentChars = TEXT_CHUNKS.join('').length;

console.log(`ghost-frame-real-e2e：产物来源 ${repo}`);

// ── 0. 产物：没构建就是 NOT-COVERED，不能算 FAIL ────────────────────────────
if (!existsSync(join(libDir, 'index.js')) || !existsSync(join(libDir, 'generate.js'))) {
  record('宿主产物就位（lib/index.js + lib/generate.js）', STATUS.NC,
    `缺前置：${libDir} 里缺编译产物。先在那棵树上跑 ./node_modules/.bin/tsc -p tsconfig.json && node build.mjs`);
  finish();
  process.exit(0);
}

// ── 1. 留痕捕获：两个通道都接（traceOps 走 log，客户端 traceOnce 走 warn）──────
const traceLines = [];
const realLog = console.log.bind(console);
const realWarn = console.warn.bind(console);
const swallow = (line) => line.includes('[ops-trace]') || line.includes('[suggest-ghost]');
console.log = (...args) => { const l = args.map(String).join(' '); if (swallow(l)) traceLines.push(l); else realLog(l); };
console.warn = (...args) => { const l = args.map(String).join(' '); if (swallow(l)) traceLines.push(l); else realWarn(l); };
// 留痕分级（2026-10-26）：`suggestion generated` / `completion generated` 是心跳级 ⇒
// console.debug。不挂这两个通道，本用例会把「打到别的流」误判成「留痕没出现」。
const realDebug = console.debug.bind(console);
const realInfo = console.info.bind(console);
console.debug = (...args) => { const l = args.map(String).join(' '); if (swallow(l)) traceLines.push(l); else realDebug(l); };
console.info = (...args) => { const l = args.map(String).join(' '); if (swallow(l)) traceLines.push(l); else realInfo(l); };

/** 取某条前缀的最后一次出现（同一前缀可能被多回合打多次）。 */
const lastLineWith = (needle) => traceLines.filter((l) => l.includes(needle)).pop() ?? null;

// ── 2. 内存 settings 面（照 coldstart-e2e 的 0.2.x 口径）─────────────────────
function makeMedium(initial = {}) {
  let document = structuredClone(initial);
  return {
    read: (ns) => structuredClone(document[ns] ?? {}),
    merge: (ns, patch) => { document = { ...document, [ns]: { ...document[ns], ...structuredClone(patch) } }; },
  };
}

function installSettingsService(root, medium) {
  class MemorySettings extends Service {
    revision = 0;
    constructor(ctx) { super(ctx, 'settings'); }
    describe() { return [{ ns: NS, revision: this.revision, value: medium.read(NS) }]; }
    update(ns, patch) {
      medium.merge(ns, patch);
      this.revision += 1;
      this.ctx.emit('settings/document-updated', ns, this.revision);
      return Promise.resolve();
    }
  }
  return new MemorySettings(root);
}

// ── 3. 假 llm 作为**服务**注入（注册名必须是 `llm`，插件 inject 的就是它）──────
//
// 形状两处坑（都在本仓实测踩过，字面抄在这里防止再踩）：
//  - `text-delta` / `reasoning-delta` 的字段名是 **`text`**，不是 `delta`/`content`；
//  - `finish.reason` 是对象 `{ kind: 'stop' }`，写成字符串会被 `finishError()` 读成
//    `undefined.kind`，抛 `unsupported finish reason "undefined"`，现象与「模型没话说」同形。
function installFakeLlm(root) {
  const requests = [];
  class FakeLlm extends Service {
    constructor(ctx) { super(ctx, 'llm'); }
    stream(options) {
      requests.push(options);
      const chunks = [
        { type: 'block-start', index: 0, blockType: 'reasoning' },
        ...REASONING_TEXTS.slice(0, REASONING_DELTAS).map((text) => ({ type: 'reasoning-delta', index: 0, text })),
        { type: 'block-end', index: 0, block: { type: 'reasoning', text: REASONING_TEXTS.slice(0, REASONING_DELTAS).join('') } },
        { type: 'block-start', index: 1, blockType: 'text' },
        ...TEXT_CHUNKS.map((text) => ({ type: 'text-delta', index: 1, text })),
        { type: 'block-end', index: 1, block: { type: 'text', text: TEXT_CHUNKS.join('') } },
        { type: 'usage', usage: { input: 24, output: TEXT_CHUNKS.length } },
        { type: 'finish', reason: { kind: FINISH_KIND } },
      ];
      return (async function* emit() {
        for (const chunk of chunks) { await sleep(3); yield chunk; }
      })();
    }
  }
  const service = new FakeLlm(root);
  return { service, requests };
}

// ── 4. 装配并跑一次真实回合 ────────────────────────────────────────────────
const medium = makeMedium();
const root = new Context();
if (root.logger === undefined) root.logger = { info() {}, warn() {}, debug() {} };
new SessionStore(root);
const settings = installSettingsService(root, medium);
const { requests: llmRequests } = installFakeLlm(root);

const { apply: applyHost } = await import(pathToFileURL(join(libDir, 'index.js')).href);

// 回合结束触发生成；停顿续写由 `_ops` 的 complete 触发。两条都留够时间。
applyHost(root, {
  provider: 'fake-provider',
  model: 'fake-model',
  maxInputBytes: 4096,
  maxOutputTokens: 256,
  timeoutMs: 8000,
  maxTranscriptChars: 4000,
  maxSuggestionChars: 120,
  inlineDelayMs: 50,
  inlineMinChars: 2,
  inlineMaxChars: 120,
  llmEnabled: true,
  historyEnabled: true,
  inlineEnabled: true,
});

const SESSION = 'round-session';
const session = root.sessions.create(SESSION, { meta: { cwd: process.cwd() } });

// ── 4.1 停顿续写：客户端写一条 `complete` 到 `_ops`，宿主生成并打行 ────────────
await settings.update(NS, {
  _ops: JSON.stringify({ rev: 1, ops: [{ op: 'complete', sessionId: SESSION, draft: '这个插件怎么' }] }),
});
for (let t = 0; t < 120 && lastLineWith('completion generated') === null
  && lastLineWith('completion dropped') === null; t += 1) await sleep(25);

// ── 4.2 真实回合：turn/start → user/message → turn/end（reason.kind=completed）──
session.append('turn/start', { turn: 1 });
session.append('user/message', {
  content: [{ type: 'text', text: '这个插件怎么构建' }],
  source: { kind: 'user' },
}, { surfaceOp: 'append' });
session.append('assistant/message', {
  turn: 1, step: 1,
  message: { role: 'assistant', content: [{ type: 'text', text: '在仓根跑 node build.mjs。' }] },
  stream: [],
}, { surfaceOp: 'append' });
session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });

for (let t = 0; t < 160 && lastLineWith('suggestion generated') === null
  && lastLineWith('suggestion dropped') === null; t += 1) await sleep(25);
await sleep(60);

// ── 5. 断言：apply 在场 → 行出现 → 键名与数值符合契约 ────────────────────────
const applyLine = lastLineWith('apply called');
if (applyLine === null) {
  record('(a3) 接线层跑到（apply called 在场）', STATUS.FAIL,
    `实际打过的留痕前缀（${traceLines.length} 行）：`
    + `${traceLines.slice(0, 6).map((l) => l.slice(0, 90)).join(' / ') || '（一行都没有）'}\n`
    + '这一条专门用来区分「根本没跑到接线层」与「跑到了但没打这行」：现在两种都会落在这里，'
    + '但输出里带着实际见过的前缀清单，能一眼看出是哪一种。');
} else {
  record('(a3) 接线层跑到（apply called 在场）', STATUS.PASS, applyLine.slice(0, 140));
}

const METRICS = {
  first_text_delta_ms: (v) => Number(v) >= 0,
  first_reasoning_delta_ms: (v) => Number(v) >= 0,
  content_deltas: (v) => Number(v) === TEXT_DELTAS,
  content_chars: (v) => Number(v) === expectedContentChars,
  reasoning_deltas: (v) => Number(v) === REASONING_DELTAS,
  reasoning_chars: (v) => Number(v) === expectedReasoningChars,
  finish_kind: (v) => v === FINISH_KIND,
  attempts_outer: (v) => Number(v) >= 1,
  effort_requested: (v) => v.length > 0,
  effort_rejected: (v) => v === '0' || v === '1',
  outcome: (v) => ['ok', 'empty', 'filtered'].includes(v),
};

/** 验一行留痕：前缀在不在、11 个键齐不齐、每个键的值合不合契约。 */
async function assertTraceLine(label, prefix) {
  const line = lastLineWith(prefix);
  if (line === null) {
    record(`${label}（前缀 ${prefix}）`, STATUS.FAIL,
      `接线层已跑到（上面那条 PASS 为证），但这一个前缀一次都没出现。\n`
      + `本次打过的全部 ${traceLines.length} 行留痕前缀：`
      + `${[...new Set(traceLines.map((l) => (/\[ops-trace\] ([a-z]+ ?[a-z-]*?)(?: session| rev|:)/.exec(l) ?? [, l.slice(0, 60)])[1].trim()))].join(' | ')}\n`
      + `假 llm 被调 ${llmRequests.length} 次 —— 若为 0 说明触发条件没满足（回合结束/complete 没进生成路径），不是留痕丢了。`);
    return;
  }
  const pairs = [...line.matchAll(/([a-z_][a-z0-9_]*)=(\S*)/g)].map(([, k, v]) => [k, v]);
  const got = new Map(pairs);
  const missingKeys = Object.keys(METRICS).filter((k) => !got.has(k));
  const badValues = Object.entries(METRICS)
    .filter(([k, check]) => got.has(k) && !check(got.get(k)))
    .map(([k]) => `${k}=${String(got.get(k))}`);
  record(`${label}：真实回合里真的打出这一行，且键名与数值符合契约`,
    missingKeys.length === 0 && badValues.length === 0 ? STATUS.PASS : STATUS.FAIL,
    `实得行：${line.replace(/\s+/g, ' ').slice(0, 260)}\n`
    + `期望 11 键：${Object.keys(METRICS).join(' / ')}\n`
    + `期望值：content_deltas=${TEXT_DELTAS} content_chars=${expectedContentChars}`
    + ` reasoning_deltas=${REASONING_DELTAS} reasoning_chars=${expectedReasoningChars}`
    + ` finish_kind=${FINISH_KIND}、两个首块延迟 ≥0 且 reasoning ≤ text、outcome∈{ok,empty,filtered}`
    + (missingKeys.length > 0 ? `\n     缺键：${missingKeys.join(', ')}` : '')
    + (badValues.length > 0 ? `\n     值不符：${badValues.join(', ')}` : ''));
  const firstText = Number(got.get('first_text_delta_ms'));
  const firstReasoning = Number(got.get('first_reasoning_delta_ms'));
  record(`${label}：两个首块延迟分开记（first_reasoning ≤ first_text）`,
    Number.isFinite(firstText) && Number.isFinite(firstReasoning)
      && firstReasoning >= 0 && firstText >= firstReasoning ? STATUS.PASS : STATUS.FAIL,
    `first_reasoning_delta_ms=${String(firstReasoning)} first_text_delta_ms=${String(firstText)}\n`
    + '（假流故意让 reasoning 先到；非推理模型那条形态下 first_reasoning 会是 -1，'
    + '那种时候**不能**用这条 ≥ 判据——本脚本的假流不是那种形态，所以断言成立）');
}

await assertTraceLine('(a3) 续写留痕', 'completion generated');
await assertTraceLine('(a3) 建议留痕', 'suggestion generated');

// 载荷侧的同一条事实：真实回合产出的建议格确实带 frame/final（与 (a3) 同一现场，不再靠合成）。
// ⚠️ `medium.read(NS)._push` **本身已经是 JSON 字符串**，不能再 JSON.stringify 一遍：
// 第一版这么写了，parse 回来的是个字符串而不是对象，于是这条断言永远落 NOT-COVERED，
// 而现场明明打出了 `suggestion generated`——「拿不到证据」与「证据不存在」又差点混成一种。
const pushRaw = medium.read(NS)?._push;
let pushedSuggestion = null;
let pushParseNote = '';
if (typeof pushRaw === 'string' && pushRaw !== '') {
  try {
    const parsed = JSON.parse(pushRaw);
    pushedSuggestion = parsed?.suggestion ?? null;
    pushParseNote = `_push 原文 ${pushRaw.length} 字节，解析成功`;
  } catch (error) {
    pushParseNote = `解析抛错：${String(error).slice(0, 80)}`;
  }
} else {
  pushParseNote = `_push 类型=${typeof pushRaw} 长度=${pushRaw === undefined ? 'undefined' : String(pushRaw.length)}`;
}
record('(a3) 同一次真实回合写出的建议格带 frame/final',
  pushedSuggestion !== null && typeof pushedSuggestion.frame === 'number'
    && pushedSuggestion.frame >= 1 && pushedSuggestion.final === true
    ? STATUS.PASS : STATUS.NC,
  pushedSuggestion === null
    ? `缺前置：介质上读不出建议对象（本次回合可能被判为 dropped / 未推）。${pushParseNote}`
    : `suggestion.frame=${String(pushedSuggestion.frame)} suggestion.final=${String(pushedSuggestion.final)}（真实回合的直接产物）`);

function finish() {
  const counts = results.reduce((acc, r) => { acc[r.status] = (acc[r.status] ?? 0) + 1; return acc; }, {});
  console.log('');
  console.log(`汇总：PASS ${counts[STATUS.PASS] ?? 0} · FAIL ${counts[STATUS.FAIL] ?? 0} · NOT-COVERED ${counts[STATUS.NC] ?? 0}`);
  for (const r of results) console.log(`  ${r.status.padEnd(11)} ${r.name}`);
}

// 收尾：把真 Context 拆掉，别在测试进程里留悬挂 fiber。
try { await root[Symbol.asyncDispose]?.(); } catch { /* 尽力而为 */ }
finish();
process.exit(results.some((r) => r.status === STATUS.FAIL) ? 1 : 0);
