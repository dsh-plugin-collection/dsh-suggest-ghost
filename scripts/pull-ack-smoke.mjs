#!/usr/bin/env node
/**
 * pull 应答的可对账性回归（2026-10-23 线上现场，`~/.dsh/dsh-web.log` 665 行里约 600 行是本插件打的）。
 *
 * ## 现场形态
 *
 * `ops consumed: pull session=<S>` 229 行、18 个会话，几乎每个会话**连续 5 条**
 * （1 次首发 + 4 次重试 = 客户端 `PULL_MAX_ATTEMPTS=4` / `PULL_RETRY_BASE_MS=600` 的
 * 完整退避阶梯，见 `src/client/index.ts:347` 与 `:358`），有的会话累计 35 条（= 7 个阶梯）。
 * 一个阶梯里只有第一条 pull 前后有写落地，后面 4 条 pull **一个字节都没写**。
 *
 * ## 这条脚本钉的判据（两侧各一条，缺一条阶梯就不收敛）
 *
 *  - **客户端停止判据**（`src/client/index.ts:1936-1939`）：
 *    `if (settings.historySessionId === pending.sessionId) { pendingPull = null; return; }`
 *    而 `settings.historySessionId` **只在** `Array.isArray(hotSource.history)` 为真时才赋值
 *    （`src/client/index.ts:2100-2105`）。⇒ 应答里只要没有 `history` 数组，这条阶梯在协议上
 *    就**永不收敛**（场景 B）。
 *  - **宿主写盘判据**（`src/index.ts:1767-1768` 的按格判重）：
 *    `hotDirty = fpHot !== lastHotFingerprint`，而 `hotSigOf` 的 `historyKey` 把
 *    「`history` 缺席」与「`history` 为空数组」都折成同一个 `'∅'`（`src/index.ts:1373-1382`）
 *    ⇒ 同一会话重复 pull 零写（场景 C），**换会话也零写**（场景 D：未知会话；场景 E：空环会话）。
 *
 * ## 六个场景
 *
 *  A 会话可解析且有用户消息 ⇒ 应答带 `history` 数组 + `historySessionId` ⇒ 客户端判据成立。
 *  B `ctx.sessions.get` 解析不到（但 `_ops` 里照样来了 pull）⇒ 应答**整个省略** `history`
 *    ⇒ 按客户端判据这条阶梯永不收敛。
 *  C 同一未知会话连 pull 5 次 ⇒ 第 2..5 次因指纹相同**完全不写**（现场「4 条 pull 零写」的机制）。
 *  D 两个不同的未知会话交替 pull ⇒ 两者 `historyKey` 都是 `'∅'`、指纹**跨会话相同**
 *    ⇒ 换会话也不触发写（「换会话后客户端永远收不到应答」的独立成因）。
 *  E 两个**可解析但环为空**的会话（问题 2）⇒ 应答**带着** `history: []` 与本会话 id
 *    （即：这份载荷本身足以让客户端收敛），但指纹仍是 `'∅'` ⇒ 从第二个会话起**根本不写**
 *    ——所以 E 的成因只在判重这一层，与 B 的「载荷缺字段」是两条独立的路。
 *  F #89 的 `hotUsable` 闸门：热表恢复在飞行中（现场 `hotness domain busy, retrying` 最多
 *    40×150ms ≈ 6s，比客户端一整条阶梯 0/0.6/1.8/4.2/9.0s 的前四次尝试都长）⇒ **整格
 *    `_hot` 被扣住**，会话可解析、环非空也拿不到应答。这是第三条独立成因。
 *
 * ## 变异自证（本仓惯例：把被判据保护的代码改坏，断言必须变红）
 *
 * 不改动本仓 `src/`、`lib/`：把整份 `lib/` 复制到临时目录、在**副本**里做单点变异，再用
 * `GHOST_PULL_ACK_REPO=<副本目录> node scripts/pull-ack-smoke.mjs` 跑同一份脚本
 * （GHOST_*_REPO 是 payload-split / hot-throttle 已有的换产物口子）。
 * 下面是 2026-10-23 对 `lib/index.js`@6402dbd 实跑的**结果**，不是预期
 * （6402dbd 与 0a227e6 的 `lib/` 逐字节相同，那一版只动了 CHANGELOG）：
 *  - M1 `statePushOf` 恒 `history: null`                     ⇒ 红 A2 / A3 / A4 / E1 / F3
 *  - M2 `ringFor` 解析不到时返回 `[]`（即候选修法 (b)）      ⇒ 红 B2 / B3       ——**D3 不红**
 *  - M3 去掉按格判重（`pushDirty`/`hotDirty` 恒真）          ⇒ 红 C2 / D3 / E2
 *  - M4 `hotSigOf` 的 historyKey 带上归属会话               ⇒ 只红 E2          ——**D3 不红**
 *  - M5 = M2 + M4（载荷带身份 **且** 指纹带身份）            ⇒ 红 B2 / B3 / D3 / E2
 *  - M6 `hotUsable` 恒真（#89 的恢复窗口闸门失效）           ⇒ 红 F1
 * M2 单独修不了 D、M4 单独也修不了 D：D 需要「载荷里先有会话身份」，
 * 而今天那个身份只跟 `history` 一起出场（`buildHotPayload` 的一个条件展开）。
 * 这条实测结果就是第 6 节推荐 (a) 的直接依据（结论与代价见 docs/pull-ack-investigation.md）。 *
 * 用法：`node scripts/pull-ack-smoke.mjs`（跑编译产物 `lib/index.js`，需先 `pnpm build`）
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context, Service } from '@deepseek-ai/cordis';
import { SessionStore } from '@deepseek-ai/dsh-session';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = process.env.GHOST_PULL_ACK_REPO ?? join(HERE, '..');
const libDir = join(REPO, 'lib');
if (!existsSync(join(libDir, 'index.js'))) {
  console.error(`❌ 找不到构建产物：${libDir}/index.js（先 pnpm build）`);
  process.exit(1);
}
const { apply: applyHost } = await import(join(libDir, 'index.js'));

const NS = 'suggest-ghost';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── 断言器（照 hot-starvation / payload-split 的形状：run + 计数 + 退出码）────────
let cases = 0;
const failures = [];
const realLog = console.log.bind(console);
function run(name, fn) {
  cases += 1;
  try {
    fn();
    realLog(`  ✓ ${name}`);
  } catch (error) {
    failures.push(name);
    realLog(`  ✗ ${name}\n      ${String(error.message).split('\n').slice(0, 4).join('\n      ')}`);
  }
}

// ── 留痕捕获（tight-loop 保险丝同 hot-starvation）─────────────────────────────
const traced = [];
console.log = (...args) => {
  const line = args.map(String).join(' ');
  if (line.includes('[ops-trace]')) traced.push(line);
  else realLog(...args);
  if (traced.length > 4000) {
    realLog('[pull-ack-smoke] 留痕越过 4000 行：紧循环回归，终止。');
    process.exit(99);
  }
};

// ── 两份镜像：客户端判据 + hotSigOf ────────────────────────────────────────────
// 它们**只用来把机制说成可核对的数**，不替代行为断言（行为断言是「写了几笔 / 落了几格」）。
// 镜像与源码漂移由最后一条静态守卫断言（G1/G2）钉住。

/** src/client/index.ts:2100-2105 + :1936-1939 的镜像：这一格落地后客户端会不会判「已对账」。 */
function clientReconciles(hotPayload, pushedPayload, sessionId, prevHistorySessionId) {
  const hotSource = hotPayload ?? pushedPayload ?? {};
  const hasHistory = Array.isArray(hotSource.history);
  const nextHistorySessionId = hasHistory
    ? (typeof hotSource.historySessionId === 'string' ? hotSource.historySessionId : null)
    : prevHistorySessionId;
  return nextHistorySessionId === sessionId;
}

