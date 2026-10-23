#!/usr/bin/env node
/**
 * 留痕出口冒烟（客户端 Gitea #39 + 宿主侧 2026-10-23 降噪）。
 *
 * #21 的教训是**每帧刷屏**（一次 40 字符输入打出 1127 行 armed）。所以补留痕只许一种打法：
 * 按理由变化才打。这里钉住两把闸，并用 #21 的现场数字做量化上限：
 *  1. `stepReasonGate`：同一理由连续到达只打第一行；理由归 null 静默并重新开门。
 *  2. `stepTally`：`renderHits` 的归因理由（占大头的来源）变化 **且** 距上次打印已累计
 *     `TALLY_MIN_INTERVAL_RENDERS` 次 render 才打一行——纯计数节流，不用计时器。
 *  3. 隐私：两条出口都只含字符数/计数，**不含正文**。
 *
 * 宿主侧（`stepRepeatTrace`，2026-10-23）钉的是**同一条消息的复读**：live 665 行里
 * `ops consumed: pull` 占 229 行，形态是「每个会话连着 5 条」= 客户端一整个退避阶梯。
 * 这里的判据是「重复变成计数、而不是变成静音」（#17 的口径），并把「闸门关掉就回到
 * 5 行」做成可直接断言的变异（`every=1`），不必改源码来自证。
 *
 * 第三节（`hotAckFields`）钉的是**度量**：落地留痕原来只有 `bytes=`，分不出「2000 条热度
 * 但没带对账凭证」与「什么都没带」，于是 pull 阶梯不收敛的三条成因（B 没带字段 / D·E 判重
 * 吞掉整笔 / F 恢复期扣整格）在日志里同形。补的这两个键必须是**三态**，布尔形态会把
 * 「这一笔不含热度格」伪装成「带了但没有历史」（有专门的变异断言）。
 *
 * 运行：`node scripts/trace-gate-smoke.mjs`
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  dominantRenderSource,
  initialSlotEmitGate,
  initialTallyState,
  OPS_TRACE_PREFIX,
  renderTallyLine,
  stepReasonGate,
  stepSlotEmit,
  stepTally,
  TALLY_MIN_INTERVAL_RENDERS,
  TRACE_SLOT_COOLDOWN_MS,
} from '../src/client/inline-arm-policy.ts';
import {
  hotAckFields,
  initialRepeatTraceGate,
  repeatTraceSuffix,
  stepRepeatTrace,
} from '../src/trace-gate.ts';

/** 宿主侧那个间隔的唯一出处（读源码而不是硬编码，改了常量这里跟着动）。 */
const HOST_SOURCE = readFileSync(fileURLToPath(new URL('../src/index.ts', import.meta.url)), 'utf8');
const PULL_EVERY = Number(/export const PULL_REPEAT_TRACE_EVERY = (\d+);/.exec(HOST_SOURCE)?.[1]);

