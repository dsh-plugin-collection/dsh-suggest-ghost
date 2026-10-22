#!/usr/bin/env node
/**
 * 未判定残留随建议格带出（Gitea #56；task-18 的**先证伪再修**冒烟）。
 *
 * ## 要钉的现场
 *
 * 盘上残留的建议属于会话 A，A 在本次运行期间**始终没进店** ⇒ 宿主判不了它
 * （`decidePersistedPush` 回 `session-unavailable`）。此时发生的是**别的会话 B** 的一次
 * `pull` **或**一次停顿续写 ⇒ 应答是一份「B 视角的完整快照」，`suggestion: null`
 * 被当成新值写下去 ⇒ **盘上 A 那条残留的字节就地消失**。
 *
 * 两级丢失要分清（#56 评论 id 38257 第 2/3 条）：同进程内 A 首次 pull 仍能恢复
 * （`persistedPushRaw` 全程无清空点），**重启才是真丢**。所以本文件既测「B 动作之后盘上
 * 字节还在」，也测「再启一个进程读同一份介质，残留仍能被 A 取回」。
 *
 * ## 为什么这套断言是**行为**而不是读注释
 *
 * 全部判据都落在两处可观测量上：
 *  - **介质写记录** `medium.writes`：每一笔写带的是**哪一个键**、写完之后的介质是什么
 *    ⇒ 「有没有把 `_push` 整格盖掉」「有没有产生多余写」都是数出来的，不是看出来的；
 *  - **启动回读的判定链**（`decidePersistedPush` 的可观测后果）：A 进店后第一次 pull
 *    的应答里到底有没有那条建议。
 *
 * ## 顺序纪律
 *
 * 本文件在**未改动的 main** 上跑必须是红的（场景 1/2/4 至少一条红）。红就是它的交付物之一：
 * 一条改前就绿的断言证伪不了任何东西。
 *
 * 用法：`node scripts/residual-carry-smoke.mjs`
 */
import assert from 'node:assert/strict';
import { Context, Service } from '@deepseek-ai/cordis';
import { SessionStore } from '@deepseek-ai/dsh-session';
import { apply as applyHost } from '../lib/index.js';
import { decidePersistedPush } from '../lib/coldstart.js';

const NS = 'suggest-ghost';
const SESSION_A = 'session-a';
const SESSION_B = 'session-b';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 夹具：内存 settings 面 + 假 llm + 写记录 ────────────────────────────────
function makeMedium(initial = {}) {
  let document = structuredClone(initial);
  const writes = [];
  return {
    get document() { return structuredClone(document); },
    read: (ns) => structuredClone(document[ns] ?? {}),
    merge(ns, patch) {
      document = { ...document, [ns]: { ...document[ns], ...structuredClone(patch) } };
      writes.push({ ns, keys: Object.keys(patch).sort(), after: structuredClone(document[ns] ?? {}) });
    },
    writes,
    /** 某一格里第 N 次被写之前的值（用于「字节没变」的断言）。 */
    pushWrites: () => writes.filter((w) => w.keys.includes('_push')),
  };
}

function installSettingsService(root, medium, { refuseFirstWrites = 0 } = {}) {
  class MemorySettings extends Service {
    revision = 0;
    refused = 0;
    constructor(ctx) { super(ctx, 'settings'); }
    describe() { return [{ ns: NS, revision: this.revision, value: medium.read(NS) }]; }
    /**
     * 前 `refuseFirstWrites` 笔**建议格**写按 HMR 事务拒绝的原样 reject
     * （`HMR transactions cannot be nested`）——用来走通「被拒 → 入补写队列 → 事务外
     * 泵 flush」这条真实路径；`_ops` 清空不拒（否则噪声会盖住要验的东西）。
     */
    update(ns, patch) {
      if (refuseFirstWrites > 0 && Object.prototype.hasOwnProperty.call(patch, '_push')) {
        this.refused += 1;
        refuseFirstWrites -= 1;
        return Promise.reject(new Error('HMR transactions cannot be nested'));
      }
      medium.merge(ns, patch);
      this.revision += 1;
      this.ctx.emit('settings/document-updated', ns, this.revision);
      return Promise.resolve();
    }
  }
  return new MemorySettings(root);
}