/** src/index.ts:1373-1382（hotSigOf）的镜像。 */
function hotSigMirror(o) {
  const hotKey = o.hot === null || o.hot.length === 0
    ? '∅'
    : o.hot.map((h) => `${h.text}×${h.count}${h.pinned === true ? '!p' : ''}`).join('|');
  const historyKey = o.history === undefined || o.history === null || o.history.length === 0
    || o.historySessionId === null || o.historySessionId === undefined
    ? '∅'
    : `${o.historySessionId}#${o.history.length}:${o.history[o.history.length - 1] ?? ''}`;
  return { sig: `<HOT>${hotKey}<T>${o.total}<HIST>${historyKey}`, historyKey };
}

// ── 假进程：假 ctx + 假 settings 服务（形状依据 payload-split-smoke / hot-starvation）─
// **每个场景一个进程**：判重指纹（lastHotFingerprint）与 rev 都是 apply() 闭包态，
// 共用一个进程会让后一个场景继承前一个场景的指纹，测出来的「零写」就不是被测机制了。
let bootIndex = 0;

async function boot(label, opts = {}) {
  const id = `${label}#${++bootIndex}`;
  let document = { [NS]: { _ops: 'null', _push: 'null', _hot: 'null', _residual: 'null' } };
  let revision = 0;
  /** 事务外的成功写（本夹具不造 HMR 事务：所有写都写得进盘 = 对收敛**最有利**的介质，
   *  在这种介质下阶梯仍不收敛，才能把责任判给契约而不是泵）。 */
  const writes = [];

  class MemorySettings extends Service {
    constructor(ctx) {
      super(ctx, 'settings');
    }
    describe() {
      return [{ ns: NS, revision, value: structuredClone(document[NS] ?? {}) }];
    }
    update(ns, patch) {
      document = { ...document, [ns]: { ...document[ns], ...structuredClone(patch) } };
      revision += 1;
      writes.push({ at: Date.now(), cells: Object.keys(patch).sort().join(','), patch: structuredClone(patch) });
      this.ctx.emit('settings/document-updated', ns, revision);
      return Promise.resolve();
    }
  }

  const root = new Context();
  if (root.logger === undefined) root.logger = { info() {}, warn() {}, debug() {} };
  new SessionStore(root);
  const settings = new MemorySettings(root);
  // 回合在 apply **之前**补完：apply 之后补的事件会走 handleTurnEnd → pushToClient，
  // 于是「第一次 pull」读到的是已被写过的那一格（实测踩过：应答写变成 0 笔，A0 假红）。
  for (const spec of opts.sessions ?? []) {
    const live = root.sessions.create(spec.id, { meta: { cwd: process.cwd() } });
    (spec.texts ?? []).forEach((text, i) => {
      live.append('turn/start', { turn: i + 1 });
      live.append('user/message', { content: [{ type: 'text', text }], source: { kind: 'user' } }, { surfaceOp: 'append' });
      live.append('turn/end', { turn: i + 1, reason: { kind: 'completed' } });
    });
  }
  if (opts.storageDir !== undefined) {
    // #89 的 `hotUsable` 闸门：热表恢复在飞行中时**整格 `_hot` 不许说话**，而 pull 应答的
    // history 就住在那一格 ⇒ 恢复窗口里的应答在协议上不可能被客户端确认。场景 F 量这个。
    // 夹具依据 scripts/hotness-reload-restore-smoke.mjs：手搓 Service stub 注册得上但
    // `ctx.inject(['storageDomain'])` 不触发，所以要动的是**那一个方法**（open），不是整个宿主。
    const storageModule = await import('@deepseek-ai/dsh-storage');
    const storageJson = await import('@deepseek-ai/dsh-storage-json');
    const storageDomain = await import('@deepseek-ai/dsh-storage-domain');
    const { Storage } = storageModule;
    new Storage(root);
    storageJson.apply(root, { root: opts.storageDir });
    await storageDomain.apply(root, { backend: 'json' });
    const facility = root.storageDomain ?? root.get?.('storageDomain');
    if (facility === undefined) throw new Error('场景 F 夹具失败：拿不到 storageDomain facility');
    const real = facility.open.bind(facility);
    let calls = 0;
    facility.open = (spec) => {
      calls += 1;
      if (calls <= opts.rejectOpenTimes) return Promise.reject(new Error(`domain '${spec.name}' is already open`));
      return real(spec);
    };
    opts.callsOf = () => calls;
  }
  applyHost(root, {
    maxInputBytes: 4096,
    maxOutputTokens: 512,
    timeoutMs: 1000,
    maxTranscriptChars: 12000,
    maxSuggestionChars: 240,
    // 关掉 LLM：本脚本只验应答契约，不验生成；顺带让 handleTurnEnd 走「跳过生成但仍推送」的分支。
    llmEnabled: false,
  });

  let opsRev = 0;
  const cell = (name) => {
    const raw = document[NS][name];
    if (typeof raw !== 'string' || raw === '' || raw === 'null') return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  };
  /** 一笔「应答写」= patch 里带 `_hot` 或 `_push`（`_ops` 的清空与注入都不算）。 */
  const isAckWrite = (w) => Object.prototype.hasOwnProperty.call(w.patch, '_hot')
    || Object.prototype.hasOwnProperty.call(w.patch, '_push');

  return {
    id,
    root,
    settings,
    writes,
    document: () => document[NS],
    cell,
    /** 客户端写一条 pull ⇒ 宿主消费并应答。返回**这一次 pull 自己**触发的写与留痕。 */
    pull: async (sessionId) => {
      const w0 = writes.length;
      const t0 = traced.length;
      await settings.update(NS, { _ops: JSON.stringify({ rev: ++opsRev, ops: [{ op: 'pull', sessionId }] }) });
      await sleep(30); // 让 _ops 清空与 promise 尾巴跑完；泵是 500ms，不会被这一步唤醒（本夹具写不失败，泵常年空转）
      // slice[0] 是**注入**（测试替客户端写 `_ops` 那一笔，同 hot-starvation 的 `injected` 口径），
      // 不是宿主的产出；宿主的 `_ops` 清空永远是它后面那一笔。
      const slice = writes.slice(w0);
      const [injected, ...produced] = slice;
      return {
        injected,
        ackWrites: produced.filter(isAckWrite),
        clearWrites: produced.filter((w) => !isAckWrite(w) && Object.prototype.hasOwnProperty.call(w.patch, '_ops')),
        produced,
        trace: traced.slice(t0),
        hot: cell('_hot'),
        pushed: cell('_push'),
      };
    },
  };
}