let failed = 0;
const run = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}\n      ${String(error.message).split('\n')[0]}`);
  }
};

// ── 1. 理由闸 ──────────────────────────────────────────────────────────────
run('同一理由连打 500 次只出 1 行', () => {
  let last = null;
  let printed = 0;
  for (let i = 0; i < 500; i += 1) {
    const step = stepReasonGate(last, 'disabled');
    last = step.last;
    if (step.print) printed += 1;
  }
  assert.equal(printed, 1, `实际打了 ${printed} 行`);
});

run('理由换了才再打一行；来回切换每次变化都算一次', () => {
  let last = null;
  const lines = [];
  for (const reason of ['disabled', 'disabled', 'no-session', 'no-session', 'disabled']) {
    const step = stepReasonGate(last, reason);
    last = step.last;
    if (step.print) lines.push(reason);
  }
  assert.deepEqual(lines, ['disabled', 'no-session', 'disabled']);
});

run('理由归 null 静默，但闸门重新开门（同理由下次还能再打）', () => {
  const a = stepReasonGate('disabled', null);
  assert.equal(a.print, false);
  assert.equal(a.last, null);
  const b = stepReasonGate(a.last, 'disabled');
  assert.equal(b.print, true, '判据重新成立时必须还能留下证据');
});

run('七处补回的分支共用这条闸：各自独立、互不吞掉', () => {
  const slots = {
    'inline-arm-cancel': null, 'tab-abandon': null, 'word-abandon': null,
    'accept-gate-tab': null, 'accept-gate-word': null, 'stale-frame': null, 'form-hold': null,
  };
  const printed = {};
  for (const round of [0, 1, 2]) {
    for (const [slot, reason] of Object.entries(slots)) {
      const step = stepReasonGate(reason, 'x');
      slots[slot] = step.last;
      if (step.print) printed[slot] = (printed[slot] ?? 0) + 1;
    }
  }
  assert.deepEqual(Object.values(printed), [1, 1, 1, 1, 1, 1, 1], '每个槽位只应打一行');
});

// ── 1b. 槽级发射冷却（2026-10-22 补闸：理由闸对「交替」不设防）──────────────
run('冷却：同一时刻 100 次理由交替只出第 1 行', () => {
  let gate = initialSlotEmitGate();
  let printed = 0;
  let last = null;
  for (let i = 0; i < 100; i += 1) {
    const reason = i % 2 === 0 ? 'hot-cell-only' : 'suggestion-cell-changed';
    const step = stepReasonGate(last, reason);
    last = step.last;
    const out = stepSlotEmit(gate, 1000, step.print, reason, ` i=${i}`);
    gate = out.gate;
    if (out.emit !== null) printed += 1;
  }
  assert.equal(printed, 1, `交替 100 次打了 ${printed} 行，应为 1（首行）`);
});

run('冷却结束后 pending 放行：新理由不丢，只迟到', () => {
  const first = stepSlotEmit(initialSlotEmitGate(), 1000, true, 'a', '');
  assert.ok(first.emit !== null, '首次必打（“从未打过”必须是 null 哨兵，不能靠假时钟恰好 ≥5000）');
  let gate = first.gate;
  const cool = stepSlotEmit(gate, 3000, true, 'b', ' x=1');
  gate = cool.gate;
  assert.equal(cool.emit, null, '冷却内不打');
  const after = stepSlotEmit(gate, 6001, true, 'c', '');
  gate = after.gate;
  assert.ok(after.emit !== null, '冷却过后的下一次调用必须放行攒下的');
  assert.equal(after.emit.reason, 'b', '放行的是 pending（b），不是当前理由');
  assert.equal(after.emit.fields, ' x=1', 'pending 的字段成对带出');
  const next = stepSlotEmit(gate, 20000, true, 'c', '');
  assert.ok(next.emit !== null && next.emit.reason === 'c', 'pending 放行后，被压住的当前理由下一拍还能出');
});

run('冷却边界：恰好 5000ms 视为已过；pending 只留最新一份（last-wins）', () => {
  let gate = stepSlotEmit(initialSlotEmitGate(), 0, true, 'first', '').gate;
  gate = stepSlotEmit(gate, 1000, true, 'p1', '1').gate;
  gate = stepSlotEmit(gate, 2000, true, 'p2', '2').gate;
  assert.equal(gate.pendingReason, 'p2', '冷却期内多条 pending 只留最新');
  assert.equal(TRACE_SLOT_COOLDOWN_MS, 5000);
  const atBoundary = stepSlotEmit(gate, 5000, false, 'x', '');
  assert.ok(atBoundary.emit !== null && atBoundary.emit.reason === 'p2', 'now-last === 5000 应判为冷却已过');
});

run('wantsPrint=false 不产生 pending；无 pending 的冷却外调用也静默', () => {
  let gate = stepSlotEmit(initialSlotEmitGate(), 0, true, 'first', '').gate;
  gate = stepSlotEmit(gate, 100, false, 'ignored', '').gate;
  assert.equal(gate.pendingReason, null);
  const out = stepSlotEmit(gate, 9999, false, 'ignored', '');
  assert.equal(out.emit, null, '没有攒下的又没有 print 诉求 ⇒ 静默');
});

// ── 2. tally 归因 ──────────────────────────────────────────────────────────
run('占大头的来源 = 归因理由；平局按固定优先序', () => {
  assert.equal(dominantRenderSource({ session: 0, input: 0, face: 0, other: 0 }), null);
  assert.equal(dominantRenderSource({ session: 3, input: 9, face: 1, other: 0 }), 'input');
  assert.equal(dominantRenderSource({ session: 5, input: 5, face: 0, other: 0 }), 'session', '平局取声明序第一个');
});

run('前 49 次 render 不打；满 50 且理由成立才打第一行', () => {
  let state = initialTallyState();
  const hits = { session: 0, input: 0, face: 0, other: 0 };
  let printed = 0;
  for (let i = 0; i < TALLY_MIN_INTERVAL_RENDERS - 1; i += 1) {
    hits.input += 1;
    const step = stepTally(state, hits);
    state = step.state;
    printed += step.print ? 1 : 0;
  }
  assert.equal(printed, 0, '风暴初期一行都不该打');
  hits.input += 1;
  const last = stepTally(state, hits);
  assert.equal(last.print, true, `第 ${TALLY_MIN_INTERVAL_RENDERS} 次应打出归因行`);
  assert.ok(last.line.startsWith('render tally: dominant=input'), last.line);
});

run('#21 现场回放：1127 次同来源 render 只出 1 行', () => {
  let state = initialTallyState();
  const hits = { session: 0, input: 1127, face: 0, other: 0 };
  let printed = 0;
  // 逐次喂（模拟真实调用节奏），而不是直接看最终值。
  for (let i = 1; i <= 1127; i += 1) {
    const step = stepTally(state, { session: 0, input: i, face: 0, other: 0 });
    state = step.state;
    if (step.print) printed += 1;
  }
  assert.equal(printed, 1, `实际 ${printed} 行——每帧打就是重造 #21`);
});