/** 假 llm：固定吐一句可预测的续写，让 `complete` 那条路径真的走到 pushToClient。 */
function installFakeLlm(root, text) {
  class FakeLlm extends Service {
    constructor(ctx) { super(ctx, 'llm'); }
    stream() {
      return (async function* emit() {
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text };
        yield { type: 'block-end', index: 0, block: { type: 'text', text } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      })();
    }
  }
  return new FakeLlm(root);
}

/** 残留载荷：属于 A、turn 1、baseSeq 2（A 未进店 ⇒ 宿主判不了）。 */
const RESIDUAL = {
  version: 1, turn: 1, baseSeq: 2, text: '把构建脚本改一下', truncated: false, acceptKey: 'Tab',
  frame: 1, final: true,
};
const residualPush = (sessionId) => JSON.stringify({
  rev: 7, suggestion: RESIDUAL, suggestionSessionId: sessionId, hot: null, total: 0,
});

/** 起一个「进程」：介质复用（模拟同一份 profile），A 是否进店由调用方决定。 */
async function boot(medium, { createA, createB, refuseFirstWrites = 0 }) {
  const root = new Context();
  if (root.logger === undefined) root.logger = { info() {}, warn() {}, debug() {} };
  new SessionStore(root);
  const settings = installSettingsService(root, medium, { refuseFirstWrites });
  installFakeLlm(root, ' node build.mjs');
  if (createA) makeSession(root, SESSION_A);
  if (createB) makeSession(root, SESSION_B);
  applyHost(root, {
    provider: 'p', model: 'm', maxInputBytes: 4096, maxOutputTokens: 128, timeoutMs: 4000,
    maxTranscriptChars: 4000, maxSuggestionChars: 120, inlineMinChars: 2, inlineDelayMs: 10,
    inlineMaxChars: 80, llmEnabled: true, historyEnabled: true, inlineEnabled: true,
  });
  for (let i = 0; i < 60 && settings.revision === 0 && medium.writes.length === 0; i += 1) await sleep(10);
  await sleep(80);
  return { root, settings, medium };
}

/** 取回已进店的会话对象（0.2.x 的读面；两种形态都试一次，不猜）。 */
function findSession(root, id) {
  const direct = root.sessions.getSession?.(id) ?? root.sessions.get?.(id);
  if (direct !== undefined && direct !== null) return direct;
  const scoped = root.sessions.scope?.(id);
  const viaScope = scoped === undefined ? undefined : root.sessions.sessionOf?.(scoped);
  assert.ok(viaScope !== undefined && viaScope !== null, `取不到会话 ${id}：sessions 读面与预期不符`);
  return viaScope;
}

function makeSession(root, id, firstTurn = 1) {
  const session = root.sessions.create(id, { meta: { cwd: process.cwd() } });
  session.append('turn/start', { turn: firstTurn });
  session.append('user/message', {
    content: [{ type: 'text', text: '这个插件怎么构建' }], source: { kind: 'user' },
  }, { surfaceOp: 'append' });
  session.append('assistant/message', {
    turn: 1, step: 1,
    message: { role: 'assistant', content: [{ type: 'text', text: '在仓根跑 node build.mjs。' }] },
    stream: [],
  }, { surfaceOp: 'append' });
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
  return session;
}

const pushOf = (medium) => medium.read(NS)._push;
/**
 * 残留「还在不在」的**载体无关**判据：住在 `_push` 里（懒搬迁尚未发生）或住在 `_residual`
 * 里（搬迁已发生）都算在；两处都没有才算丢。刻意不写死「必须在哪一格」——那是形状细节，
 * 而这条断言要守的是 #56 的事实：**未判定的残留不能被一次别的会话的动作弄没**。
 */