const num = (proc, key) => proc.writes.filter((w) => w.cells.includes(key)).length;

// ══ 场景 A：会话可解析且有用户消息 ⇒ 应答必须带 history 数组 + historySessionId ══
const A = 'session-ack-known';
const procA = await boot('A', { sessions: [{ id: A, texts: ['帮我把这个 pr 的测试跑一遍', '再看一下端口配置'] }] });
const a1 = await procA.pull(A);
realLog(`\n[A 会话可解析] pull 应答写=${a1.ackWrites.length} 笔；`
  + `history=${Array.isArray(a1.hot?.history) ? `array(${a1.hot.history.length})` : String(a1.hot?.history)}；`
  + `historySessionId=${String(a1.hot?.historySessionId)}；热格字节=${num(procA, '_hot')}`);

run('A0 正对照：会话可解析时，第一次 pull 就写出一格应答', () => {
  assert.equal(a1.ackWrites.length, 1, `第一次 pull 写了 ${a1.ackWrites.length} 笔（期望 1）`);
});

run('A1 前提成立：该会话能被 ctx.sessions.get 解析（场景 B 的反面）', () => {
  assert.notEqual(procA.root.sessions.get(A), undefined, '夹具里的会话没有进店：这条前提不成立就是脚本自己的错');
});