run('来源切换时才出第二行，且仍受最小间隔约束', () => {
  // 归因理由切换要**同时**满足两件事：主导来源真的换了，且距上次打印攒够最小间隔。
  // 起点做成近乎平局（session 只领先 1 票），这样反超只需 2 次 render，间隔才拦得住。
  let state = initialTallyState();
  const hits = { session: 25, input: 24, face: 1, other: 0 };
  const first = stepTally(state, hits);
  assert.equal(first.print, true, '首行：total 已越过最小间隔');
  assert.ok(first.line.includes('dominant=session'), first.line);
  state = first.state;
  // input 反超 session：理由变了，但只多了 2 次 render → 间隔不足，不许打。
  hits.input += 2;
  const blocked = stepTally(state, hits);
  assert.equal(blocked.print, false, '间隔不足时理由变化也不打');
  assert.equal(blocked.state, state, '被拦住时不得推进间隔基线');
  // 继续由 input 刷到间隔满足 → 出第二行，归因换成 input。
  hits.input += TALLY_MIN_INTERVAL_RENDERS;
  const second = stepTally(state, hits);
  assert.equal(second.print, true, '理由仍是 input 且间隔已攒够');
  assert.ok(second.line.includes('dominant=input'), second.line);
  // 第三行还得再等一个间隔：理由没变时永远静默。
  const third = stepTally(second.state, { ...hits, input: hits.input + 200 });
  assert.equal(third.print, false, '理由未变就一行都不该再打');
});

run('不打印时 stepTally 原样返回状态（不吞掉间隔计数）', () => {
  const state = initialTallyState();
  const step = stepTally(state, { session: 1, input: 0, face: 0, other: 0 });
  assert.equal(step.print, false);
  assert.equal(step.state, state, '必须是同一个对象：间隔从上一次打印算起');
  assert.equal(step.line, '', '不打时不该白白拼字符串');
});

// ── 3. 隐私 ────────────────────────────────────────────────────────────────
run('出口文本只有计数，没有正文', () => {
  const secret = '这是不能进日志的草稿正文';
  const line = renderTallyLine({ session: 1, input: 2, face: 3, other: 4 }, 'face');
  assert.ok(!line.includes(secret));
  assert.ok(/\d/.test(line));
  assert.ok(line.startsWith('render tally: dominant=face'), line);
  assert.ok(OPS_TRACE_PREFIX.startsWith('[dsh-suggest-ghost]'), '前缀必须留在 sandbox.greps 认得的那条上');
});

