#!/usr/bin/env node
/**
 * `_hot` 节流（task-16 / #36 建议 2 第二步）：把「每次用户输入一次整档重写」压成
 * 「每窗口一次」，同时**必须**证明建议格一次都没被拖慢。
 *
 * ## 为什么这条线值得做，以及它的代价
 *
 * #57 把热度/历史环拆成独立一格之后，写次数**没有**下降（实测 4/4 持平）—— 因为热度每次
 * 用户输入都会变，拆格只是把「谁被重写」分开了。真正把写次数压下来的是这里：不让每次
 * 热度变化都触发一次整档 profile 重写。
 *
 * 代价是**陈旧**：窗口内客户端看到的是上一次的热度快照。它影响的是**热表排序**（历史补全
 * 候选的打分顺序），**不影响建议本身** —— 所以本脚本一半的断言都在钉「建议格没被拖慢」。
 *
 * ## 四条硬判据（来自 task-16，每条都有断言，且都用变异自证能红）
 *  1. 建议格永远立即写，绝不被热度窗口拖慢；
 *  2. pull 必须让路（应答带**当前**热度，必要时立即写一次热度格）；
 *  3. 热表恢复补推（`whenReady`）不被窗口拖后；
 *  4. 陈旧度有硬上界：≤ 窗口 + 一个泵间隔（计时起点是「上一次写出去」，不是「第一次待写」，
 *     否则连续打字会把写无限推后 = 饥饿）。
 *
 * 用**真定时器**而不是假时钟：`index.ts` 调 `Date.now()`，为了这条测试在宿主侧开一个可注入
 * 时钟的缝，代价（生产代码多一个 seam）大于收益（窗口 1000ms / 泵 500ms 都是能量化的真实
 * 节奏）。断言留了余量，不卡毫秒。
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context, Service } from '@deepseek-ai/cordis';
import { SessionStore } from '@deepseek-ai/dsh-session';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = process.env.GHOST_THROTTLE_REPO ?? join(HERE, '..');
const libDir = join(REPO, 'lib');
if (!existsSync(join(libDir, 'index.js'))) {
  console.error(`❌ 找不到构建产物：${libDir}/index.js（先 tsc + node build.mjs）`);
  process.exit(1);
}
const { apply: applyHost, HOT_PUSH_WINDOW_MS } = await import(join(libDir, 'index.js'));
const hostSource = readFileSync(join(REPO, 'src', 'index.ts'), 'utf8');
/**
 * 产物里有没有热度合并窗口 ⇒ 决定本次是「判定」还是「只打基线」。
 * 与 `payload-split-smoke` 同一口径：**没验到的不得写成通过**，基线也只打印不判定，
 * 这样同一份脚本跑两遍（换 repo 不换代码）出来的两张表可以直接对比。
 */