run('A2 应答落地的 `_hot` 载荷里 history 是数组、内容就是该会话的用户消息', () => {
  assert.ok(a1.hot !== null, '盘上没有 _hot 格');
  assert.ok(Array.isArray(a1.hot.history), `_hot.history 不是数组：${JSON.stringify(a1.hot.history)}`);
  assert.ok(a1.hot.history.includes('帮我把这个 pr 的测试跑一遍'), `历史环缺第一条：${JSON.stringify(a1.hot.history)}`);
  assert.ok(a1.hot.history.includes('再看一下端口配置'), `历史环缺第二条：${JSON.stringify(a1.hot.history)}`);
  // 变异 M1（statePushOf 恒 history:null）→ 这里红。
});

run('A3 historySessionId 等于被 pull 的那个会话（客户端唯一认得的「对账」凭证）', () => {
  assert.equal(a1.hot.historySessionId, A, `historySessionId=${String(a1.hot.historySessionId)} ≠ ${A}`);
});

run('A4 按客户端判据：这一格落地后阶梯停止（reconciles=true）', () => {
  assert.ok(clientReconciles(a1.hot, a1.pushed, A, null), '客户端 Array.isArray(history) 判据不成立 ⇒ 阶梯不会停');
  // 变异 M1 → A2/A3/A4 三条一起红。
});

// ══ 场景 B：会话解析不到 ⇒ 应答省略 history ⇒ 阶梯在协议上永不收敛 ═════════════
const UNKNOWN = 'session-ack-unknown'; // 从未 create 过：ctx.sessions.get 必然 undefined
const procB = await boot('B');
const bLive = procB.root.sessions.get(UNKNOWN);
const b1 = await procB.pull(UNKNOWN);
realLog(`\n[B 会话解析不到] ctx.sessions.get=${String(bLive)}；应答写=${b1.ackWrites.length} 笔；`
  + `载荷键=${b1.hot ? Object.keys(b1.hot).join(',') : '(无)'}；history 在场=${b1.hot ? 'history' in b1.hot : 'n/a'}`);

run('B1 前提成立：ctx.sessions.get 解析不到该会话（这就是 ringFor 返回 undefined 的那一支）', () => {
  assert.equal(bLive, undefined, '夹具意外让该会话进了店：场景 B 没有造出来');
});