// ── 4. 宿主侧 `stepRepeatTrace`（2026-10-23：pull 留痕的阶梯复读）─────────────
run('量纲锚点：间隔常量存在、且对得上客户端一整个退避阶梯（1 首发 + 4 重试 = 5）', () => {
  assert.ok(Number.isFinite(PULL_EVERY) && PULL_EVERY > 1, `读不到 PULL_REPEAT_TRACE_EVERY：${String(PULL_EVERY)}`);
  const clientSource = readFileSync(fileURLToPath(new URL('../src/client/index.ts', import.meta.url)), 'utf8');
  const maxAttempts = Number(/const PULL_MAX_ATTEMPTS = (\d+)/.exec(clientSource)?.[1]);
  assert.equal(PULL_EVERY, maxAttempts + 1,
    `间隔应正好落在阶梯尾巴上（阶梯 = 首发 + ${maxAttempts} 次重试 = ${maxAttempts + 1} 条），实际 ${PULL_EVERY}`);
});

run('一个完整阶梯 5 条 ⇒ 只出 2 行（首行 + pulls=5），不是 5 行也不是 1 行', () => {
  let gate = initialRepeatTraceGate();
  const printed = [];
  for (let i = 0; i < PULL_EVERY; i += 1) {
    const step = stepRepeatTrace(gate, 'session-A', PULL_EVERY);
    gate = step.gate;
    if (step.print) printed.push(repeatTraceSuffix('pulls', step.seen, '客户端未确认对账'));
  }
  assert.equal(printed.length, 2, `实际 ${printed.length} 行`);
  assert.equal(printed[0], '', '首行必须逐字是既有形态（sandbox.greps 与三个 harness 按前缀匹配）');
  assert.equal(printed[1], ` [pulls=${PULL_EVERY}：客户端未确认对账]`,
    '重复必须**变成计数出现在报文里**——节流不等于静音（#17 的口径）');
});

run('变异自证：every=1 就是关掉闸门 ⇒ 回到 5 行（证明少打的行是闸压掉的，不是场景没跑到）', () => {
  let gate = initialRepeatTraceGate();
  let printed = 0;
  for (let i = 0; i < PULL_EVERY; i += 1) {
    const step = stepRepeatTrace(gate, 'session-A', 1);
    gate = step.gate;
    printed += step.print ? 1 : 0;
  }
  assert.equal(printed, PULL_EVERY, 'every=1 必须逐条放行（否则上一条的「关掉闸门」对照不成立）');
});

run('key 变化立刻重新开门：换会话必打；代价是交替形态各算首行（已知取舍，钉在这里）', () => {
  let gate = initialRepeatTraceGate();
  const lines = [];
  for (const key of ['A', 'A', 'B', 'B', 'A']) {
    const step = stepRepeatTrace(gate, key, PULL_EVERY);
    gate = step.gate;
    if (step.print) lines.push(`${key}#${step.seen}`);
  }
  assert.deepEqual(lines, ['A#1', 'B#1', 'A#1'],
    '「客户端在问哪个会话」是每件事里唯一的变量，吞掉它就丢了可诊断性');
  // 交替（A,B,A,B,…）不受本闸保护：每次都算首行。这条**不是漏网**，是取舍——
  // 真正的收敛要靠应答确认契约（见 CHANGELOG 的 pull 阶梯条目），不靠在这里再关一道。
  let alternating = initialRepeatTraceGate();
  let printed = 0;
  for (let i = 0; i < 40; i += 1) {
    const step = stepRepeatTrace(alternating, i % 2 === 0 ? 'A' : 'B', PULL_EVERY);
    alternating = step.gate;
    printed += step.print ? 1 : 0;
  }
  assert.equal(printed, 40, '交替形态必须**照打**：这条限制要显式钉住，不许悄悄放宽');
});