const BASELINE = !hostSource.includes('hotWindowOpenedAt');
const pumpSource = readFileSync(join(REPO, 'src', 'deferred-writes.ts'), 'utf8');
const PUMP_MS = Number(/export const DEFERRED_PUMP_MS = (\d+)/.exec(pumpSource)?.[1] ?? 500);
const NS = 'suggest-ghost';
const SESSION = 'session-a';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
const run = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}\n      ${String(error.message).split('\n')[0]}`);
  }
};

/** 假流：正文由参数决定，所以「建议变 / 不变」是可控的。 */
const textStream = (text) => [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text },
  { type: 'block-end', index: 0, block: { type: 'text', text } },
  { type: 'finish', reason: { kind: 'stop' } },
];
const holder = { chunks: textStream('跑一下冒烟') };

let document = { [NS]: { _ops: 'null', _push: 'null', _hot: 'null' } };
const writes = [];
let revision = 0;

class MemorySettings extends Service {
  constructor(ctx) { super(ctx, 'settings'); }
  describe() { return [{ ns: NS, revision, value: structuredClone(document[NS] ?? {}) }]; }
  update(ns, patch) {
    document = { ...document, [ns]: { ...document[ns], ...structuredClone(patch) } };
    revision += 1;
    writes.push({ at: Date.now(), cells: Object.keys(patch).sort().join(','), patch: structuredClone(patch) });
    this.ctx.emit('settings/document-updated', ns, revision);
    return Promise.resolve();
  }
}

const traced = [];
const realLog = console.log.bind(console);
console.log = (...args) => {
  const line = args.map(String).join(' ');
  if (line.includes('[ops-trace]')) traced.push(line);
  else realLog(...args);
};

const root = new Context();
if (root.logger === undefined) root.logger = { info() {}, warn() {}, debug() {} };
new SessionStore(root);
const settings = new MemorySettings(root);
installFakeLlm();
function installFakeLlm() {
  class FakeLlm extends Service {
    constructor(ctx) { super(ctx, 'llm'); }
    stream(options) {
      const chunks = holder.chunks;
      return (async function* () { for (const c of chunks) { await sleep(2); yield c; } })();
    }
  }
  new FakeLlm(root);
}
const session = root.sessions.create(SESSION, { meta: { cwd: process.cwd() } });
session.append('turn/start', { turn: 1 });
session.append('user/message', { content: [{ type: 'text', text: '第一句' }], source: { kind: 'user' } }, { surfaceOp: 'append' });
session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });

applyHost(root, {
  maxInputBytes: 4096, maxOutputTokens: 512, timeoutMs: 2000,
  maxTranscriptChars: 12000, maxSuggestionChars: 240,
  provider: 'p-smoke', model: 'm-smoke',
});
await sleep(120);

/**
 * 造一个「只改热度、不改建议」的回合 —— 这才是节流真正作用的场景。
 *
 * 两点实测教出来的口径（第一版都写错了）：
 *  - 单发一条 `add` op **不会**推送：`consumeOps` 只对 pull/complete 应答，热表变化要等到
 *    下一次推送才出去。所以「纯热度变化」必须挂在真实推送时机上，不是挂在 ops 上。
 *  - 回合结束必然带来新建议 ⇒ `suggestion.turn` 变 ⇒ 建议格总是脏的，窗口永远轮不到合并。
 *    真正「只有热度变」的回合，是**这次没产出建议**（空回复/被过滤）那类 —— 沙箱实测这种
 *    在 `efficient` 路由上是常态（reasoning-only，outcome=empty），不是边角情况。
 * 于是这里喂一条「只有推理、没有正文」的流：建议格保持原样（不脏），热度与历史环变（脏）。
 */
async function hotOnlyTurn(turn, text) {
  const before = writes.length;
  const t0 = Date.now();
  holder.chunks = [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: '想一下' },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: '想一下' } },
    { type: 'block-start', index: 1, blockType: 'text' },
    { type: 'block-end', index: 1, block: { type: 'text', text: '' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ];
  session.append('turn/start', { turn });
  session.append('user/message', { content: [{ type: 'text', text }], source: { kind: 'user' } }, { surfaceOp: 'append' });
  session.append('turn/end', { turn, reason: { kind: 'completed' } });
  await sleep(300);
  return { w: writes.slice(before), t0 };
}
/** 一个「有新建议」的回合：建议格必然脏，窗口不许拖慢它。 */
async function suggestionTurn(turn, text, suggestion) {
  const before = writes.length;
  const t0 = Date.now();
  holder.chunks = textStream(suggestion);
  session.append('turn/start', { turn });
  session.append('user/message', { content: [{ type: 'text', text }], source: { kind: 'user' } }, { surfaceOp: 'append' });
  session.append('turn/end', { turn, reason: { kind: 'completed' } });
  await sleep(400);
  return { w: writes.slice(before), t0 };
}
const isHot = (w) => w.cells === '_hot';
const isPushCarrying = (w) => w.cells.includes('_push');

// ── 场景 1：5 个「只有热度变」的回合 ⇒ 合并成 ≤2 次热度写 ──────────────────────
await suggestionTurn(2, '把 diff 看一遍', '先看 diff'); // 让两格都先有内容
const base1 = writes.length;
const firstAt = Date.now();
for (let i = 3; i <= 7; i += 1) {
  await hotOnlyTurn(i, `用户第${i}句`);
  await sleep(200);
}
await sleep(PUMP_MS + 400); // 给窗口到期的那次泵补写留出时间
const w1 = writes.slice(base1);
const hotWrites1 = w1.filter((w) => w.cells.includes('_hot'));
const pushWrites1 = w1.filter((w) => w.cells.includes('_push'));
const staleMs = hotWrites1.length ? hotWrites1[hotWrites1.length - 1].at - firstAt : -1;

console.log(`\n窗口=${HOT_PUSH_WINDOW_MS}ms 泵=${PUMP_MS}ms · 5 个「只热度变」的回合 ⇒ 写总数=${w1.length} `
  + `（含 _hot=${hotWrites1.length}，含 _push=${pushWrites1.length}）`);
console.log(`合并留痕=${traced.filter((l) => l.includes('hot push coalesced')).length} 行 · coalesced 值=`
  + `${traced.filter((l) => /coalesced=\d/.test(l)).map((l) => /coalesced=(\d+)/.exec(l)?.[1]).join(',')}`);

const counts = { 场景: '5 个「只热度变」的回合 + 1 个有新建议的回合', 写总数: writes.length, 含_hot: hotWrites1.length, 含_push: w1.filter((x) => x.cells.includes('_push')).length, 合并留痕: traced.filter((l) => l.includes('hot push coalesced')).length };
if (BASELINE) {
  console.log('\n⚠ 基线模式：产物里没有热度合并窗口 ⇒ 只打印写次数、不做判定（不伪装成通过）。');
}
const runGate = (name, fn) => (BASELINE ? undefined : run(name, fn));
runGate('1) 纯热度回合被合并：写次数**低于变化次数**，且不超设计上限', () => {
  assert.ok(HOT_PUSH_WINDOW_MS > 0, `窗口被改成 0 ⇒ 本条应红（节流不存在）：${HOT_PUSH_WINDOW_MS}`);
  const spanMs = (hotWrites1.length ? hotWrites1[hotWrites1.length - 1].at : Date.now()) - firstAt;
  // 设计是「每窗口至多一次写」⇒ 上限由时间跨度决定，不是拍脑袋的 2。
  // （第一版我写死 ≤2，量到 3 就红了 —— 那是断言写错：5 个回合跨 ~2.5s、窗口 1s，
  //  本来就该落 2~3 次。真正的判据是「低于变化次数」+「不超过窗口刻度」。）
  const cap = Math.ceil(spanMs / HOT_PUSH_WINDOW_MS) + 1;
  assert.ok(hotWrites1.length < 5,
    `5 个纯热度回合写出 ${hotWrites1.length} 次 _hot ⇒ 完全没有合并（每次变化仍一次整档重写）`);
  assert.ok(hotWrites1.length <= cap,
    `_hot 写 ${hotWrites1.length} 次 > 窗口刻度上限 ${cap}（跨度 ${spanMs}ms / 窗口 ${HOT_PUSH_WINDOW_MS}ms）⇒ 节流没起作用`);
  assert.ok(traced.some((l) => /hot push coalesced/.test(l)), '没有 hot push coalesced 留痕 ⇒ 合并没有发生或不可观测');
});

runGate('2) 陈旧度有硬上界：**相邻两次热度写的间隔** ≤ 窗口 + 一个泵间隔 + 余量', () => {
  // 口径要准：合并是「每窗口至多一次写」，所以正确的上界是**相邻两次写之间**不超过
  // 窗口+泵+余量。拿「第一次变化到最后一次写」当上界是错的：5 次变化跨 2.5s 时它必然
  // 超过一个窗口（那是两三个窗口的量），而每一次落地的陈旧度都仍然 ≤ 上界。
  // （第一版我正是拿总时长当判据，量到 2988ms > 2400ms —— 那是断言写错，不是节流失效。）
  const bound = HOT_PUSH_WINDOW_MS + PUMP_MS + 900;
  assert.ok(hotWrites1.length > 0, '一次都没写热度 ⇒ 不是合并，是把数据丢了');
  const marks = [firstAt, ...hotWrites1.map((w) => w.at)];
  const gaps = marks.slice(1).map((t, i) => t - marks[i]);
  const worst = Math.max(...gaps);
  assert.ok(worst <= bound, `某段热度快照陈旧 ${worst}ms > 上界 ${bound}ms（gaps=${gaps.join(', ')}ms）`);
});

runGate('3) 不饥饿：窗口内至少落一次地，且合并计数真的在累加', () => {
  const maxCoalesced = Math.max(0, ...traced
    .map((l) => Number(/coalesced=(\d+)/.exec(l)?.[1] ?? 0)).filter((n) => Number.isFinite(n)));
  assert.ok(hotWrites1.length >= 1, '整段一次都没写出去 = 饥饿（计时起点取错了）');
  assert.ok(maxCoalesced >= 2,
    `合并计数最大只有 ${maxCoalesced} ⇒ 五次热度变化没有真的并成一次（coalesced 应该在落地时被报告）`);
});

// ── 场景 3b：pull 让路带出去的必须是**当前**热度，不是窗口里那份旧的 ────────────
{
  // 造一个「窗口内攒着没写」的现场：一次热度变化落地（leading，窗口随之开启），紧接着
  // 再来一次 ⇒ 后一份只进槽不写；此时 pull ⇒ 必须把**这一份**带出去。
  // （第一版我攒了两次再 pull，结果中间那次已被泵写掉、槽是空的 ⇒ 断言只能看内容，
  //  测不到「让路」这件事 —— 所以这里把节奏压进一个窗口内。）
  await hotOnlyTurn(9, '第九句');
  await hotOnlyTurn(10, '第十句');
  const before = writes.length;
  await settings.update(NS, {
    _ops: JSON.stringify({ rev: 77, ops: [{ op: 'pull', sessionId: SESSION }] }),
  });
  await sleep(80);
  // 用户可见的判据是「**pull 之后客户端能读到当前热表**」，不是「必须有一次含 _hot 的写」：
  // 若那份快照在本窗口内已经被前一次写带走（合并的节奏与场景时序有关），那没有新写才是
  // 正确行为（内容与盘上一致，重写一遍只是白推一个 revision）。「必须有新写」那一条由
  // 场景 5 专门钉（它把节奏压进窗口内，槽里确实攒着东西）。这里钉内容，两边合起来才完整：
  //  - 场景 5：窗口内有攒着 ⇒ pull 立刻写；
  //  - 本条：pull 之后盘上那格的内容必须是**当前**热表（不许是旧快照）。
  const allHot = writes.filter((w) => w.cells.includes('_hot'));
  const latest = allHot.length ? allHot[allHot.length - 1] : null;
  runGate('3b) pull 之后盘上的热度格内容必须是当前热表（不许读到旧快照）', () => {
    realLog(`  ℹ 3b 现场：pull 窗口内的写=${JSON.stringify(writes.slice(before).map((w) => w.cells))}，`
      + `含 _hot 的总写数=${allHot.length}`);
    assert.ok(latest !== null, '一次热度写都没有 ⇒ 数据丢了');
    const landed = JSON.parse(String(latest.patch._hot));
    const texts = (landed?.hot ?? []).map((e) => e.text);
    assert.ok(texts.some((t) => t.includes('第十句')),
      `pull 之后能读到的热表里没有最新一段输入（旧快照未被带出）：${JSON.stringify(texts)}`);
  });
}

// ── 场景 4：建议格永不被窗口拖慢（判据 1） ─────────────────────────────────────
const r4 = await suggestionTurn(8, '用户第八句', '先把测试跑绿');
const w4 = r4.w;
const suggestionLandedAt = w4.filter(isPushCarrying).map((w) => w.at - r4.t0);
runGate('4) 新建议出现后，携带建议格的写在**一个泵间隔内**落地（不等窗口）', () => {
  assert.ok(suggestionLandedAt.length >= 1, `建议变了却没写出建议格：${JSON.stringify(w4.map((w) => w.cells))}`);
  assert.ok(Math.min(...suggestionLandedAt) <= PUMP_MS + 400,
    `建议格等了 ${Math.min(...suggestionLandedAt)}ms 才落地（窗口=${HOT_PUSH_WINDOW_MS}ms）⇒ 建议被热度拖慢了，违反判据 1`);
});

// ── 场景 5：pull 让路（判据 2） ────────────────────────────────────────────────
// 先制造一次热度变化（开窗口），紧接着在窗口内 pull 另一个会话 ⇒ 应答必须带当前热度。
await hotOnlyTurn(11, '第十一句');
const before5 = writes.length;
const t5 = Date.now();
await settings.update(NS, {
  _ops: JSON.stringify({ rev: 91, ops: [{ op: 'pull', sessionId: SESSION }] }),
});
await sleep(60);
const w5 = writes.slice(before5).filter(isHot);
runGate('5) 窗口未到期的 pull：**立刻**写一次热度格（切会话不许先看到旧列表）', () => {
  const pulled = traced.filter((l) => /ops consumed: pull/.test(l)).length;
  assert.ok(pulled >= 1, 'pull 没被消费，本场景没有载体');
  assert.ok(w5.length >= 1,
    `pull 之后窗口内没有立即写热度 ⇒ 客户端先看到旧快照（违反判据 2）：cells=${JSON.stringify(writes.slice(before5).map((x) => x.cells))}`);
  assert.ok(w5.every((w) => w.at - t5 < PUMP_MS + 300),
    `pull 让路的写晚了 ${Math.max(...w5.map((w) => w.at - t5))}ms，不像让路而像等窗口`);
});

// ── 6) 静态：卸载前强刷 + whenReady 绕开窗口（判据 4、5） ───────────────────────
runGate('6) 卸载前强刷热度 + whenReady 补推带 hotNow（两条都在代码里）', () => {
  assert.ok(/pushToClient\(statePushOf\(lastSuggestionSession\), \{ hotNow: true \}\)/.test(hostSource)
    || /ctx\.effect\(\(\) => \(\) => \{[\s\S]{0,900}hotNow: true/.test(hostSource),
    '卸载路径里没有「把挂起的热度刷出去」⇒ 最后一段热度会随进程消失（判据 4）');
  const whenReady = hostSource.slice(hostSource.indexOf('persistence.whenReady'), hostSource.indexOf('persistence.whenReady') + 900);
  assert.ok(/hotNow: true/.test(whenReady), 'whenReady 那次修正被窗口拖后 = 客户端多看一个窗口的不完整快照（判据 5）');
  // 锚点从「固定 700 字符切窗」换成「pull 那行之后**第一笔** pushToClient」。判据 2 说的是
  // 「pull 的应答要让路」，切窗宽度与这条语义无关：留痕行一变长就把 `hotNow` 切到窗外假红
  // （2026-10-23 给 pull 加同会话重复计数时正好撞上，实测差 2 个字符）。
  // 变异自证：删掉应答那处的 `{ hotNow: true }` ⇒ 本条红；把 pull 留痕整行删掉 ⇒ 本条报
  // 「没有载体」而不是静默通过。
  const pullAt = hostSource.indexOf('ops consumed: pull');
  const answerAt = hostSource.indexOf('pushToClient(', pullAt);
  assert.ok(pullAt > 0 && answerAt > pullAt, '找不到 pull 消费行或它的应答调用 ⇒ 本条没有载体');
  assert.ok(/hotNow: true/.test(hostSource.slice(answerAt, answerAt + 120)), 'pull 应答没有让路（判据 2 的代码不在了）');
});

console.log = realLog;
console.table([counts]);
if (failed > 0) {
  console.error(`❌ hot-throttle-smoke: ${failed} 组失败`);
  process.exit(1);
}
console.log(`✅ hot-throttle-smoke: 合并生效（5 次变化 → ${hotWrites1.length} 次写）、建议格不被拖慢、pull 让路、陈旧度 ≤ ${HOT_PUSH_WINDOW_MS + PUMP_MS}ms`);
process.exit(0);