run('B2 应答里 history 与 historySessionId 都被整个省略（buildHotPayload 的条件展开）', () => {
  assert.ok(b1.hot !== null, `第一次 pull 竟然后一个字节都没写：${b1.trace.join(' | ').slice(0, 200)}`);
  assert.ok(!('history' in b1.hot), `_hot 里出现了 history 键：${JSON.stringify(b1.hot.history)}`);
  assert.ok(!('historySessionId' in b1.hot), `_hot 里出现了 historySessionId：${String(b1.hot.historySessionId)}`);
  // 变异 M2（ringFor 解析不到时返回 []）→ history 会变成 [] 并被写出去 → B2 红。
});

run('B3 按客户端判据：这份应答**不可能**让阶梯停止（无论落地几次）', () => {
  assert.ok(!clientReconciles(b1.hot, b1.pushed, UNKNOWN, null),
    '客户端在这条应答上判成了「已对账」：那 B 就不是不收敛的成因了');
  // 同一条载荷再落地 5 次也还是 false——这就是「阶梯跑满 5 条」的协议解释（配合 C 的零写）。
});

// ══ 场景 C：同一未知会话连 pull 5 次 ⇒ 只有第 1 次写，2..5 次零写 ══════════════
const procC = await boot('C');
const ladderC = [];
for (let i = 0; i < 5; i += 1) ladderC.push(await procC.pull(UNKNOWN));
const writesC = ladderC.map((r) => r.ackWrites.length);
realLog(`\n[C 同会话 5 连 pull] 每次 pull 的应答写笔数=${writesC.join(',')}；`
  + `_hot 总写=${num(procC, '_hot')} 笔，_push 总写=${num(procC, '_push')} 笔；`
  + `_ops 清空=${ladderC.reduce((n, r) => n + r.clearWrites.length, 0)} 笔（证明 5 批 op 都被消费了）`);

run('C1 5 次 pull 全部被消费（`_ops` 被注入 5 次也清了 5 次；留痕按 2026-10-23 的闸门只打 #1/#5）', () => {
  // 消费证据不能用 `ops consumed: pull` 行数：同会话连续重复被 PULL_REPEAT_TRACE_EVERY=5 并掉了
  // （#1 与 #5 各一行），那正是「同一句话的复读」的宿主侧证据。判据改用每批都跑完的 `_ops` 清空。
  const injected = ladderC.filter((r) => r.injected !== undefined).length;
  assert.equal(injected, 5, `注入的 _ops 批只有 ${injected} 笔`);
  const cleared = ladderC.reduce((n, r) => n + r.clearWrites.length, 0);
  assert.equal(cleared, 5, `_ops 只清了 ${cleared} 次：有批次没走完消费，零写就不是判重造成的`);
  const consumedLines = ladderC.filter((r) => r.trace.some((line) => line.includes('ops consumed: pull'))).length;
  assert.ok(consumedLines >= 2 && consumedLines <= 3, `pull 消费留痕 ${consumedLines} 行，与「#1/#5 各一行」的闸门形态不符`);
});

run('C2 只有第 1 次 pull 写了应答，第 2..5 次一个字节都没写（现场「4 条 pull 零写」）', () => {
  assert.equal(writesC[0], 1, `第 1 次 pull 的应答写=${writesC[0]} 笔（期望 1）`);
  for (let i = 1; i < 5; i += 1) {
    assert.equal(writesC[i], 0, `第 ${i + 1} 次 pull 写了 ${writesC[i]} 笔（期望 0）`);
  }
  assert.equal(num(procC, '_hot'), 1, `_hot 总写 ${num(procC, '_hot')} 笔（期望 1）`);
  // 变异 M3（指纹带上 rev）→ 每次 pull 都写 → C2 红。
});

run('C3 零写的原因是指纹相同，不是「没东西可写」：镜像 hotSigOf 五次同一个串', () => {
  const { sig } = hotSigMirror({ ...procC.cell('_hot'), historySessionId: procC.cell('_hot').historySessionId });
  for (const r of ladderC) {
    assert.equal(hotSigMirror(r.hot ?? {}).sig, sig, '五次 pull 的指纹不是同一个串：判重的解释站不住');
  }
});