const residualStillOnDisk = (medium) => ['_push', '_residual'].some((cell) => {
  const raw = medium.read(NS)[cell];
  return typeof raw === 'string' && raw.includes(RESIDUAL.text)
    && raw.includes(SESSION_A);
});
/** 盘上那条待判定残留（载体无关）：`_residual` 优先，退回 `_push` 的建议部分。 */
const residualOnDisk = (medium) => {
  const disk = medium.read(NS);
  for (const cell of ['_residual', '_push']) {
    const raw = disk[cell];
    if (typeof raw !== 'string' || raw === '' || raw === 'null') continue;
    try {
      const parsed = JSON.parse(raw);
      if (parsed?.suggestion?.text === RESIDUAL.text && parsed?.suggestionSessionId === SESSION_A) {
        return parsed.suggestion;
      }
    } catch { /* 不是合法 JSON：这一格不算 */ }
  }
  return null;
};

/** `_residual` 这一格是否为空（没被写过、或已被清成 'null'）。 */
const residualCellIsEmpty = (medium) => {
  const raw = medium.read(NS)._residual;
  return raw === undefined || raw === '' || raw === 'null';
};

/**
 * 不变式③的断言形态：**任何一次写 `_push` 之后，那一笔落地的快照里必须还找得到残留**
 * （住在 `_push` 或 `_residual` 任一格）。找不到的那一笔就是「把残留弄没了的写」。
 *
 * 只在「残留尚未了结」的窗口里调它——判定收敛之后建议格本来就不该再带着它。
 * 这一条是懒写唯一的漏洞的补丁：第一次写被 HMR 事务拒 → 入队 → 泵稍后 flush 队列里那份
 * 载荷，若队列路径没带上 `_residual`，`_push` 与 `_residual` 会在同一笔被拒里一起丢。
 */
const firstPushWriteThatDroppedResidual = (medium) => medium.pushWrites().find((w) => {
  const cells = ['_push', '_residual'];
  return !cells.some((cell) => {
    const raw = w.after?.[cell];
    return typeof raw === 'string' && raw.includes(RESIDUAL.text) && raw.includes(SESSION_A);
  });
}) ?? null;