run('229 行现场回放：18 个会话 × 阶梯，压到一半以内（连续阶梯形态）', () => {
  const ladders = 46; // live 实测：229 条 pull ≈ 46 个阶梯（每阶梯 5 条）
  let gate = initialRepeatTraceGate();
  let printed = 0;
  for (let l = 0; l < ladders; l += 1) {
    const session = `session-${l % 18}`;
    for (let i = 0; i < PULL_EVERY; i += 1) {
      const step = stepRepeatTrace(gate, session, PULL_EVERY);
      gate = step.gate;
      printed += step.print ? 1 : 0;
    }
  }
  const raw = ladders * PULL_EVERY;
  assert.ok(printed <= Math.ceil(raw / 2), `${raw} 条只该压到 ≤${Math.ceil(raw / 2)}，实际 ${printed} 行`);
  assert.ok(printed >= ladders, `每个会话的首行都不许吞（要证明「开始对账了」），实际 ${printed}`);
});

run('静态：pull 留痕字面串在宿主源码里只许出现一处（注释里复读会把 indexOf 锚点引偏）', () => {
  // 依据：`hot-throttle-smoke` 用 `hostSource.indexOf('ops consumed: pull')` 找应答让路
  // 那段代码。注释里多一处同串，锚点就落在注释上 ⇒ 判据空转（假绿）。
  const occurrences = HOST_SOURCE.match(/ops consumed: pull/g) ?? [];
  assert.equal(occurrences.length, 1, `字面串出现 ${occurrences.length} 次，应为 1 次（只有 traceOps 调用点）`);
});

// ── 5. 宿主侧 `hotAckFields`：落地那一格带没带对账凭证（2026-10-23）─────────────
const hotJson = (o) => JSON.stringify({ rev: 7, hot: [{ text: 'x', count: 1 }], total: 2000, ...o });

run('三态齐全：1=带凭证 / 0=这格写出去但没带 / -=这一笔不含热度格', () => {
  assert.equal(hotAckFields(hotJson({ history: ['我重新'], historySessionId: 'session-A' })),
    ' hasHistory=1 ackSession=session-A');
  // 场景 E 的正身：空数组同样是**可以确认**的应答（客户端判据是 Array.isArray）。
  assert.equal(hotAckFields(hotJson({ history: [], historySessionId: 'session-A' })),
    ' hasHistory=1 ackSession=session-A', '空环被判成没带 ⇒ B/D/E/F 的统计当场失真');
  // 场景 B 的正身：会话解析不到时 `buildHotPayload` 把两个键一起省略。
  assert.equal(hotAckFields(hotJson({})), ' hasHistory=0 ackSession=-');
  assert.equal(hotAckFields(null), ' hasHistory=- ackSession=-');
});

run('读的是落盘字节：正文里出现 "history":[ 也不会被误判成带凭证', () => {
  const withEscaped = JSON.stringify({ hot: [{ text: '假键 "history":[ 混在里面', count: 1 }], total: 1 });
  assert.equal(hotAckFields(withEscaped), ' hasHistory=0 ackSession=-',
    '键位匹配靠 JSON 转义把正文里的引号变成 \\"；命中正文就是读错了字节');
  const spoofAck = JSON.stringify({ total: 1, note: '"historySessionId":"fake"' });
  assert.equal(hotAckFields(spoofAck), ' hasHistory=0 ackSession=-',
    '正文伪造 ackSession 必须命不中（否则统计能被内容污染）');
});

run('变异自证：把 hasHistory 写成布尔，"这一笔不含热度格"就伪装成"带了但没历史"', () => {
  const asBoolean = (p) => (p !== null && /"history":\[/.test(p) ? ' hasHistory=1' : ' hasHistory=0');
  assert.equal(asBoolean(null), ' hasHistory=0', '布尔形态把 - 吞成了 0，三态塌成两态');
  assert.notEqual(hotAckFields(null), asBoolean(null), '真实现必须与布尔退化形态不同');
});

process.exit(failed === 0 ? 0 : 1);