// ══ 场景 D：两个不同的未知会话交替 pull ⇒ 指纹跨会话相同 ⇒ 换会话也不写 ════════
// 先拿两个「新进程」各自证明**第一次 pull 会写**（正对照：未知会话并非写不出来）。
const U1 = 'session-ack-unknown-1';
const U2 = 'session-ack-unknown-2';
const procD1 = await boot('D-正对照1');
const procD2 = await boot('D-正对照2');
const dFirst1 = await procD1.pull(U1);
const dFirst2 = await procD2.pull(U2);
// 再在同一个进程里交替：U1 先写，U2 必须零写。
const procD = await boot('D');
const dU1 = await procD.pull(U1);
const dU2 = await procD.pull(U2);
const dU1again = await procD.pull(U1);
const sig1 = hotSigMirror(dFirst1.hot);
const sig2 = hotSigMirror(dFirst2.hot);
realLog(`\n[D 两个未知会话交替] 新进程里 U1 首次 pull 写=${dFirst1.ackWrites.length}，U2 首次 pull 写=${dFirst2.ackWrites.length}；`
  + `同进程内 U1 写=${dU1.ackWrites.length} → U2 写=${dU2.ackWrites.length} → U1 再写=${dU1again.ackWrites.length}`);
realLog(`  U1 指纹=${sig1.sig.slice(0, 60)}… historyKey=${sig1.historyKey}`);
realLog(`  U2 指纹=${sig2.sig.slice(0, 60)}… historyKey=${sig2.historyKey}`);

run('D1 正对照：两个未知会话各自在全新进程里首次 pull **都会**写一格（未知≠写不出来）', () => {
  assert.equal(dFirst1.ackWrites.length, 1, `U1 首次 pull 写了 ${dFirst1.ackWrites.length} 笔`);
  assert.equal(dFirst2.ackWrites.length, 1, `U2 首次 pull 写了 ${dFirst2.ackWrites.length} 笔`);
});

run('D2 historyKey 在 history 缺席时恒为 ∅ ⇒ 两份应答的指纹跨会话逐字相同', () => {
  assert.equal(sig1.historyKey, '∅', `U1 的 historyKey=${sig1.historyKey}`);
  assert.equal(sig2.historyKey, '∅', `U2 的 historyKey=${sig2.historyKey}`);
  assert.equal(sig1.sig, sig2.sig, `两个不同会话的指纹不同：${sig1.sig} vs ${sig2.sig}`);
});

run('D3 同进程内换会话不触发写（U1 落地后 pull U2 = 0 笔；再切回 U1 还是 0 笔）', () => {
  assert.equal(dU1.ackWrites.length, 1, `U1 首次写=${dU1.ackWrites.length}（期望 1）`);
  assert.equal(dU2.ackWrites.length, 0, `换成 U2 竟写了 ${dU2.ackWrites.length} 笔：跨会话判重没有咬住`);
  assert.equal(dU1again.ackWrites.length, 0, `切回 U1 又写了 ${dU1again.ackWrites.length} 笔`);
  // 变异 M4（historyKey 带上 historySessionId）→ 两个会话的 key 不同 → D3 红；
  // 但 M4 之后 U2 的应答**仍然**省略 history（B 不变）⇒ D 与 B 是两条独立的成因。
});

// ══ 场景 E（问题 2）：会话可解析但环为空 ⇒ 载荷能收敛客户端，却因指纹 ∅ 不写 ══════
const E1_ID = 'session-ack-empty-1';
const E2_ID = 'session-ack-empty-2';
// 活会话、**零条**用户消息 ⇒ ringFor 物化出空环（`[]`，不是 undefined）
const procE = await boot('E', { sessions: [{ id: E1_ID, texts: [] }, { id: E2_ID, texts: [] }] });
const eRing1 = procE.root.sessions.get(E1_ID);
const e1 = await procE.pull(E1_ID);
const e2 = await procE.pull(E2_ID);
const eHistKey1 = hotSigMirror(e1.hot).historyKey;
const eHistKey2 = hotSigMirror({ hot: e1.hot.hot, total: e1.hot.total, history: [], historySessionId: E2_ID }).historyKey;
realLog(`\n[E 空环会话 A→B] 会话可解析=${eRing1 !== undefined}；LA 首次 pull 写=${e1.ackWrites.length}，`
  + `LB 首次 pull 写=${e2.ackWrites.length}；LA 载荷 history=${JSON.stringify(e1.hot.history)} `
  + `historySessionId=${String(e1.hot.historySessionId)}；historyKey(LA)=${eHistKey1} historyKey(LB 同形)=${eHistKey2}`);

