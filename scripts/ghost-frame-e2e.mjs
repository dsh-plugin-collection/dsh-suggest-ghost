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
 * 宿主侧本轮新增的流式指标键（#39）。host-latency 落地时**必须**同名，
 * 否则本脚本会把已经存在的能力报成 NOT-COVERED——那时改这里，别改断言的期望值。
 */
const EXPECTED_TRACE_KEYS = [
  'first_text_delta_ms',      // 首个 text-delta 相对请求起点的毫秒数
  'first_reasoning_delta_ms', // 首个 reasoning-delta 毫秒数（与上一条分开计，#35 要看档位差异）
  'content_deltas',           // text-delta 条数（本脚本写死为 TEXT_DELTAS，可精确断言）
  'content_chars',            // text-delta 累计字符数（同上）
  'reasoning_deltas',         // reasoning-delta 条数
  'reasoning_chars',          // reasoning-delta 累计字符数
  'finish_kind',              // 终止原因（本脚本固定 'stop'）
  'effort_requested',         // 生效档位（本期默认不传 → 期望 'default'/空标记，不断言具体值）
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

// ── 2. (a) 留痕键：宿主本轮新增的那几个键在不在、数值对不对 ──────────────────
const seenKeys = traceKeysIn(capturedLines);
const missing = EXPECTED_TRACE_KEYS.filter((k) => !seenKeys.has(k));
if (missing.length === 0) {
  // 全在 → 做**数值**断言：形状是我写的，所以对得上才算宿主真的在数。
  const line = capturedLines.filter((l) => EXPECTED_TRACE_KEYS.every((k) => l.includes(`${k}=`))).pop() ?? '';
  const numOf = (key) => Number(new RegExp(`${key}=(\\d+)`).exec(line)?.[1]);
  const checks = [
    ['content_deltas', numOf('content_deltas'), TEXT_DELTAS],
    ['content_chars', numOf('content_chars'), expectedContentChars],
    ['reasoning_deltas', numOf('reasoning_deltas'), REASONING_DELTAS],
    ['reasoning_chars', numOf('reasoning_chars'), expectedReasoningChars],
  ];
  const bad = checks.filter(([, actual, expected]) => actual !== expected);
  const kindMatch = new RegExp(`finish_kind=(${FINISH_KIND})\\b`).test(line);
  const firstText = numOf('first_text_delta_ms');
  const firstReasoning = numOf('first_reasoning_delta_ms');
  const orderOk = Number.isFinite(firstText) && Number.isFinite(firstReasoning)
    && firstReasoning >= 0 && firstText >= firstReasoning;
  if (bad.length === 0 && kindMatch && orderOk) {
    record(`(a) 留痕键与数值（#39）`, STATUS.PASS,
      `content_deltas=${TEXT_DELTAS} content_chars=${expectedContentChars}`
      + ` reasoning_deltas=${REASONING_DELTAS} reasoning_chars=${expectedReasoningChars}`
      + ` finish_kind=${FINISH_KIND} first_text_delta_ms=${firstText} first_reasoning_delta_ms=${firstReasoning}`);
  } else {
    fail('(a) 留痕键与数值（#39）',
      `content_deltas=${TEXT_DELTAS}, content_chars=${expectedContentChars}, reasoning_deltas=${REASONING_DELTAS},`
      + ` reasoning_chars=${expectedReasoningChars}, finish_kind=${FINISH_KIND}, first_reasoning ≤ first_text`,
      bad.map(([k, a, e]) => `${k}=${String(a)}（期望 ${e}）`).join(', ')
      + `; finish_kind 命中=${kindMatch}; first_text=${String(firstText)} first_reasoning=${String(firstReasoning)}`);
  }
} else {
  record('(a) 留痕键与数值（#39）', STATUS.NC,
    `缺前置：host-latency 那条分支（#41 的流式指标）尚未合进 ${repo} 的构建产物，`
    + `所以这些键在宿主代码里还不存在。\n`
    + `缺失键：${missing.join(', ')}\n`
    + `实测：本次假流确实跑完（stream 调用 ${fakeLlm.requests.length} 次、text=${(completionOutcome?.text ?? '').length} 字符），`
    + `插件期间捕获到 ${capturedLines.length} 行输出，抽到的键集合=[${[...seenKeys].sort().join(', ') || '空'}]。\n`
    + '合并后重跑本脚本即可从 NOT-COVERED 变 PASS/FAIL，无需改断言。');
}

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

// ── 汇总 ────────────────────────────────────────────────────────────────
const counts = results.reduce((acc, r) => { acc[r.status] = (acc[r.status] ?? 0) + 1; return acc; }, {});
console.log('');
console.log(`汇总：PASS ${counts[STATUS.PASS] ?? 0} · FAIL ${counts[STATUS.FAIL] ?? 0} · NOT-COVERED ${counts[STATUS.NC] ?? 0}`);
for (const r of results) console.log(`  ${r.status.padEnd(11)} ${r.name}`);
if ((counts[STATUS.NC] ?? 0) > 0) {
  console.log('');
  console.log('未覆盖项的含义：本轮实现尚未合并，判据在产物里不存在；不是判据不过。');
  console.log('合并三条分支后重跑本脚本（在主仓上 --repo 指过去即可），它们会变成 PASS 或 FAIL。');
}
process.exit((counts[STATUS.FAIL] ?? 0) > 0 ? 1 : 0);