let failed = 0;
const scenario = async (name, fn) => {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  ✗ ${name}\n      ${String(error.message).split('\n').slice(0, 4).join('\n      ')}`);
  }
};

// ── 0. 前提自检：A 未进店时宿主确实判不了（`session-unavailable`）────────────
await scenario('前提：A 未进店 ⇒ decidePersistedPush 判 session-unavailable（这就是「未判定」）', () => {
  const verdict = decidePersistedPush(residualPush(SESSION_A), {
    sessionExists: (id) => id === SESSION_B,
    isCurrent: () => true,
  });
  assert.equal(verdict.action, 'skip');
  assert.equal(verdict.reason, 'session-unavailable');
  assert.deepEqual(verdict.suggestion?.text, RESIDUAL.text, '判不了但仍认得出那条建议 ⇒ 才谈得上「带出去」');
});

// ── 1. 场景「A 残留 + B 一次 pull」──────────────────────────────────────────
await scenario('场景 1：B 的一次 pull 之后，盘上 A 的残留字节仍在（含 A 的会话归属）', async () => {
  const medium = makeMedium({ [NS]: { _push: residualPush(SESSION_A), _ops: 'null' } });
  const before = pushOf(medium);
  const { root, settings } = await boot(medium, { createA: false, createB: true });
  const writesAfterBoot = medium.pushWrites().length;

  await settings.update(NS, { _ops: JSON.stringify({ rev: 1, ops: [{ op: 'pull', sessionId: SESSION_B }] }) });
  await sleep(200);

  // 关键断言（不变式③）：B 的应答**可以**重写 `_push`（它确实有新内容），但那笔写必须
  // 在同一 patch 里把 `_residual` 一起落 —— 「写了建议格却把残留落下」才是 #56 的病。
  const pushWrites = medium.pushWrites();
  assert.ok(residualStillOnDisk(medium),
    'B 的 pull 之后残留必须还在盘上（`_push` 或 `_residual` 任一格）；'
    + `盘上=${JSON.stringify(medium.read(NS)).slice(0, 260)}`);
  assert.equal(firstPushWriteThatDroppedResidual(medium), null,
    '有一笔 `_push` 写把残留弄没了（写后的快照里 `_push` 与 `_residual` 都找不到它）');
  assert.ok(pushWrites.length <= writesAfterBoot + 1,
    `一次 pull 至多一笔建议格写（无多余写）；boot 后=${writesAfterBoot}，现在=${pushWrites.length}`);
  await root[Symbol.asyncDispose]?.();
});

// ── 2. 场景「A 残留 + B 一次停顿续写」───────────────────────────────────────
await scenario('场景 2：B 的一次停顿续写之后，盘上 A 的残留字节仍在（第二个入口，更常发生）', async () => {
  const medium = makeMedium({ [NS]: { _push: residualPush(SESSION_A), _ops: 'null' } });
  const before = pushOf(medium); // 用于最后那条「这格确实被重写过」的反向断言
  const { root, settings } = await boot(medium, { createA: false, createB: true });

  await settings.update(NS, {
    _ops: JSON.stringify({ rev: 2, ops: [{ op: 'complete', sessionId: SESSION_B, draft: '这个插件怎么构建' }] }),
  });
  await sleep(400);

  assert.ok(residualStillOnDisk(medium),
    `续写应答也不得盖掉 A 的残留；盘上=${JSON.stringify(medium.read(NS)).slice(0, 260)}`);
  assert.equal(firstPushWriteThatDroppedResidual(medium), null,
    '续写那笔 `_push` 写同样必须同批带上 `_residual`（漏了就是两条一起丢）');
  // 这一格**允许**被重写（多了 B 的续写就得写），但被重写后的载荷里**建议那一段必须
  // 还是 A 那条**——「不改字节」是 pull 那一场的断言（场景 1 里它是「无多余写」的证据），
  // 到这里正确的判据是「建议字段逐项等值 + 归属仍是 A」。
  const after = JSON.parse(pushOf(medium));
  // 建议格现在**是** B 视角（正确：B 的续写要送达），残留改由 `_residual` 承载
  // ⇒ 字段级比对走载体无关的 `residualOnDisk`。
  assert.equal(after?.suggestion, null, 'B 自己没有建议时建议格就该是 null（不该拿残留凑）');
  const carried = residualOnDisk(medium);
  assert.ok(carried !== null,
    `残留必须仍在盘上；盘上=${JSON.stringify(medium.read(NS)).slice(0, 260)}`);
  // 逐字段比，不整体 deepEqual：`buildPushPayload`（`src/index.ts:1137-1149`）重写载荷时
  // 从来**不带** `version` 键（既有行为，不是本次改动引入的），整体比会因这个键红。
  for (const key of ['turn', 'baseSeq', 'text', 'truncated', 'acceptKey', 'frame', 'final']) {
    assert.deepEqual(carried?.[key], RESIDUAL[key], `残留的 ${key} 必须原样带出`);
  }
  // 但**续写本身必须照常送达**（不能为了不盖残留就把该推的东西憋回去）。
  assert.equal(after?.completion?.text, 'node build.mjs', 'B 的续写照常带出');
  assert.equal(after?.completionSessionId, SESSION_B, '续写归属是 B');
  assert.notEqual(pushOf(medium), before, '带续写 ⇒ 这一格确实变了 ⇒ 该写就写（不是无脑不写）');
  await root[Symbol.asyncDispose]?.();
});

// ── 3. 对照组：A **已**进店（启动即恢复）时，B 的 pull 本来就不该盖掉 ──────────
//
// 这一场**改前就该是绿的**——它验的是既有机制：`statePushOf` → `suggestionFieldsFor`
// 已经把「不属于本会话但仍被追踪的那条建议」原样带进应答（`src/coldstart.ts:322-334`）。
// 留着它的理由有两条：① 它证明形状没选错（带别的会话的建议这条路已经存在，缺的只是
// 「还没判定归属」的那一种）；② 改后它必须仍然是绿的，否则说明新逻辑把老路弄坏了。
await scenario('场景 3（对照）：A 已进店 ⇒ 残留已进追踪态，B 的 pull 不盖盘、A 再 pull 仍拿得到', async () => {
  const medium = makeMedium({ [NS]: { _push: residualPush(SESSION_A), _ops: 'null' } });
  const before = pushOf(medium);
  // A 在 apply() 之前就进店 ⇒ 启动回读能判定并恢复（不会再触发生成，正好隔离出对照）
  const { root, settings } = await boot(medium, { createA: true, createB: true });
  await settings.update(NS, { _ops: JSON.stringify({ rev: 3, ops: [{ op: 'pull', sessionId: SESSION_B }] }) });
  await sleep(220);
  assert.ok(pushOf(medium).includes(RESIDUAL.text),
    `A 已进店时，B 的 pull 不得盖掉盘上那条；实际=${String(pushOf(medium)).slice(0, 200)}`);
  await settings.update(NS, { _ops: JSON.stringify({ rev: 4, ops: [{ op: 'pull', sessionId: SESSION_A }] }) });
  await sleep(220);
  const payload = JSON.parse(pushOf(medium));
  assert.equal(payload?.suggestionSessionId, SESSION_A, `应答归属必须是 A；实际=${payload?.suggestionSessionId}`);
  assert.equal(payload?.suggestion?.text, RESIDUAL.text, '文本对上');
  assert.equal(payload?.suggestion?.turn, RESIDUAL.turn, 'turn 对上');
  assert.equal(payload?.suggestion?.baseSeq, RESIDUAL.baseSeq, 'baseSeq 对上');
  assert.ok(pushOf(medium) !== before || true, '（本场景允许 rev 顶格，字节内容对上即可）');
  await root[Symbol.asyncDispose]?.();
});

// ── 4. 重启那一级：B 动过之后再起一个进程，A 的残留仍在盘上、仍能被取回 ───────
await scenario('场景 4（重启一级，真丢的那级）：B 动作后重启，A 仍能在首次 pull 拿回残留', async () => {
  const medium = makeMedium({ [NS]: { _push: residualPush(SESSION_A), _ops: 'null' } });
  // 第一个进程：只有 B 在店，且 B 先 pull + 先续写各一次
  const first = await boot(medium, { createA: false, createB: true });
  await first.settings.update(NS, { _ops: JSON.stringify({ rev: 5, ops: [{ op: 'pull', sessionId: SESSION_B }] }) });
  await sleep(200);
  await first.settings.update(NS, {
    _ops: JSON.stringify({ rev: 6, ops: [{ op: 'complete', sessionId: SESSION_B, draft: '这个插件怎么构建' }] }),
  });
  await sleep(400);
  await first.root[Symbol.asyncDispose]?.();

  // 第二个进程（重启）：读同一份介质，A 这时才进店并 pull
  const second = await boot(medium, { createA: true, createB: false });
  assert.ok(residualStillOnDisk(medium),
    `重启后盘上仍必须有那条残留（任一格）；盘上=${JSON.stringify(medium.read(NS)).slice(0, 260)}`);
  await second.settings.update(NS, { _ops: JSON.stringify({ rev: 7, ops: [{ op: 'pull', sessionId: SESSION_A }] }) });
  await sleep(250);
  const payload = JSON.parse(pushOf(medium));
  assert.equal(payload?.suggestion?.text, RESIDUAL.text, '重启后 A 首次 pull 仍拿得到残留');
  assert.equal(payload?.suggestionSessionId, SESSION_A);
  await second.root[Symbol.asyncDispose]?.();
});

// ── 5. 新形状专属场景：B **自己也有建议** + A 的残留未判定 ───────────────────
//
// 这一场是 lead 复核 `suggestionFieldsFor`（`src/coldstart.ts:327`：
// `if (currentForSession !== null) return {suggestion: currentForSession, sessionId}`）
// 之后补的：**建议格只有一个槽位**，当前会话有建议时它优先占格 ⇒
// 「把未判定残留当作 A 的建议原样带上」这条**只覆盖 B 没有建议的那一半情形**。
// 而 B 有建议是常见得多的一种（用户在 B 跑过一轮再切来切去）。
// ⇒ 残留要有自己的载体格（`_residual`），保护才是**构造性**的，而不是「写的时候记得带」。
await scenario('场景 5：B 自己也有建议 + A 的残留未判定 ⇒ 残留仍须在盘上（单槽塞不下两条）', async () => {
  const medium = makeMedium({ [NS]: { _push: residualPush(SESSION_A), _ops: 'null' } });
  const { root, settings } = await boot(medium, { createA: false, createB: true });

  // B 跑一轮 ⇒ 产出一条**属于 B** 的建议（这一笔推送本身就是覆盖点，比 pull 更早发生）
  const sessionB = root.sessions.getSession?.(SESSION_B) ?? undefined;
  const b = sessionB ?? findSession(root, SESSION_B);
  b.append('turn/start', { turn: 2 });
  b.append('user/message', {
    content: [{ type: 'text', text: '那测试呢' }], source: { kind: 'user' },
  }, { surfaceOp: 'append' });
  b.append('assistant/message', {
    turn: 2, step: 1,
    message: { role: 'assistant', content: [{ type: 'text', text: 'bash -c 跑冒烟。' }] },
    stream: [],
  }, { surfaceOp: 'append' });
  b.append('turn/end', { turn: 2, reason: { kind: 'completed' } });
  await sleep(400);

  const afterB = JSON.parse(pushOf(medium));
  assert.equal(afterB?.suggestionSessionId, SESSION_B, 'B 的建议理应占格（它才是本会话的）');
  // 但 A 那条**不能因此消失**：它得还留在盘上（在任何一格里），等 A 进店再判。
  const disk = medium.read(NS);
  const residualAnywhere = JSON.stringify(disk).includes(RESIDUAL.text);
  assert.ok(residualAnywhere,
    `B 有建议时 A 的残留必须有地方待着；盘上=${JSON.stringify(disk).slice(0, 300)}`);

  // 「B 占着格 + A 还没进店」这一场里，A 拿回残留的那一级放到**重启**后验（下面第二进程）。
  // 不在同一进程里中途建 A：建会话会附带一个 turn/end ⇒ 触发一次真实生成 ⇒ A 有了自己的
  // 新建议，残留被**合法**取代——那是另一件事，混进来这条断言就没有信息量了。
  assert.equal(firstPushWriteThatDroppedResidual(medium), null,
    'B 有建议时的那笔 `_push` 写也必须同批带上 `_residual`');
  await root[Symbol.asyncDispose]?.();

  const second = await boot(medium, { createA: true, createB: false });
  const { settings: settleSettings, medium: medium2 } = second;
  await second.settings.update(NS, { _ops: JSON.stringify({ rev: 9, ops: [{ op: 'pull', sessionId: SESSION_A }] }) });
  await sleep(300);
  const payload = JSON.parse(pushOf(second.medium));
  assert.equal(payload?.suggestion?.text, RESIDUAL.text,
    `A 首次 pull 应拿回残留；实际=${JSON.stringify(payload?.suggestion)}`);
  assert.equal(payload?.suggestionSessionId, SESSION_A);

  // 了结之后不复发。分两半验，因为「B 再 pull 一次格就该回 B」是**错的期望**：
  // 这个进程里 B 根本没跑过回合、没有自己的建议，而 `suggestionFieldsFor` 本来就会把
  // 「别的会话仍有效的建议」带上（切回时立即可用）⇒ 格上是 A 的才是对的。
  // 真正要钉的是：① 那一格 `_residual` 已经被清空（判定收敛落盘）；② 残留不再以「待判定」
  // 身份存在 —— B 一旦有了自己的建议，格就归 B，且不会再把 A 那条当残留搬回去。
  assert.ok(residualCellIsEmpty(medium2),
    `A 了结后 _residual 必须已清空；盘上=${JSON.stringify(medium2.read(NS)).slice(0, 300)}`);
  makeSession(second.root, SESSION_B, 1);          // B 进店（apply 之后 ⇒ 会真生成一条自己的建议）
  await sleep(400);
  await settleSettings.update(NS, { _ops: JSON.stringify({ rev: 10, ops: [{ op: 'pull', sessionId: SESSION_B }] }) });
  await sleep(300);
  const afterSettle = JSON.parse(pushOf(medium2));
  assert.equal(afterSettle?.suggestionSessionId, SESSION_B,
    `B 有自己的建议之后格该归 B；实际=${JSON.stringify(afterSettle?.suggestion)}`);
  assert.ok(residualCellIsEmpty(medium2),
    `且不得把 A 那条重新当残留搬回去；盘上=${JSON.stringify(medium2.read(NS)).slice(0, 300)}`);
  await second.root[Symbol.asyncDispose]?.();
});

// ── 5b. 陈旧残留：判定完成后必须**丢弃**，不得长期占着格子 ────────────────────
await scenario('场景 5b：残留对 A 已陈旧（A 进店且回合已推进）⇒ 丢弃，之后任何应答都不该再带它', async () => {
  const medium = makeMedium({ [NS]: { _push: residualPush(SESSION_A), _ops: 'null' } });
  // A 进店，且日志里的完成回合已经**超过**残留的 turn（⇒ `decidePersistedPush` 判 stale-turn）
  const { root, settings } = await boot(medium, { createA: false, createB: true });
  const a = findSession(root, SESSION_B) === undefined ? null : makeSession(root, SESSION_A, 1);
  assert.ok(a !== null, '夹具没拿到会话对象');
  // A 已经跑到 turn 3：残留那条（turn 1）对它不再有效
  const sessionA = findSession(root, SESSION_A);
  sessionA.append('turn/start', { turn: 2 });
  sessionA.append('user/message', { content: [{ type: 'text', text: '第二句' }], source: { kind: 'user' } }, { surfaceOp: 'append' });
  sessionA.append('turn/end', { turn: 2, reason: { kind: 'completed' } });
  sessionA.append('turn/start', { turn: 3 });
  sessionA.append('user/message', { content: [{ type: 'text', text: '第三句' }], source: { kind: 'user' } }, { surfaceOp: 'append' });
  sessionA.append('turn/end', { turn: 3, reason: { kind: 'completed' } });
  await sleep(400);

  // A 拉一次：此时判定成立 ⇒ 陈旧残留必须被丢弃（不是「判不了就永远留着」）
  await settings.update(NS, { _ops: JSON.stringify({ rev: 11, ops: [{ op: 'pull', sessionId: SESSION_A }] }) });
  await sleep(300);
  const disk = medium.read(NS);
  const payload = JSON.parse(disk._push);
  assert.notEqual(payload?.suggestion?.text, RESIDUAL.text,
    '陈旧残留不得再作为 A 的建议带出');
  // 丢弃要**彻底**：任何一格里都不该再躺着这条待判定的文本
  const stillPending = ['_push', '_hot', '_residual'].some((cell) => typeof disk[cell] === 'string'
    && disk[cell].includes(RESIDUAL.text)
    && !(disk[cell].includes('"suggestionSessionId":"session-b"') && cell === '_push'));
  assert.ok(!stillPending,
    `陈旧的待判定残留应已被清空；盘上=${JSON.stringify(disk).slice(0, 320)}`);
  await root[Symbol.asyncDispose]?.();
});

// ── 6. 不变式③最难的那条路径：第一笔 `_push` 写**被拒**之后由泵补写 ────────────
//
// lead 追加的那条不变式针对的正是这里：第一次写被 HMR 事务拒 ⇒ 载荷进补写队列 ⇒
// 稍后 `drainDeferred` flush 的是**队列里那份字节**；若那条路径没带上 `_residual`，
// 于是「`_push` 落了（把残留盖掉）」而「`_residual` 从没落过」⇒ 两条一起丢、彻底没。
// 这一场不验形状、只验这条链条：被拒 → 补写 → 残留仍在。
await scenario('场景 6：第一笔建议格写被拒 → 泵补写 ⇒ 残留仍必须在盘上（不变式③的补写路径）', async () => {
  const medium = makeMedium({ [NS]: { _push: residualPush(SESSION_A), _ops: 'null' } });
  const { root, settings } = await boot(medium, { createA: false, createB: true, refuseFirstWrites: 1 });
  await settings.update(NS, { _ops: JSON.stringify({ rev: 12, ops: [{ op: 'pull', sessionId: SESSION_B }] }) });
  await sleep(150);
  // 被拒之后：盘上 `_push` 必须仍是原样（那一笔没落地），残留自然还在
  assert.ok(residualStillOnDisk(medium), '第一笔被拒后盘上原样就该保留');
  // 再给一次机会让泵补写（事务外锚点是 setInterval，等它跑）
  await settings.update(NS, { _ops: JSON.stringify({ rev: 13, ops: [{ op: 'pull', sessionId: SESSION_B }] }) });
  await sleep(1500);
  assert.ok(residualStillOnDisk(medium),
    `泵补写之后残留仍须在盘上；盘上=${JSON.stringify(medium.read(NS)).slice(0, 300)}`);
  assert.equal(firstPushWriteThatDroppedResidual(medium), null,
    '补写那笔 `_push` 落下时没同批带 `_residual`（或写后哪一格都没残留了）');
  // **这条不是可选**：要是那一笔 `_push` 始终没落地，上面两条就都是空转的绿。
  // 所以必须正面确认「补写真的发生了」——`_push` 已经从 A 的残留变成 B 视角的快照。
  const drainedPush = JSON.parse(pushOf(medium));
  assert.equal(drainedPush?.suggestionSessionId, null,
    '补写没落地，本场景就成了空转（盘上 `_push` 仍是原样）：'
    + JSON.stringify(drainedPush?.suggestion));
  assert.ok(medium.writes.some((w) => w.keys.includes('_push')),
    '介质上压根没有过建议格写 ⇒ 这条路径没被走到');
  await root[Symbol.asyncDispose]?.();
});

// ── 7. 不变量：启动只读不写不推（改前改后都必须绿，防止「顺手推一次」）────────
await scenario('不变量 ③：启动段只读不写（boot 之后介质上没有任何一次写）', async () => {
  const medium = makeMedium({ [NS]: { _push: residualPush(SESSION_A), _ops: 'null' } });
  const { root } = await boot(medium, { createA: false, createB: false });
  assert.deepEqual(medium.writes.map((w) => w.keys.join('+')), [],
    `启动期一笔写都不该有；实际=${JSON.stringify(medium.writes.map((w) => w.keys))}`);
  await root[Symbol.asyncDispose]?.();
});

// ── 8. 不变量：无残留时行为与改前逐字一致（不为了修 A 而弄脏 B）──────────────
await scenario('不变量：盘上没有残留时，B 的 pull 照旧写自己的快照（不多带也不少带）', async () => {
  const medium = makeMedium({ [NS]: { _push: 'null', _ops: 'null' } });
  const { root, settings } = await boot(medium, { createA: false, createB: true });
  await settings.update(NS, { _ops: JSON.stringify({ rev: 8, ops: [{ op: 'pull', sessionId: SESSION_B }] }) });
  await sleep(250);
  const payload = JSON.parse(pushOf(medium));
  assert.ok(payload !== null, '应答仍要写出来');
  assert.equal(payload.suggestion, null, '无残留 ⇒ 建议格仍是「本会话没有建议」');
  assert.equal(payload.suggestionSessionId, null);
  await root[Symbol.asyncDispose]?.();
});

console.log('');
console.log(failed === 0
  ? '✅ residual-carry-smoke: 全部通过（未判定残留不再被当成不存在）'
  : `❌ residual-carry-smoke: ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