run('E1 空环会话的应答**带**了 history:[] 与本会话 id ⇒ 这份载荷本身足以让客户端收敛', () => {
  assert.ok(Array.isArray(e1.hot.history) && e1.hot.history.length === 0, `LA 的 history 不是空数组：${JSON.stringify(e1.hot.history)}`);
  assert.equal(e1.hot.historySessionId, E1_ID, `historySessionId=${String(e1.hot.historySessionId)}`);
  assert.ok(clientReconciles(e1.hot, e1.pushed, E1_ID, null), '空环会话的应答在客户端判据下不该成立——那 B/E 的区分就没了');
  // 变异 M1 → E1 红（与 A2/A4 同一变异，两条都该红）。
});

run('E2 空环也算进 ∅：A→B 切换时指纹相同 ⇒ 第二个会话一个字节都收不到（问题 2 的答案：会）', () => {
  assert.equal(eHistKey1, '∅', `空环的 historyKey 不是 ∅：${eHistKey1}`);
  assert.equal(eHistKey2, '∅', `另一个空环会话的 historyKey 不是 ∅：${eHistKey2}`);
  assert.equal(e2.ackWrites.length, 0, `LB 首次 pull 写了 ${e2.ackWrites.length} 笔：A→B 切换确实触发了写`);
  assert.ok(!clientReconciles(e2.hot, e2.pushed, E2_ID, E1_ID),
    'LB 的判据竟然成立了：那 E 就不是「换会话收不到应答」的成因');
  // 变异 M4 → E2 的第二句红（key 带上会话 id 后 A/B 不再同串，会写出去）。
});

// ══ 场景 F（#89 的 hotUsable 闸门）：恢复窗口内**整格**应答被扣住，与能否解析无关 ══
// 现场依据：2026-10-23 15:09 之后那份日志里 `hotness domain busy, retrying attempt=1/10/20/30`
// 紧跟着 `hotness restore FAILED`（重试预算 40×150ms ≈ 6s），而客户端一个阶梯的时间轴
// 是 0/0.6/1.8/4.2/9.0s ⇒ 整个阶梯可以完全落在窗口里。
const F_SESSION = 'session-ack-fresh-restore';
const fDir = mkdtempSync(join(tmpdir(), 'dsh-pullack-'));
writeFileSync(join(fDir, 'suggest_ghost_hotness.json'), JSON.stringify({
  unit: { name: 'suggest_ghost_hotness', version: 1 },
  tables: { entries: { '部署服务': { text: '部署服务', count: 12 }, '查日志': { text: '查日志', count: 7 } } },
}), 'utf8');
const procF = await boot('F', { storageDir: fDir, rejectOpenTimes: 6, sessions: [{ id: F_SESSION, texts: ['先跑一遍冒烟再部署'] }] });
const fWindow = await procF.pull(F_SESSION); // 窗口内（open 前 6 次被拒 ≈ 900ms）
const fDeadline = Date.now() + 4000;
while (Date.now() < fDeadline && !traced.some((l) => l.includes('hotness restored'))) await sleep(25);
const fAfter = await procF.pull(F_SESSION);
realLog(`\n[F 恢复窗口] 窗口内 pull：应答写=${fWindow.ackWrites.length} 笔、带 _hot 的写=`
  + `${fWindow.ackWrites.filter((w) => w.cells.includes('_hot')).length} 笔、withheld 留痕=`
  + `${fWindow.trace.filter((l) => l.includes('hot push withheld')).length} 行；`
  + `恢复后 pull：应答写=${fAfter.ackWrites.length} 笔、history=`
  + `${Array.isArray(fAfter.hot?.history) ? `array(${fAfter.hot.history.length})` : String(fAfter.hot?.history)}`);

run('F1 恢复窗口内：会话可解析、历史非空，但 `_hot` 一格都不写（应答被整格扣住）', () => {
  assert.notEqual(procF.root.sessions.get(F_SESSION), undefined, '夹具的会话没进店');
  assert.equal(fWindow.ackWrites.filter((w) => w.cells.includes('_hot')).length, 0,
    `恢复窗口里竟然写出了 _hot（${fWindow.ackWrites.filter((w) => w.cells.includes('_hot')).length} 笔）：闸门没生效，本场景没造出来`);
  assert.ok(fWindow.trace.some((line) => line.includes('hot push withheld')),
    `缺 hot push withheld 留痕：${JSON.stringify(fWindow.trace.map((l) => l.slice(0, 60)))}`);
  // 变异 M6（`hotUsable` 恒 true）→ F1 的两条都红。
});

