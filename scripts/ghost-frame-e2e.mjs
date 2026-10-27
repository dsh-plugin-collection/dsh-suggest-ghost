#!/usr/bin/env node
/**
 * 终态帧端到端验收（Gitea #38 载荷契约 × #39 留痕 × #41 宿主字段；task-11）。
 *
 * ## 这条脚本要回答的唯一问题
 *
 * 「宿主出的那份载荷，客户端吃下去之后判成了什么？」——本轮三条线各自有单元冒烟，
 * 但**接缝从来没有被一条命令跑过**。这条脚本就是那条命令。
 *
 * ## 为什么是进程内 harness 而不是隔离沙箱（lead 决策，2026-10-21）
 *
 * 1. 沙箱里「触发一次真实回合」在本仓**没有先例**：`hotness-persist-e2e.mjs` 与
 *    `coldstart-e2e.mjs` 都是进程内起真实 Context，不碰 GUI。自创一套触发协议 = 引入
 *    一个只有本文知道的约定，正是 #34/#20 反复付过学费的那种债。
 * 2. 沙箱的插件产物来自 `git rev-parse --show-toplevel` 的 `lib/`（`dev-sandbox.mjs:340`），
 *    也就是说它只能验「已经合并进这条分支的东西」。三条分支未合并前，沙箱与进程内
 *    harness 的覆盖面上没有任何差别，但后者不需要占用端口、拷贝凭据、等 45 秒起进程。
 * 3. 实测现状（本文写下来时跑过）：`coldstart-e2e.mjs` 在本机 0.2.1-rc.2 依赖组合下
 *    直接崩在 `root.settings.register`（`SettingsProvider` 这个基类在 0.2.x 已不是
 *    `@deepseek-ai/dsh-settings` 的默认导出，那里现在导出的是 `SettingsForms`）。
 *    本脚本因此把「起得来」本身当成一项要报告的断言，而不是假定它成立。
 *
 * ## 三档语义（不许把没验到的写成通过）
 *
 *  - **PASS**：断言真跑到了且对得上。
 *  - **FAIL**：断言跑到了但对不上 → 退出码 1。
 *  - **NOT-COVERED**：前置条件不在（例如宿主那条分支未合并，留痕键压根不存在）→
 *    **必须写清缺的是哪个前置**，并附实测观察（不是空口一句「未覆盖」）；退出码仍 0。
 *
 * ## (a) 留痕项为什么拆成三条（task-14 的全部改动理由）
 *
 * 上一版把 stdout 捕获同时当两个问题的证据，于是 `apply()` 不在场时键集合必然为空，
 * 脚本就报成「宿主没实现」——那是**归因错误**，不是覆盖不足。现在三条断言各有各的
 * 证据源，结构上不可能再互相冒充：
 *
 *  - **(a1) 数值**：直接导入 `lib/generate.js` 的三个纯函数
 *    （`createStreamMetrics` / `observeChunk` / `formatStreamMetrics`，`src/generate.ts:422/:447/:484`），
 *    喂本脚本写死的假流形状，逐键断言数值。**零生产代码改动**，也不需要构建产物之外的东西。
 *  - **(a1b) 同源旁证**：`generateCompletion` 返回体里那份 `metrics` 必须与 (a1) 的计数一致
 *    ——证明真流循环确实调了 `observeChunk`，而不是格式化函数自己算对了。
 *  - **(a2) 接线层在场**：静态断言 `lib/index.js` 里那 4 个 `traceOps(...)` 调用点齐备，
 *    且同一条模板里带 `${stream}`、`formatStreamMetrics` 已接进接线层。
 *  - **(a3) 这一行在本次进程里真的被打出来**：需要一次真实回合 → 明确标 NOT-COVERED。
 *    **不把「格式化算对了」写成「留痕行出现了」**。
 *
 * 选路线 A（纯函数 + 静态在场）而不是路线 B（起真 Context 跑完整 apply），依据是 lead 与
 * host-latency 的判断：B 要同时满足 `inject: ['llm','sessions','settings']`、注入假 llm、
 * 伪造 `session.requestHeader()` 供 `routeOf`、再喂一个 `turn/end`，成本数倍，
 * 而它多证明的只有「apply 跑过」——与 (a2) 的静态在场断言重叠。真要做，做成**第二条独立脚本**。
 *
 * ## 在整条 `test:e2e` 里的位置
 *
 * 链是 fail-fast 的，而 `coldstart-e2e.mjs` 小节 2（重启恢复盘上残留建议）**故意留红**：
 * `parsePersistedPush` 在 `src/` 里零生产调用点（`e853d1e` 加、`c3b6a80` 删、没接回来），
 * 见 issue #50。放宽它的断言换绿 = 把产品缺陷盖住，所以本脚本被挪到链首（紧跟构建），
 * 这样 `pnpm test:e2e` 至少不会因为它排在红项之后就一行不跑。单独跑永远是：
 * `node scripts/ghost-frame-e2e.mjs`。
 *
 * ## 契约常量
 *
 * 留痕键名按 #41（lead 与 host-latency 定的那份）写成常量；若 host-latency 落地时改名，
 * 改这里一处即可，断言与输出会跟着动。
 *
 * 运行：`node scripts/ghost-frame-e2e.mjs [--repo <dir>]`
 * 默认用**当前仓**的 `lib/`；集成后 lead 可以用 `--repo /home/wujue/workspace/dsh-plugins/dsh-suggest-ghost`
 * 在主仓（合并后的那份构建）上重跑，得到最终验收。
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import { SessionStore } from '@deepseek-ai/dsh-session';

import { alignCompletion, decideInlineForm } from '../src/client/completion-align.ts';
// 留痕自 2026-10-26 起分级：默认只有 warn/error 到达用户侧（心跳类走 console.debug 静默）。
// 本脚本靠抓 `[ops-trace]` 文本断言行为，故在加载插件前把门槛放到 debug。
// 这是**测试自己开档**，不改生产默认。
process.env.DSH_SUGGEST_GHOST_TRACE ??= 'debug';

import {
  emptyFrameLedger,
  frameBucketKey,
  gateAccept,
  LEGACY_FRAME_HINT,
  observeFrame,
  readFrameHint,
  resolvePayloadFrames,
} from '../src/client/accept-guard.ts';

// ── 契约常量（#41）───────────────────────────────────────────────────────
/**
 * 宿主侧本轮（#51 已合并）落地的流式指标键，逐条对应 `src/generate.ts` 的
 * `formatStreamMetrics`（`:484`）渲染出的那一串 `k=v`。名单里有两个容易被写错的：
 *  - `attempts_outer`（**不是** `attempts`）：只记外层重试，路由内部自重放不可观测、不计入；
 *    键名在 `fa1eb4c` 才对齐，早于它的产物里仍是 `attempts=`，跑旧产物时会在这里报缺键。
 *  - `effort_rejected` **恒打印 0/1**（不是「有才打」）：它的用途是「这类失败有多少」的计数，
 *    缺省写法会让 grep 出来的样本自选择成失败样本。
 * 新增/改名时改这一处即可，别改下面的期望值。
 */
