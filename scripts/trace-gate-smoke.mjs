#!/usr/bin/env node
/**
 * 客户端留痕出口冒烟（Gitea #39）。
 *
 * #21 的教训是**每帧刷屏**（一次 40 字符输入打出 1127 行 armed）。所以补留痕只许一种打法：
 * 按理由变化才打。这里钉住两把闸，并用 #21 的现场数字做量化上限：
 *  1. `stepReasonGate`：同一理由连续到达只打第一行；理由归 null 静默并重新开门。
 *  2. `stepTally`：`renderHits` 的归因理由（占大头的来源）变化 **且** 距上次打印已累计
 *     `TALLY_MIN_INTERVAL_RENDERS` 次 render 才打一行——纯计数节流，不用计时器。
 *  3. 隐私：两条出口都只含字符数/计数，**不含正文**。
 *
 * 运行：`node scripts/trace-gate-smoke.mjs`
 */
import assert from 'node:assert/strict';
import {
  dominantRenderSource,
  initialTallyState,
  OPS_TRACE_PREFIX,
  renderTallyLine,
  stepReasonGate,
  stepTally,
  TALLY_MIN_INTERVAL_RENDERS,
} from '../src/client/inline-arm-policy.ts';

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

process.exit(failed === 0 ? 0 : 1);