run('F2 窗口内客户端拿不到任何可确认的凭证：落地的那一笔里没有 history（只有建议格）', () => {
  const landedPush = fWindow.ackWrites.find((w) => w.cells.includes('_push'));
  assert.ok(landedPush !== undefined, '窗口内一笔应答都没写：那 F1 就成了「什么都没写」而不是「扣住一格」');
  assert.ok(!('history' in JSON.parse(String(landedPush.patch._push))), '_push 里出现了 history：镜像的 hotSource 回落口径要改');
  assert.ok(!clientReconciles(null, procF.cell('_push'), F_SESSION, null),
    '窗口内的应答居然能让客户端对账：那 F 就不是一条独立成因');
});

run('F3 恢复终局之后同一会话的 pull 才写出带 history 的应答（窗口是暂时的，但阶梯已经跑完）', () => {
  assert.ok(fAfter.hot !== null && Array.isArray(fAfter.hot.history), `恢复后仍没有 history：${JSON.stringify(fAfter.hot)}`);
  assert.ok(fAfter.hot.history.includes('先跑一遍冒烟再部署'), `恢复后的环不对：${JSON.stringify(fAfter.hot.history)}`);
  assert.ok(clientReconciles(fAfter.hot, fAfter.pushed, F_SESSION, null), '恢复后的应答在客户端判据下不成立');
});

// ══ 静态守卫：两份镜像必须跟源码同形（镜像漂了，上面的机制解释就作废）═══════════
const hostSource = readFileSync(join(HERE, '..', 'src', 'index.ts'), 'utf8');
const clientSource = readFileSync(join(HERE, '..', 'src', 'client', 'index.ts'), 'utf8');

run('G1 宿主侧判重是「按格比指纹」，且 hotSigOf 的空数组仍折进 ∅（镜像与源码同形）', () => {
  assert.match(hostSource, /const hotDirty = [^\n]*fpHot !== lastHotFingerprint;/, '按格判重的写法变了：脚本的前提要重写');
  assert.match(hostSource, /const fpHot = fingerprintOfHot\(p\);/, 'pull 应答仍走 fingerprintOfHot 判重');
  assert.match(
    hostSource,
    /o\.history === undefined \|\| o\.history === null \|\| o\.history\.length === 0/,
    'hotSigOf 不再把「空数组」折进 ∅：E 这条断言的解释要改（镜像需同步）',
  );
  assert.match(
    hostSource,
    /\.\.\.\(p\.history !== null && p\.historySessionId !== null[\s\S]{0,80}history: \[\.\.\.p\.history\], historySessionId: p\.historySessionId \}/,
    'buildHotPayload 不再「两者皆非 null 才带 history」：B 的解释要改（镜像需同步）',
  );
});

run('G2 客户端停止阶梯的唯一判据仍是 historySessionId === pending.sessionId（镜像与源码同形）', () => {
  assert.match(
    clientSource,
    /if \(settings\.historySessionId === pending\.sessionId\) \{\s*\n\s*pendingPull = null;/,
    'retryPendingPull 的停止判据变了：clientReconciles 镜像要跟着改',
  );
  assert.match(
    clientSource,
    /historySessionId: Array\.isArray\(hotSource\.history\)/,
    'historySessionId 的赋值条件变了（不再只认 Array.isArray(history)）：B/E 的结论要重估',
  );
  assert.match(clientSource, /const PULL_MAX_ATTEMPTS = 4;/, '退避上限变了：现场「连续 5 条」的换算要改');
});

// ══ 噪声守卫：应答零写**不等于** op 没被消费（现场日志的 229 行就是这么来的）════
run('N1 现场日志形态对齐：单 op 批没有 `ops batch received`、也没有 `deferred push skipped`', () => {
  // 与 2026-10-23 那份 665 行日志同形：pull 阶梯每批只有一个 op ⇒ 不该有「收到」行；
  // 本夹具的写全部成功 ⇒ 也不该有补写跳过行。有这两行说明夹具多造了别的路径。
  const all = traced.join('\n');
  assert.ok(!all.includes('ops batch received'), '出现了 ops batch received：单 op 批的形态没有复现出来');
  assert.ok(!all.includes('deferred push skipped'), '出现了 deferred push skipped：夹具里不该有补写跳过');
  assert.ok(all.includes('hot push landed') || all.includes('push landed'), '一笔落地留痕都没有：那「第一条 pull 前后有写」的现场形态没复现');
});

console.log = realLog;
if (failures.length > 0) {
  console.error(`\n❌ pull-ack-smoke: ${cases} 组用例，失败 ${failures.length} 组：${failures.join(' / ')}`);
  process.exit(1);
}
realLog(`\n✅ pull-ack-smoke: ${cases} 组用例全部通过（产物=${libDir}/index.js，留痕 ${traced.length} 行）`);
process.exit(0);