const EXPECTED_TRACE_KEYS = [
  'first_text_delta_ms',      // 首个 text-delta 相对起点的毫秒数
  'first_reasoning_delta_ms', // 首个 reasoning-delta 毫秒数（与上一条**分开**记，#35 要看档位差异）
  'content_deltas',           // text-delta 条数（本脚本写死为 TEXT_DELTAS，可精确断言）
  'content_chars',            // text-delta 累计字符数
  'reasoning_deltas',         // reasoning-delta 条数
  'reasoning_chars',          // reasoning-delta 累计字符数
  'finish_kind',              // 终止原因（本脚本固定 'stop'）
  'attempts_outer',           // 外层尝试次数（路由内部重放不计入）
  'effort_requested',         // 请求的档位（本期默认不传 → 'inherit'；终值由宿主决定，不断言具体值）
  'effort_rejected',          // 档位是否被适配器拒过（恒 0/1）
  'outcome',                  // 收口分类：ok / empty / filtered（empty 指向路由与档位，filtered 指向净化链）
];

/** 载荷里必须出现的终帧字段（#41）。 */
const PAYLOAD_FIELDS = {
  suggestion: ['frame', 'final'],
  completion: ['final'],
};

// ── 假 llm 的流形状：**形状由本脚本决定，所以指标数值是可精确断言的**──────────
const REASONING_DELTAS = 3;
const TEXT_DELTAS = 5;
const REASONING_TEXTS = ['想', '一下', '怎么构', '建'];           // 前 3 条进流，末条丢弃
const TEXT_CHUNKS = ['pnpm', ' run ', 'build', ' 并', ' 跑冒烟']; // 恰好 5 条
const FINISH_KIND = 'stop';

const expectedReasoningChars = REASONING_TEXTS.slice(0, REASONING_DELTAS).join('').length;
const expectedContentChars = TEXT_CHUNKS.join('').length;

/**
 * 假流形状 → 期望数值。因为形状由本脚本写死，这几个数字是**精确断言**而不是「大概对」。
 * `content_chars` / `reasoning_chars` 用 UTF-16 码元长度（与 `observeChunk` 同一量纲）。
 */
const EXPECTED_METRIC_VALUES = {
  content_deltas: TEXT_DELTAS,
  content_chars: expectedContentChars,
  reasoning_deltas: REASONING_DELTAS,
  reasoning_chars: expectedReasoningChars,
  finish_kind: FINISH_KIND,
};

/**
 * dsh-llm 的原始流协议（`@deepseek-ai/dsh-llm/lib/types/types.d.ts:417-447`）：
 * `text-delta` / `reasoning-delta` 的字段名是 **`text`**，不是 `delta`/`content`；
 * 终止是 `{ type: 'finish', reason }`。照 OpenAI 格式写会静默产不出文本，
 * 而现象与「模型真的没话说」完全同形——这是本脚本最容易写错的地方。
 */
function buildStreamChunks() {
  const chunks = [{ type: 'block-start', index: 0, blockType: 'reasoning' }];
  for (let i = 0; i < REASONING_DELTAS; i += 1) {
    chunks.push({ type: 'reasoning-delta', index: 0, text: REASONING_TEXTS[i] });
  }
  const reasoningAll = REASONING_TEXTS.slice(0, REASONING_DELTAS).join('');
  chunks.push({ type: 'block-end', index: 0, block: { type: 'reasoning', text: reasoningAll } });
  chunks.push({ type: 'block-start', index: 1, blockType: 'text' });
  for (let i = 0; i < TEXT_DELTAS; i += 1) {
    chunks.push({ type: 'text-delta', index: 1, text: TEXT_CHUNKS[i] });
  }
  chunks.push({ type: 'block-end', index: 1, block: { type: 'text', text: TEXT_CHUNKS.join('') } });
  chunks.push({ type: 'usage', usage: { input: 32, output: 12 } });
  // ⚠️ `finish.reason` 是 **对象** `{ kind: 'stop' }`（`types.d.ts` 的 FinishReasonMap），
  // 不是字符串。写成字符串时 JS 不会拦，但 `generate.ts:finishError(assembler.finish)`
  // 读到 `undefined.kind`，抛 `unsupported finish reason "undefined"` —— 现象与「模型没话说」
  // 同形，是这类假流最容易写错的第二处（第一处是 delta 字段名）。
  chunks.push({ type: 'finish', reason: { kind: FINISH_KIND } });
  return chunks;
}

/**
 * 假 llm 服务。只实现插件真正读的那一个成员（`ctx.llm.stream(options)` 的异步迭代），
 * 见 `src/generate.ts:543` 与 `:655`——所以它是**plain object**，不需要经 cordis 注册成服务。
 */
function makeFakeLlm(chunks) {
  const requests = [];
  return {
    requests,
    stream(options) {
      requests.push(options);
      return (async function* emit() {
        for (const chunk of chunks) {
          // 每条之间空一拍：让 first_*_delta_ms 是真的「相对起点的耗时」而不是 0。
          await new Promise((r) => setTimeout(r, 5));
          yield chunk;
        }
      })();
    },
  };
}

// ── 结果收集 ─────────────────────────────────────────────────────────────
const STATUS = { PASS: 'PASS', FAIL: 'FAIL', NC: 'NOT-COVERED' };
const results = [];
/** @param {keyof typeof STATUS} status @param {string} why NC 时必填：缺哪个前置 + 实测证据 */
function record(name, status, detail) {
  results.push({ name, status, detail });
  const mark = status === STATUS.PASS ? '✅' : status === STATUS.FAIL ? '❌' : '⚪';
  console.log(`${mark} [${status}] ${name}${detail ? `\n     ${detail.replace(/\n/g, '\n     ')}` : ''}`);
}

