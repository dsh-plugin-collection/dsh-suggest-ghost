#!/usr/bin/env node
/**
 * 「首字符到达即让路」（#63 / task-19）的断言。
 *
 * ## 它钉的四件事
 *  1. **窗口内攒着的热度快照，会被一次 `complete` op 立刻放出去**（而不是等窗口到期）；
 *  2. 放出去的那一份**内容必须是当前热表**（含刚合并掉的那条），否则让路只是"提前写了旧的"；
 *  3. **让路不产生额外写**：槽里没有攒着时，再来一次 `complete` ⇒ 含 `_hot` 的写次数为 0
 *     （按格判重还在，这是"推广让路"不等于"每键一次写"的证据）；
 *  4. **写次数 ≤ 待写变化数**（判据 ③ 的前半句，断言 6）：写次数由变化数封顶，
 *     不由 `complete` 的次数封顶 —— 后半句「无待写时不写」是断言 3。
 *  5. **窗口本身没被动过**（`HOT_PUSH_WINDOW_MS` 仍是 1000）—— 任务书明写"调小窗口是钝器"，
 *     所以这条要钉住：本条的修法是让路，不是缩窗口。
 *  另加：建议格不被牵连（让路那一次写只带热度格）。
 *
 * ## 为什么宿主侧最早只能到 `complete`
 * 会话事件面（`@deepseek-ai/dsh-session`）里**没有任何 draft/typing 通道**，按键只存在于浏览器；
 * 而 `complete` 是客户端 `inlineTriggerTimer` 到期时发的 —— 那一刻用户已经打了
 * ≥`inlineMinChars` 个字符并停顿。⇒ 这次让路救的是**本次合成的后续按键**与其后所有合成；
 * 「burst 内第一次合成的首字符」那 ≤1.5s 切片宿主侧救不了（要救只能客户端首字符发信号，
 * 那等于每轮连发多一次写，正是窗口省掉的东西）。这条边界写在 `src/index.ts` 的让路注释里，
 * 也在下面的 NOT-COVERED 行里。
 *
 * 用法：`node scripts/hot-yield-smoke.mjs`（已接入 test:smoke）
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context, Service } from '@deepseek-ai/cordis';
import { SessionStore } from '@deepseek-ai/dsh-session';
// 留痕自 2026-10-26 起分级：默认只有 warn/error 到达用户侧（心跳类走 console.debug 静默）。
// 本脚本靠抓 `[ops-trace]` 文本断言行为，故在加载插件前把门槛放到 debug。
// 这是**测试自己开档**，不改生产默认。
process.env.DSH_SUGGEST_GHOST_TRACE ??= 'debug';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = process.env.GHOST_YIELD_REPO ?? join(HERE, '..');
const libDir = join(REPO, 'lib');
if (!existsSync(join(libDir, 'index.js'))) {
  console.error(`❌ 找不到构建产物：${libDir}/index.js（先 tsc + node build.mjs）`);
  process.exit(1);
}
const { apply: applyHost, HOT_PUSH_WINDOW_MS } = await import(join(libDir, 'index.js'));
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

let document = { [NS]: { _ops: 'null', _push: 'null', _hot: 'null', _residual: 'null' } };
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

const realLog = console.log.bind(console);
const traced = [];
console.log = (...args) => {
  const line = args.map(String).join(' ');
  if (line.includes('[ops-trace]')) traced.push(line);
  else realLog(...args);
};
// 留痕分级后：心跳走 console.debug、状态迁移走 console.info、故障走 console.warn。
// 捕获必须覆盖全部通道，否则「缺某行」会被误读成行为坏了（实际只是打到别的流）。
const captured = console.log;
console.debug = captured;
console.info = captured;
console.warn = captured;


const holder = { chunks: [{ type: 'finish', reason: { kind: 'stop' } }] };
class FakeLlm extends Service {
  constructor(ctx) { super(ctx, 'llm'); }
  stream() {
    const chunks = holder.chunks;
    return (async function* () { for (const c of chunks) { await sleep(2); yield c; } })();
  }
}

const root = new Context();
if (root.logger === undefined) root.logger = { info() {}, warn() {}, debug() {} };
new SessionStore(root);
const settings = new MemorySettings(root);
new FakeLlm(root);
const session = root.sessions.create(SESSION, { meta: { cwd: process.cwd() } });
function userTurn(turn, text) {
  session.append('turn/start', { turn });
  session.append('user/message', { content: [{ type: 'text', text }], source: { kind: 'user' } }, { surfaceOp: 'append' });
  session.append('turn/end', { turn, reason: { kind: 'completed' } });
}
// 先给一轮"能产出建议"的流，让两格都有内容
holder.chunks = [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: '先跑一遍测试' },
  { type: 'block-end', index: 0, block: { type: 'text', text: '先跑一遍测试' } },
  { type: 'finish', reason: { kind: 'stop' } },
];
applyHost(root, {
  maxInputBytes: 4096, maxOutputTokens: 512, timeoutMs: 2000,
  maxTranscriptChars: 12000, maxSuggestionChars: 240,
});
await sleep(150);
await userTurn(1, '第一句用户输入');
await sleep(400);

// ── 造一个「窗口内攒着没写」的热度快照：≤1.5s 连发（#63 的那一类形态） ────────────
const hotWritesBase = writes.filter((w) => w.cells.includes('_hot')).length;
holder.chunks = [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: '再跑一遍测试' },
  { type: 'block-end', index: 0, block: { type: 'text', text: '再跑一遍测试' } },
  { type: 'finish', reason: { kind: 'stop' } },
];
await userTurn(2, '部署到预发环境并且检查端口');   // 这条进热表/历史环
await sleep(120);                                    // 远小于窗口
const staged = writes.filter((w) => w.cells.includes('_hot')).length;

console.log(`\n窗口=${HOT_PUSH_WINDOW_MS}ms · 连发后含 _hot 的写=${staged - hotWritesBase} 次（0 = 被窗口合并住了）`);
console.log(`合并留痕=${traced.filter((l) => l.includes('hot push coalesced')).length} 行`);

// ── 1&2：一次 complete op 必须把攒着的那份放出去，且内容是当前热表 ────────────────
const beforeComplete = writes.length;
const t0 = Date.now();
await settings.update(NS, {
  _ops: JSON.stringify({ rev: 5, ops: [{ op: 'complete', sessionId: SESSION, draft: '部署到' }] }),
});
await sleep(80);
const yieldedWrites = writes.slice(beforeComplete).filter((w) => w.cells.includes('_hot'));
const newestLanded = yieldedWrites.length
  ? JSON.parse(String(yieldedWrites[yieldedWrites.length - 1].patch._hot)) : null;

run('1) 窗口未到期的 `complete` ⇒ 挂起的热度快照立刻放出去（不等窗口）', () => {
  assert.ok(traced.some((l) => /hot push yielded on input/.test(l)),
    `没有让路留痕：${JSON.stringify(traced.filter((l) => /yielded|coalesced/.test(l)).map((l) => l.slice(0, 70)))}`);
  assert.ok(yieldedWrites.length >= 1,
    `complete 之后没有含 _hot 的写 ⇒ 让路没落地（本条是 #63 的核心判据）；cells=${JSON.stringify(writes.slice(beforeComplete).map((w) => w.cells))}`);
  assert.ok(Math.max(...yieldedWrites.map((w) => w.at - t0)) < HOT_PUSH_WINDOW_MS,
    `让路那一次写晚了 ${Math.max(...yieldedWrites.map((w) => w.at - t0))}ms ≥ 窗口 ⇒ 其实是在等窗口到期，不是让路`);
});

run('2) 放出去的那一份内容必须是**当前**热表（含刚合并掉的那条输入）', () => {
  assert.ok(newestLanded !== null, '没有可比对的落地载荷');
  const texts = [...(newestLanded.hot ?? []).map((e) => e.text), ...(newestLanded.history ?? [])];
  assert.ok(texts.some((t) => String(t).includes('部署到预发环境')),
    `让路带的快照里没有第二回合那条输入（= 提前写了旧的一份）：${JSON.stringify(texts).slice(0, 200)}`);
});

// ── 3：让路不许变成「每次 complete 一次写」 ────────────────────────────────────
const beforeSecond = writes.length;
await settings.update(NS, {
  _ops: JSON.stringify({ rev: 6, ops: [{ op: 'complete', sessionId: SESSION, draft: '部署到预' }] }),
});
await sleep(80);
const secondHot = writes.slice(beforeSecond).filter((w) => w.cells.includes('_hot'));
run('3) 槽里没有攒着时，再来一次 `complete` 不产生任何热度写（按格判重仍然成立）', () => {
  assert.equal(secondHot.length, 0,
    `第二次 complete 又写了 ${secondHot.length} 次 _hot ⇒ 让路退化成了"每键一次写"，窗口白设`);
});

run('4) 窗口常量没被改动（本条修的是让路，不是缩窗口）', () => {
  assert.equal(HOT_PUSH_WINDOW_MS, 1000,
    `HOT_PUSH_WINDOW_MS=${HOT_PUSH_WINDOW_MS} ⇒ 任务书明写"调小窗口是钝器"，改它要另立一条并重新量代价`);
});

// ── 5) 单独造一个「只有热度变、建议格一字未动」的现场再让路 ────────────────────
// 为什么不能拿上面那次 complete 的写来判：那一拍**建议格本来就是脏的**（第二个回合刚产出
// 新建议），带 `_push` 是正确行为。我第一版就是拿它判的，于是把「建议格确实变了」读成了
// 「让路牵连重写了建议格」——假红。正确的现场是 `_ops.add`：只改热表，不碰建议。
// （顺带证实一条既有行为：`add` 之后**没有任何写**发生，热表变化要等下一次推送时机。）
const beforeAdd = writes.length;
await settings.update(NS, {
  _ops: JSON.stringify({ rev: 7, ops: [{ op: 'add', text: '把预发环境的端口改成 4199' }] }),
});
await sleep(60);
const afterAdd = writes.slice(beforeAdd).filter((w) => w.cells.includes('_hot'));
const beforeThird = writes.length;
await settings.update(NS, {
  _ops: JSON.stringify({ rev: 8, ops: [{ op: 'complete', sessionId: SESSION, draft: '把预发' }] }),
});
await sleep(80);
const yieldCells = writes.slice(beforeThird).map((w) => w.cells);
const yieldHotOnly = writes.slice(beforeThird).filter((w) => w.cells === '_hot');
run('5) 只有热度变时让路 ⇒ 那一次写只带 `_hot`，建议格一字不动', () => {
  assert.equal(afterAdd.length, 0,
    `add 之后立刻就写了 ${afterAdd.length} 次 _hot ⇒ 现场没造出来（窗口没在计时）`);
  assert.ok(yieldHotOnly.length >= 1,
    `让路没写出「只带热度格」的写：cells=${JSON.stringify(yieldCells)}`);
  const withPush = writes.slice(beforeThird).filter((w) => w.cells.includes('_push'));
  assert.equal(withPush.length, 0,
    `让路顺带重写了建议格 ${withPush.length} 次（建议格一字未动就不该写）：cells=${JSON.stringify(yieldCells)}`);
  assert.ok(traced.filter((l) => /hot push yielded on input/.test(l)).length >= 2,
    '让路留痕少于 2 行 ⇒ `add` 那条路径（槽是空的、但窗口开着）没被观测到，可观测性缺一半');
});

// ── 6) 判据 ③ 的**前半句**：让路的写次数 ≤ 待写变化数 ─────────────────────────
// 断言 3 只钉住了后半句（「无待写时不写」）。前半句才是这条线的**上界**：
// 写次数由**热度内容的变化数**决定，**不由 `complete` 的次数决定**。
// 口径必须落在内容上而不是字节上：载荷里带 `rev`，每写一次就 +1 ⇒ 拿原始字节比原始字节
// 会永远"不一样"，这个判据会假绿（同一类坑已在 #41 的量度里记过一次，比较前必须剥 rev）。
const stripRev = (raw) => {
  if (typeof raw !== 'string' || raw === '') return null;
  try {
    const box = JSON.parse(raw);
    delete box.rev;
    return JSON.stringify(box);
  } catch {
    return null;
  }
};
const hotWriteInfos = writes
  .map((w) => stripRev(w.patch._hot))
  .filter((x) => x !== null);
const duplicateWrites = hotWriteInfos.filter((x, i) => i > 0 && x === hotWriteInfos[i - 1]).length;
const distinctChanges = hotWriteInfos.reduce((set, x) => set.add(x), new Set()).size;
const yieldCount = traced.filter((l) => /hot push yielded on input/.test(l)).length;
const completeCount = traced.filter((l) => /ops consumed: complete/.test(l)).length;

run('6) 让路的写次数 ≤ 待写变化数（写次数不由 complete 次数决定）', () => {
  assert.ok(completeCount >= 2,
    `本脚本只发了 ${completeCount} 次 complete，不足以判这条上界（判据要有载体，不是空跑）`);
  assert.equal(duplicateWrites, 0,
    `${duplicateWrites} 次写带走了与上一次落盘**相同**的热度内容 ⇒ 让路把写次数和事件数绑了，`
    + `而不是和变化数绑（这正是「每轮多一次写」那个担心的形态）`);
  assert.ok(hotWriteInfos.length <= distinctChanges,
    `含 _hot 的写 ${hotWriteInfos.length} 次 > 热度内容变化 ${distinctChanges} 次 ⇒ 有写没有信息量`);
  assert.ok(yieldCount <= distinctChanges,
    `让路打字 ${yieldCount} 次 > 变化数 ${distinctChanges} ⇒ 让路在重复放同一份快照`);
  realLog(`  ℹ 写次数=${hotWriteInfos.length} · 热度内容变化数=${distinctChanges} · `
    + `complete 次数=${completeCount} · 让路次数=${yieldCount}（写次数由变化数封顶，不由 complete 封顶）`);
});

console.log('\n  ⚪ NOT-COVERED：burst 内**第一次合成的首字符**那 ≤1.5s 切片仍无法由宿主侧消除');
console.log('     原因：会话事件面（@deepseek-ai/dsh-session）没有任何 draft/typing 通道，按键只在浏览器里；');
console.log('     `complete` 已经是宿主可见的最早合成信号。要覆盖那段，只能让客户端在首字符时发信号，');
console.log('     代价是每轮连发多一次写（正是窗口省掉的那一次）⇒ 属另一条产品取舍，不在本条偷偷做。');
console.log('     这条边界同样写在 src/index.ts 的让路注释里，不是事后补的说明。');

console.log = realLog;
if (failed > 0) {
  console.error(`❌ hot-yield-smoke: ${failed} 组失败`);
  process.exit(1);
}
console.log('✅ hot-yield-smoke: 让路生效、带的是当前热表、写次数由变化数封顶、窗口未动、建议格不被牵连');
// 显式退出：apply() 期建的 500ms 补写泵跨 apply 存活（同 payload-split-smoke 那条注释）。
process.exit(0);