function fail(name, expected, actual) {
  record(name, STATUS.FAIL, `期望 ${expected}\n实际 ${actual}`);
}

// ── 留痕捕获：插件的 ops-trace 走 console（见 src/index.ts:263 那段取证注释）────
const capturedLines = [];
const realLog = console.log;
const realWarn = console.warn;
function captureOn() {
  console.log = (...args) => { capturedLines.push(args.map(String).join(' ')); };
  console.warn = (...args) => { capturedLines.push(args.map(String).join(' ')); };
}
function captureOff() {
  console.log = realLog;
  console.warn = realWarn;
}
/** 从一行留痕里抽键名（`k=v` 形态），只看 ops-trace 那条前缀，别把正文卷进来。 */
function traceKeysIn(lines) {
  const keys = new Set();
  for (const line of lines) {
    for (const match of line.matchAll(/([a-z_][a-z0-9_]*)=/g)) keys.add(match[1]);
  }
  return keys;
}

// ── 仓库与产物 ───────────────────────────────────────────────────────────
const { createRequire } = await import('node:module');
const require0 = createRequire(join(repoDir0(), 'package.json'));

function repoDir0() {
  const i = process.argv.indexOf('--repo');
  return i >= 0 && process.argv[i + 1] !== undefined
    ? resolve(process.argv[i + 1])
    : dirname(dirname(fileURLToPath(import.meta.url)));
}

const argv = process.argv.slice(2);
const repoFlagIndex = argv.indexOf('--repo');
const repo = resolve(repoFlagIndex >= 0 && argv[repoFlagIndex + 1] !== undefined
  ? argv[repoFlagIndex + 1]
  : dirname(dirname(fileURLToPath(import.meta.url))));
const libDir = join(repo, 'lib');

console.log(`ghost-frame-e2e：产物来源 ${repo}`);
console.log(`  node ${process.version}；宿主内核 ${readKernelVersion()}`);

function readKernelVersion() {
  try {
    const p = require0.resolve('@deepseek-ai/cordis');
    const pkg = JSON.parse(readFileSync(join(dirname(dirname(p)), 'package.json'), 'utf8'));
    return `cordis@${pkg.version}`;
  } catch { return 'cordis 解析失败'; }
}

if (!existsSync(join(libDir, 'generate.js'))) {
  record('产物就位（lib/generate.js）', STATUS.NC,
    `缺前置：${libDir}/generate.js 不存在。先在那棵树上跑 ./node_modules/.bin/tsc -p tsconfig.json && node build.mjs`
    + '（worktree 里别用 pnpm，node_modules 是软链）');
  console.log('\n结论：harness 起不来是因为没有构建产物，不是判据不过。退出码 0（未覆盖）。');
  process.exit(0);
}
record('产物就位（lib/generate.js）', STATUS.PASS, libDir);

// ── 1. harness 自检：真 Context + 真会话 + 假 llm，流真的被插件迭代了 ─────────
const { generateCompletion, generateSuggestion } = await import(join(libDir, 'generate.js'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const root = new Context();
if (root.logger === undefined) root.logger = { info() {}, warn() {}, debug() {} };
new SessionStore(root);
const sessions = root.sessions;
const fakeLlm = makeFakeLlm(buildStreamChunks());

/** 造一份有历史的消息转录（照 coldstart-e2e 的事件形状）。 */
function makeSession(id, exchanges) {
  const session = sessions.create(id, { meta: { cwd: process.cwd() } });
  let seq = 0;
  exchanges.forEach(([userText, assistantText], index) => {
    const turn = index + 1;
    session.append('turn/start', { turn });
    seq += 1;
    session.append('user/message', {
      content: [{ type: 'text', text: userText }],
      source: { kind: 'user' },
    }, { surfaceOp: 'append' });
    if (assistantText !== undefined) {
      seq += 1;
      // ⚠️ 形状两处坑（都在本机实测撞到）：
      //  1. 事件数据是 `{ turn, step, message, stream }`（`dsh-session` 的
      //     `SessionEventMap['assistant/message']`），把 content 平铺在顶层会让
      //     `deriveEventMessage` 读 `event.data.message.content` 直接抛
      //     `Cannot read properties of undefined (reading 'content')`；
      //  2. surface-eligible 事件必须带 `surfaceOp` 标记，缺了抛
      //     `session event "assistant/message" is surface-eligible and requires a surfaceOp marker`。
      session.append('assistant/message', {
        turn,
        step: 1,
        message: { role: 'assistant', content: [{ type: 'text', text: assistantText }] },
        stream: [],
      }, { surfaceOp: 'append' });
    }
    session.append('turn/end', { turn, reason: { kind: 'completed' } });
  });
  return session;
}

const session = makeSession('ghost-frame-e2e', [
  ['这个插件怎么构建', '在仓根跑 node build.mjs，产物落在 lib/。'],
  ['测试呢', 'bash -c "$(node -p \"require(\'./package.json\').scripts[\'test:smoke\']\")"。'],
]);

const config = {
  provider: 'fake-provider',
  model: 'fake-model',
  maxInputBytes: 4096,
  maxOutputTokens: 256,
  maxTranscriptChars: 4000,
  maxSuggestionChars: 120,
  timeoutMs: 5000,
  inlineMaxChars: 120,
  llmEnabled: true,
};

let completionOutcome = null;
let completionError = null;
captureOn();
try {
  completionOutcome = await generateCompletion(
    { llm: fakeLlm }, config, session, '这个插件怎么构建', new AbortController().signal,
  );
} catch (error) {
  completionError = error;
}
const suggestionOutcome = completionError === null
  ? await generateSuggestion(
    { llm: fakeLlm }, config, session, 2, new AbortController().signal, undefined, 'auto',
  ).catch((error) => { completionError = error; return null; })
  : null;
captureOff();

if (completionError !== null) {
  record('harness：假 llm 的流被插件迭代', STATUS.FAIL, `generate 抛错：${String(completionError).slice(0, 200)}`);
} else {
  record('harness：假 llm 的流被插件迭代', STATUS.PASS,
    `stream() 被调 ${fakeLlm.requests.length} 次（completion + suggestion），`
    + `provider=${fakeLlm.requests[0]?.provider} model=${fakeLlm.requests[0]?.model}`);
  // 续写文本必须由假流的内容净化而来：这证明「形状 → 数值」这条链是可断言的。
  const text = completionOutcome?.text ?? '';
  record('harness：假流的文本经真实净化链落到返回值', text.length > 0 ? STATUS.PASS : STATUS.FAIL,
    `completion.text 字符数=${text.length}（期望 >0，源文本「${TEXT_CHUNKS.join('')}」经 sanitize 后非空）`);
}

// ── 2. (a) 留痕：拆成两条**互不共用观测源**的断言 ────────────────────────────
//
// ## 为什么必须拆（这是本条脚本改版的全部理由）
//
// 上一版把 stdout 捕获同时当两个问题的证据：「接线层跑没跑」与「留痕键值对不对」。
// 两者共用一个观测源，于是只要 `apply()` 不在场（本脚本直接调 `generateSuggestion`
// / `generateCompletion`，而那行是 `src/index.ts` 的接线层打的），键集合就必然为空，
// 脚本便把它报成「宿主没实现」——**归因错误**，而且错误方向恰好是「把没验到的说成没做的」。
//
// 现在拆成三条，各自有独立证据源，结构上不可能再互相冒充：
//
// | 断言 | 证据源 | 失败意味着 |
// |---|---|---|
// | (a1) 留痕**数值** | `lib/generate.js` 的三个纯函数导出：`createStreamMetrics` / `observeChunk` / `formatStreamMetrics`（`src/generate.ts:422/:447/:484`） | 计数或渲染真错了 → FAIL |
// | (a2) 接线层**在场** | `lib/index.js` 的静态文本：4 个 `traceOps(...)` 调用点，同一条模板里引 `${stream}`（由 `formatStreamMetrics` 产出） | 打点被删/改名 → FAIL |
// | (a3) 这一行在本次进程里**真的被打出来** | 需要一次真实回合（`apply()` 在场 + 真 LLM 或注入的服务面） | 本脚本不覆盖 → NOT-COVERED，并写清缺什么 |
//
// (a3 不是「原因不明」的未覆盖：它缺的是**一次真实回合**，而补它的部分成本
// （注入 settings 服务 + 伪造 `session.requestHeader()` 供 `routeOf` + 喂 `turn/end`）
// 换来的只是「apply 跑过」这一件事，与 (a2) 的静态在场断言高度重叠。lead 的口径是
// 要做就做成**第二条独立脚本**，不塞进本脚本。

// ── (a1) 数值层：假流形状由本脚本写死，所以每个键都能精确断言 ────────────────
const metricsFns = await loadMetricsFns(libDir);
if (metricsFns === null) {
  record('(a1) 留痕数值（纯函数层）', STATUS.NC,
    `缺前置：${join(libDir, 'generate.js')} 里没有导出 createStreamMetrics / observeChunk / formatStreamMetrics`
    + '（实测导出面里找不到这三个名字）。这属于「宿主那条线还没落到产物」，不是判据不过。');
} else {
  const { createStreamMetrics, observeChunk, formatStreamMetrics } = metricsFns;
  // 假时钟：起点 1000ms，每块 +5ms，与 makeFakeLlm 的真实节奏同形状（数值断言不受机器抖动影响）。
  const startedAt = 1000;
  const metrics = createStreamMetrics('inherit');
  buildStreamChunks().forEach((chunk, i) => observeChunk(metrics, chunk, startedAt, startedAt + (i + 1) * 5));
  const line = formatStreamMetrics(metrics);
  const rendered = new Map([...line.matchAll(/([a-z_][a-z0-9_]*)=(\S*)/g)].map(([, k, v]) => [k, v]));
  const missingKeys = EXPECTED_TRACE_KEYS.filter((k) => !rendered.has(k));
  const valueChecks = Object.entries(EXPECTED_METRIC_VALUES)
    .filter(([k, expected]) => rendered.get(k) !== String(expected))
    .map(([k, expected]) => `${k}=${String(rendered.get(k))}（期望 ${expected}）`);
  // 两个首块延迟**分开**记：非推理模型时 first_reasoning 是 -1，不能拿 `first_text >= first_reasoning`
  // 当普遍判据（-1 >= 0 会假）。本脚本的假流有 reasoning，所以这里只断「都 >=0 且 reasoning 不晚于 text」。
  const firstText = Number(rendered.get('first_text_delta_ms'));
  const firstReasoning = Number(rendered.get('first_reasoning_delta_ms'));
  const timingOk = firstReasoning >= 0 && firstText >= 0 && firstText >= firstReasoning;
  const outcomeOk = ['ok', 'empty', 'filtered'].includes(rendered.get('outcome') ?? '');
  const effortOk = rendered.has('effort_requested') && ['0', '1'].includes(rendered.get('effort_rejected') ?? '');
  if (missingKeys.length === 0 && valueChecks.length === 0 && timingOk && outcomeOk && effortOk) {
    record('(a1) 留痕数值（纯函数层）', STATUS.PASS,
      `formatStreamMetrics 渲染出的整行 = ${line}\n`
      + `期望：${Object.entries(EXPECTED_METRIC_VALUES).map(([k, v]) => `${k}=${v}`).join(' ')}、`
      + `first_reasoning(${firstReasoning}) ≤ first_text(${firstText})、outcome∈{ok,empty,filtered}、`
      + `effort_rejected∈{0,1}、attempts_outer 在场（只记外层重试）\n`
      // `outcome` 由**调用方**在净化之后写（`generate.ts:819/834/963/966`），纯函数层只把它初始化成
      // 'empty'；所以这里的 'empty' 表示「这一层不拥有这个判定」，**不是**「模型一个字都没吐」。
      // 真实现场的 outcome 看 (a1b)——它读的是 generate* 返回体里那份 metrics。
      + '注：outcome 由调用方在净化之后写，纯函数层不参与（现场值见 (a1b)）');
  } else {
    fail('(a1) 留痕数值（纯函数层）',
      `整行含 ${EXPECTED_TRACE_KEYS.join(' / ')} 且 ${Object.entries(EXPECTED_METRIC_VALUES).map(([k, v]) => `${k}=${v}`).join(', ')}`,
      `实得整行 = ${line}`
      + (missingKeys.length > 0 ? `\n     缺键：${missingKeys.join(', ')}` : '')
      + (valueChecks.length > 0 ? `\n     数值不符：${valueChecks.join('; ')}` : '')
      + (timingOk ? '' : `\n     首块时序不成立：first_reasoning=${String(firstReasoning)} first_text=${String(firstText)}`)
      + (outcomeOk ? '' : `\n     outcome 不是 ok/empty/filtered：${String(rendered.get('outcome'))}`)
      + (effortOk ? '' : `\n     effort_requested/effort_rejected 形状不对：${String(rendered.get('effort_requested'))} / ${String(rendered.get('effort_rejected'))}`));
  }
  // 旁证：真函数返回的 metrics 与纯函数层同源（假流真跑过一遍，两边计数必须一致）。
  const live = completionOutcome?.metrics ?? null;
  if (live === null) {
    record('(a1b) generateCompletion 返回体带 metrics', STATUS.NC,
      '缺前置：本仓构建产物的 generateCompletion 返回体里没有 metrics 字段'
      + '（宿主那条线未落到这份产物）；数值层已单独由 (a1) 判定。');
  } else {
    const same = live.contentDeltas === EXPECTED_METRIC_VALUES.content_deltas
      && live.reasoningDeltas === EXPECTED_METRIC_VALUES.reasoning_deltas
      && live.contentChars === EXPECTED_METRIC_VALUES.content_chars
      && live.finishKind === EXPECTED_METRIC_VALUES.finish_kind;
    const liveView = {
      contentDeltas: live.contentDeltas, contentChars: live.contentChars,
      reasoningDeltas: live.reasoningDeltas, reasoningChars: live.reasoningChars,
      finishKind: live.finishKind, outcome: live.outcome, effortRequested: live.effortRequested,
    };
    const expectedView = {
      contentDeltas: EXPECTED_METRIC_VALUES.content_deltas, contentChars: EXPECTED_METRIC_VALUES.content_chars,
      reasoningDeltas: EXPECTED_METRIC_VALUES.reasoning_deltas, reasoningChars: EXPECTED_METRIC_VALUES.reasoning_chars,
      finishKind: EXPECTED_METRIC_VALUES.finish_kind,
    };
    record('(a1b) generateCompletion 返回体带 metrics 且与纯函数层同源',
      same ? STATUS.PASS : STATUS.FAIL,
      '现场=' + JSON.stringify(liveView) + (same ? '' : '；期望=' + JSON.stringify(expectedView)));
  }
}

/** 取 lib/generate.js 里的三个指标纯函数；缺任何一个返回 null（调用方按未覆盖处理）。 */
async function loadMetricsFns(dir) {
  const mod = await import(join(dir, 'generate.js'));
  const needed = ['createStreamMetrics', 'observeChunk', 'formatStreamMetrics'];
  if (needed.some((n) => typeof mod[n] !== 'function')) return null;
  return {
    createStreamMetrics: mod.createStreamMetrics,
    observeChunk: mod.observeChunk,
    formatStreamMetrics: mod.formatStreamMetrics,
  };
}

// ── (a2) 接线层在场性（静态，不靠 stdout）────────────────────────────────────
const indexPath = join(libDir, 'index.js');
const indexText = existsSync(indexPath) ? readFileSync(indexPath, 'utf8') : '';
const TRACE_SITES = [
  'completion generated',
  'completion dropped (empty or filtered)',
  'suggestion generated',
  'suggestion dropped (empty or filtered)',
];
const siteLines = TRACE_SITES
  .map((prefix) => indexText.split('\n').filter((l) => l.includes('traceOps(') && l.includes(prefix)))
  .map((hits) => hits[0] ?? null);
const absent = TRACE_SITES.filter((_, i) => siteLines[i] === null);
const withoutStream = siteLines.filter((l) => l !== null && !l.includes('${stream}')).length;
const formatterWired = /const stream = formatStreamMetrics\(/.test(indexText);
if (!existsSync(indexPath)) {
  record('(a2) 接线层 4 个打点在场（静态）', STATUS.NC, `缺前置：${indexPath} 不存在（没有构建产物）`);
} else if (absent.length === 0 && withoutStream === 0 && formatterWired) {
  record('(a2) 接线层 4 个打点在场（静态）', STATUS.PASS,
    '4 条 traceOps(...) 调用点齐备，且同一条模板里带 ${stream}，'
    + '且接线层里有 const stream = formatStreamMetrics(...)\n'
    + '注意：这只证明「生产路径上确实有人打这一行」，**不**等于「本次运行打出了它」（那要看 (a3)）');
} else {
  fail('(a2) 接线层 4 个打点在场（静态）',
    '4 个前缀各有一条 traceOps 调用且都带 ${stream}：' + TRACE_SITES.join(' / '),
    `缺前缀=[${absent.join(', ')}]；不带 stream 占位的调用点=${withoutStream}；`
    + `formatStreamMetrics 接进接线层=${formatterWired}`);
}

// ── (a3) 端到端「这一行真的被打出来」——本脚本不覆盖，说清为什么不覆盖 ─────────
record('(a3) 本次运行是否真的打出留痕行（本脚本口径外，已由 ghost-frame-real-e2e.mjs 覆盖）', STATUS.NC,
  '缺前置：需要一次真实回合（apply() 在场 + 真 LLM 流）。本脚本直接调 generate*，'
  + '接线层不在场，所以 stdout 里必然没有这行——实测本次捕获 ' + capturedLines.length + ' 行、'
  + `抽到的键集合=[${[...traceKeysIn(capturedLines)].sort().join(', ') || '空'}]。\n`
  + '为什么不用「起真 Context 跑完整 apply」补它：要同时满足 inject:[llm,sessions,settings]、'
  + '注入假 llm、伪造 session.requestHeader() 供 routeOf、再喂一个 turn/end，'
  + '成本数倍，而它多证明的只有「apply 跑过」——与上面的 (a2) 静态在场断言重叠。'
  + 'lead 口径：要做就做成第二条独立脚本。\n'
  + '现场怎么补：已由 **scripts/ghost-frame-real-e2e.mjs** 补上（真 Context + 内存 settings 面 + '
  + '假 llm 作为 llm 服务 + 真喂一个 turn/end，断言这两行真的出现且 11 个键的值符合契约）。'
  + '两条分工：这里证「值算得对、打点还在」，那里证「接线层真打了」。');

// ── 3. (b) 载荷里的 frame/final（#41）──────────────────────────────────────
//
// 理想的证据是**盘上那份 `_push` 字节**：它由宿主写进 settings 命名空间
// （`src/index.ts` 的 pushToClient），要在进程内复现就得先有真的 `settings` 服务——
// 而 0.2.x 把它从 dsh-settings 拆给了 api-settings-controller 那条链（下面的实测会说明）。
// 起不来时**不退化成猜测**：改用同一个宿主构建产物里 `generateSuggestion` 的返回对象
// 当证据源（它就是 `_push` 里那个 suggestion 的上游），并把来源如实标注出来。
let pushedPayload = null;
let payloadSource = '';
const settingsAttempt = await tryBootSettings(root, repo);
if (settingsAttempt.ok && settingsAttempt.push !== null && settingsAttempt.push !== undefined) {
  pushedPayload = settingsAttempt.push;
  payloadSource = '盘上 `_push` 字节（进程内宿主 fiber 写出）';
} else {
  payloadSource = '宿主 `generateSuggestion` 的返回对象（' + join(libDir, 'generate.js')
    + '，即 `_push` 里那个 suggestion 的上游）';
}

/**
 * 尝试起一份进程内 settings 通道并让宿主 fiber 推一次。
 * 起不来是**已知且要说清**的事，不当失败处理；原因必须带实测证据。
 */
async function tryBootSettings(ctx, repoDir) {
  try {
    const settingsModule = require0.resolve('@deepseek-ai/dsh-settings');
    const mod = require0(settingsModule);
    const Base = mod.SettingsProvider ?? mod.default;
    if (typeof Base !== 'function') {
      return {
        ok: false,
        reason: `${settingsModule} 里没有 SettingsProvider 导出（实测导出面=[${Object.keys(mod).join(', ')}]）`
          + '；0.2.x 把 settings 服务实现拆给了 api-settings-controller 那条链',
      };
    }
    let document = {};
    class MemorySettings extends Base {
      writable = true;
      load() { return structuredClone(document); }
      async persist(ns, section) { document = { ...document, [ns]: structuredClone(section) }; }
    }
    ctx.plugin(MemorySettings);
    await sleep(60);
    const settingsService = ctx.settings;
    if (settingsService?.register === undefined) {
      return {
        ok: false,
        reason: `装了 fiber 之后 ctx.settings 仍是 typeof=${typeof settingsService}`
          + '（同型失败：scripts/coldstart-e2e.mjs 在本机也崩在同一行 `root.settings.register`）',
      };
    }
    return { ok: true, push: await readPushAfterHostRun(ctx, settingsService) };
  } catch (error) {
    return { ok: false, reason: `起 settings 抛错：${String(error).slice(0, 160)}` };
  }
}

/** 让宿主 fiber 真跑一次并把 `_push` 取回来（只有 settings 起得来时才走到这里）。 */
async function readPushAfterHostRun(ctx, settingsService) {
  const { apply: applyHost } = require0(join(repo, 'lib', 'index.js'));
  let scope = null;
  const originalRegister = settingsService.register.bind(settingsService);
  settingsService.register = (ns, schema, options) => {
    const created = originalRegister(ns, schema, options);
    if (ns === 'suggest-ghost') scope = created;
    return created;
  };
  applyHost(ctx, { ...config, inlineEnabled: true });
  // 等注入 + 启动对账推送（fiber 生命周期是异步的，同步忙等会把事件循环饿死）
  const deadline = Date.now() + 3000;
  while (scope === null && Date.now() < deadline) await sleep(20);
  const raw = scope?.get?.()?._push;
  return typeof raw === 'string' && raw !== '' ? JSON.parse(raw) : null;
}

/** 当前产物**真正产出**的 suggestion 形状（不是脚本里写的契约样本）。 */
const generatedSuggestion = suggestionOutcome?.suggestion ?? null;
const observedPayload = pushedPayload !== null
  ? pushedPayload
  : (generatedSuggestion === null
    ? null
    // 带上会话归属：否则 (c) 的分桶键会算成 `no-session|…`，与现场不同形、容易误读。
    : { suggestion: generatedSuggestion, suggestionSessionId: 'ghost-frame-e2e' });

if (observedPayload !== null) {
  const s = observedPayload.suggestion ?? null;
  const keys = s === null ? [] : Object.keys(s).sort();
  const hasFields = s !== null && keys.includes('frame') && keys.includes('final');
  if (pushedPayload === null && !hasFields) {
    // 字段在宿主产物里压根不存在 → 未覆盖，并把「为什么」用实测数据说清。
    record('(b) 载荷含 frame/final（#41）', STATUS.NC,
      `缺前置：host-latency 那条分支（#41 的终帧字段）尚未合进 ${repo} 的构建产物。\n`
      + `证据源=${payloadSource}\n`
      + `settings 通道实测：${settingsAttempt.reason ?? '已起，但这一次没有推出载荷'}\n`
      + `宿主产出的 suggestion 键集合=[${keys.join(', ')}]；期望含 ${PAYLOAD_FIELDS.suggestion.join(' / ')}`
      + `（frame 是 number 且 >=1、final===true）。`);
  } else {
    const okSuggestion = hasFields && typeof s.frame === 'number' && s.frame >= 1 && s.final === true;
    const completion = observedPayload.completion;
    const okCompletion = completion === undefined || completion === null || completion.final !== undefined;
    record('(b) 载荷含 frame/final（#41）',
      okSuggestion && okCompletion ? STATUS.PASS : STATUS.FAIL,
      `来源=${payloadSource}；suggestion.frame=${String(s?.frame)} suggestion.final=${String(s?.final)}`
      + (completion === undefined ? '' : ` completion.final=${String(completion?.final)}`)
      + (okSuggestion && okCompletion ? ''
        : `\n     期望 frame>=1 且 final===true、completion 含 final`));
  }
} else {
  record('(b) 载荷含 frame/final（#41）', STATUS.NC,
    `缺前置：既没拿到盘上 _push，宿主这一次也没产出任何 suggestion（generate 返回空）。\n`
    + `settings 通道实测：${settingsAttempt.reason ?? '未知'}`);
}

// (c) 的输入：优先用上面拿到的**现场/产物**载荷；拿不到才用契约形态样本，并在输出里标注。
const contractSample = {
  suggestion: {
    version: 1, turn: 2, baseSeq: 3, text: '跑一下冒烟', truncated: false, acceptKey: 'Tab',
    frame: 1, final: true,
  },
  suggestionSessionId: 'ghost-frame-e2e',
  completion: { draft: '这个插件怎么构建', text: '在仓根跑 node build.mjs', final: true },
  completionSessionId: 'ghost-frame-e2e',
  history: null, hot: null,
};
const targetPayload = observedPayload ?? contractSample;
const targetPayloadIsSample = observedPayload === null;


// ── 4. (c) 客户端解析入口：吃这份载荷判成什么 ───────────────────────────────
//
// 这一层用**真实的客户端判据**（src/client/accept-guard.ts，#44 那条 PR 的实现），
// 输入是上面那份载荷（现场或契约形态）+ 两条兜底载荷。它是本轮真正能全绿的一层。
const clientChecks = [];
try {
  if (targetPayloadIsSample) {
    console.log('  输入 = #41 契约形态的**合成**载荷（当前宿主产物还没有帧字段，故用样本喂判据链）');
  } else {
    console.log(`  输入 = ${payloadSource}`);
  }
  const first = resolvePayloadFrames({
    ledger: emptyFrameLedger(),
    pushed: targetPayload,
    prevCompletionFrame: LEGACY_FRAME_HINT,
  });
  clientChecks.push([`宿主载荷被接受${targetPayloadIsSample ? '（样本）' : '（产物）'}`, first.accept === true,
    `accept=${String(first.accept)} outcome=${first.outcome} suggestionFrame=${JSON.stringify(first.suggestionFrame)}`]);
  const gate = gateAccept(first.suggestionFrame);
  clientChecks.push(['终帧可采纳（gateAccept 放行）', gate.allow === true,
    `allow=${String(gate.allow)} reason=${String(gate.allow === true ? '-' : gate.reason)}`]);

  // 旧载荷（无 frame/final）：必须放行，且不得污染台账（frame=0 不参与比较）。
  const legacyPayload = { ...targetPayload, suggestion: { version: 1, turn: 9, text: '旧载荷', acceptKey: 'Tab' } };
  const legacy = resolvePayloadFrames({ ledger: first.ledger, pushed: legacyPayload, prevCompletionFrame: LEGACY_FRAME_HINT });
  const legacyBucket = frameBucketKey(legacyPayload.suggestionSessionId, legacyPayload.suggestion.turn);
  clientChecks.push(['旧载荷（frame=0）放行', legacy.accept === true && legacy.outcome === 'legacy',
    `accept=${String(legacy.accept)} outcome=${legacy.outcome}`]);
  clientChecks.push(['旧载荷不登记台账', legacy.ledger.seen[legacyBucket] === undefined,
    `seen[${legacyBucket}]=${String(legacy.ledger.seen[legacyBucket])}`]);
  clientChecks.push(['旧载荷可采纳', gateAccept(readFrameHint(legacyPayload.suggestion)).allow === true,
    '缺 final 视为终帧']);

  // 新帧必须能盖过旧载荷；旧载荷不能反过来把新帧挡住（最容易写反的方向）。
  const upgraded = resolvePayloadFrames({
    ledger: legacy.ledger,
    pushed: { ...legacyPayload, suggestion: { ...legacyPayload.suggestion, frame: 1, final: true } },
    prevCompletionFrame: LEGACY_FRAME_HINT,
  });
  clientChecks.push(['旧载荷之后的 frame=1 仍放行', upgraded.accept === true && upgraded.outcome === 'first',
    `accept=${String(upgraded.accept)} outcome=${upgraded.outcome}`]);

  // 陈旧帧：先见 5，再收 3 → 整条丢弃，且不得把台账拉回。
  const staleLedger = observeFrame(upgraded.ledger, frameBucketKey('s', 1), 5).ledger;
  const stale = resolvePayloadFrames({
    ledger: staleLedger,
    pushed: { suggestion: { turn: 1, text: '迟到的旧帧', frame: 3, final: true }, suggestionSessionId: 's' },
    prevCompletionFrame: LEGACY_FRAME_HINT,
  });
  clientChecks.push(['陈旧帧整条丢弃', stale.accept === false && stale.outcome === 'older',
    `accept=${String(stale.accept)} outcome=${stale.outcome} seen=${String(stale.seen)}`]);

  // provisional：显示可以，采纳不行。
  const prov = gateAccept({ frame: 2, final: false });
  clientChecks.push(['provisional 帧拒绝采纳', prov.allow === false && prov.reason === 'provisional-frame',
    `allow=${String(prov.allow)} reason=${String(prov.allow === false ? prov.reason : '-')}`]);

  const bad = clientChecks.filter(([, ok]) => !ok);
  if (bad.length === 0) {
    record('(c) 客户端解析入口判定（#38/#44）', STATUS.PASS,
      clientChecks.map(([name, , obs]) => `· ${name}：${obs}`).join('\n'));
  } else {
    fail('(c) 客户端解析入口判定（#38/#44）', '全部 8 条客户端判据成立',
      bad.map(([name, , obs]) => `${name} 不成立 → ${obs}`).join('; '));
  }
} catch (error) {
  record('(c) 客户端解析入口判定（#38/#44）', STATUS.FAIL, `判据代码抛错：${String(error).slice(0, 200)}`);
}

// ── 5. (c-empty) 没有正文的终帧：真实使用里比「有正文」更常见 ────────────────
//
// 为什么要单独钉这一组：沙箱实测 `efficient` 路由两次都是
// `first_text_delta_ms=-1 content_deltas=0 reasoning_chars=8354 outcome=empty`（29771ms / 15557ms）
// ——模型只出推理、一个正文都没有。也就是说**「终帧不带正文」在真实环境里是常走的那一半**，
// 而本脚本的假流永远有正文 ⇒ 只覆盖了较少见的那一半。
//
// 判据归属先钉死：`outcome` 是**调用方在净化之后**写的（`src/generate.ts:819/834/963/966`），
// 所以纯函数层渲染出的 `outcome=empty` 只代表「这层不拥有这个判定」，**不代表**「模型一个字没吐」。
// 本组要断言的是**客户端拿到一份没有正文的终帧时的行为**，不是断言模型的行为。
{
  const emptyFinal = { frame: 1, final: true };

  // 5.1 续写形态：空正文载荷 = 不显示 inline，且**允许**回落历史（不扣形态）
  //     —— 这两条都是真判据：`alignCompletion`（`completion-align.ts`）与
  //     `decideInlineForm`（同文件末段，#38 第 4 条）都是纯函数。
  const emptyCompletion = { draft: '这个插件怎么构建', text: '' };
  const alignedEmpty = alignCompletion('这个插件怎么构建', emptyCompletion.draft, emptyCompletion.text);
  const verdictEmpty = decideInlineForm({
    inlineEnabled: true,
    draft: '这个插件怎么构建',
    payload: emptyCompletion,
    payloadBelongsToCurrentSession: true,
    alignedOk: alignedEmpty.ok,
    alignedReason: alignedEmpty.ok ? null : alignedEmpty.reason,
  });
  const noInlineShown = verdictEmpty.showInline === false;
  const historyAllowed = verdictEmpty.allowHistory === true;
  const notHeld = verdictEmpty.hold === null;
  record('(c-empty) 空正文**续写**终帧：不显示 inline、允许回落历史、不被形态判据扣住',
    alignedEmpty.ok === false && alignedEmpty.reason === 'empty-text' && noInlineShown && historyAllowed && notHeld
      ? STATUS.PASS : STATUS.FAIL,
    `alignCompletion → ${JSON.stringify(alignedEmpty)}；decideInlineForm → ${JSON.stringify(verdictEmpty)}\n`
    + '期望：ok=false / reason=empty-text、showInline=false、allowHistory=true、hold=null\n'
    + '（宿主推空续写**不是一次生成**，没有形态可保护，所以这里必须放行历史补全；'
    + '与「同一次生成内被裁空」的 consumed 形态是两条不同判据，见下面那条对照）');

  // 5.2 对照：同一次生成内「被裁空」（用户把整段续写打完了）必须**扣住**，不许掉成 history。
  //     这一条与 5.1 一起才构成「空正文 = 放行 / 裁空 = 扣住」的分界，单独任一条都能被写反。
  const consumedVerdict = decideInlineForm({
    inlineEnabled: true,
    draft: '这个插件怎么构建 node build.mjs',
    payload: { draft: '这个插件怎么构建', text: ' node build.mjs' },
    payloadBelongsToCurrentSession: true,
    alignedOk: false,
    alignedReason: 'empty-text',
  });
  record('(c-empty 对照) 同一次生成内被裁空：扣住，不回落 history',
    consumedVerdict.hold === 'inline-consumed' && consumedVerdict.allowHistory === false
      ? STATUS.PASS : STATUS.FAIL,
    `decideInlineForm → ${JSON.stringify(consumedVerdict)}；`
    + '期望 hold=inline-consumed、allowHistory=false');

  // 5.3 建议形态：帧判据**不看正文长度**——空正文的终帧照样过闸。
  //     这是一条**事实断言**（闸门的输入只有 final），不是「空正文该被采纳」的价值判断；
  //     也不等于「空正文一定会被渲染出来」——那是接线层与 DOM 的事，见下面 5.4。
  const gateEmpty = gateAccept(emptyFinal);
  const ledgerEmpty = resolvePayloadFrames({
    ledger: emptyFrameLedger(),
    pushed: { suggestion: { turn: 7, text: '', frame: 1, final: true }, suggestionSessionId: 'ghost-frame-e2e' },
    prevCompletionFrame: LEGACY_FRAME_HINT,
  });
  record('(c-empty) 空正文**建议**终帧：帧判据只看 final，不看正文长度（事实断言）',
    gateEmpty.allow === true && ledgerEmpty.accept === true && ledgerEmpty.suggestionFrame.frame === 1
      ? STATUS.PASS : STATUS.FAIL,
    `gateAccept({frame:1,final:true}) → allow=${String(gateEmpty.allow)}；`
    + `resolvePayloadFrames(正文 0 字符) → accept=${String(ledgerEmpty.accept)} `
    + `frame=${ledgerEmpty.suggestionFrame.frame} final=${String(ledgerEmpty.suggestionFrame.final)}\n`
    + '⚠️ 这条只说明「帧闸门不会因为正文为空而拒绝」，**不**主张空正文应当被采纳或被渲染；'
    + '空正文最终画成什么，见下面那条 NOT-COVERED。');

  // 5.4 真正「客户端拿到空正文后画成什么」不在本脚本的可观测范围内。
  record('(c-empty) 空正文建议的实际渲染结果（画一枚空幽灵？会不会把 placeholder 让位规则带起来？）',
    STATUS.NC,
    '缺前置：这一支的判定在 `src/client/index.ts` 的 `computeGhostContent` / `GhostOverlay.show()` 里，'
    + '需要 DOM 与接线层在场，本脚本只跑纯函数层，拿不到它的真实行为。\n'
    + '为什么值得单独看：overlay 的让位规则挂在 `data-shown="1"` 上（`body:has(...) [data-composer-placeholder]{display:none}`），'
    + '若一份空正文被当成幽灵显示，就会出现「幽灵什么都没画、原生占位文案却被藏掉」的空白输入框——'
    + '这正是本仓反复踩过的「开关与绘制不一致」那一类。\n'
    + '现场怎么验：主仓 `lib/client.js` 已在产物里，用浏览器打开宿主、把 `suggestGhost` 投影塞一份 '
    + '`text: ""` 的终帧，看 overlay 的 `display` / `data-shown` 与 placeholder 的 computed display。');
}

// ── 汇总 ────────────────────────────────────────────────────────────────
const counts = results.reduce((acc, r) => { acc[r.status] = (acc[r.status] ?? 0) + 1; return acc; }, {});
console.log('');
console.log(`汇总：PASS ${counts[STATUS.PASS] ?? 0} · FAIL ${counts[STATUS.FAIL] ?? 0} · NOT-COVERED ${counts[STATUS.NC] ?? 0}`);
for (const r of results) console.log(`  ${r.status.padEnd(11)} ${r.name}`);
if ((counts[STATUS.NC] ?? 0) > 0) {
  console.log('');
  console.log('未覆盖 ≠ 不通过：上面每一项 NOT-COVERED 都写了缺哪个前置与现场实测证据。');
  console.log('三种状态各自的含义：产物没构建 → NOT-COVERED；判据算错/打点丢失 → FAIL；');
  console.log('  需要一次真实回合才能观测的东西 → NOT-COVERED（本脚本按 lead 的口径不去补那一层）。');
  console.log('  需要 DOM/接线层才能观测的东西（如空正文建议的实际渲染）→ 同样标 NOT-COVERED。');
  console.log('单独跑：node scripts/ghost-frame-e2e.mjs（整条 test:e2e 现在是全绿的：coldstart-e2e 小节 2「重启对账」已由 #50 修好）');
}
process.exit((counts[STATUS.FAIL] ?? 0) > 0 ? 1 : 0);
