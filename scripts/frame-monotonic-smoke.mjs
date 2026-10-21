#!/usr/bin/env node
/**
 * 帧号单调丢弃冒烟（Gitea #38 第 1 条）。纯函数断言，无 DOM、无宿主。
 *
 * 覆盖四组：
 *  1. **分桶**：`(会话, turn)` 才是「同一次生成」；换会话、换 turn 各开新桶，互不压制。
 *  2. **单调丢弃**：帧号**严格小于**已见值才丢；相等必须放行（会话切回时宿主会把同一份
 *     建议原样重推一次——丢掉它就没有历史环、也没有建议了）。
 *  3. **旧载荷不参与比较**（最容易写反的一条，lead 点名要钉住）：
 *     缺 `frame` 归一化成 0；0 **不登记台账**，所以「旧载荷之后再来 frame=1」必须放行；
 *     反过来「先见过 frame=3，之后来一帧 0」也**不**因此被丢（0 = 不知道在第几帧）。
 *  4. **非法值**：NaN / Infinity / 负数 / 字符串 / 小数 一律落到 0 或向下取整。
 *
 * 运行：`node --experimental-strip-types scripts/frame-monotonic-smoke.mjs`
 */
import assert from 'node:assert/strict';
import {
  emptyFrameLedger,
  frameBucketKey,
  LEGACY_FRAME_HINT,
  observeFrame,
  readFrameHint,
} from '../src/client/accept-guard.ts';

let failed = 0;
const run = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}\n      ${String(error.message).split('\n')[0]}`);
  }
};

// ── 1. 分桶 ────────────────────────────────────────────────────────────────
run('桶键由 (会话, turn) 两维构成，缺维各自落到独立哨兵', () => {
  assert.equal(frameBucketKey('s1', 7), 's1|7');
  assert.notEqual(frameBucketKey('s1', 7), frameBucketKey('s2', 7), '换会话必须换桶');
  assert.notEqual(frameBucketKey('s1', 7), frameBucketKey('s1', 8), '换回合必须换桶');
  assert.equal(frameBucketKey(null, 7), 'no-session|7');
  assert.equal(frameBucketKey(undefined, undefined), 'no-session|no-turn');
});

run('A 会话的高帧号不压制 B 会话的低帧号', () => {
  let ledger = emptyFrameLedger();
  const a = frameBucketKey('sessA', 1);
  const b = frameBucketKey('sessB', 1);
  ledger = observeFrame(ledger, a, 9).ledger;
  const step = observeFrame(ledger, b, 2);
  assert.equal(step.accept, true, '跨会话必须放行');
  assert.equal(step.outcome, 'first');
});

// ── 2. 单调丢弃 ────────────────────────────────────────────────────────────
run('严格小于已见值 → 整条丢弃，并计入 dropped', () => {
  let ledger = emptyFrameLedger();
  const bucket = frameBucketKey('s1', 3);
  const first = observeFrame(ledger, bucket, 2);
  assert.equal(first.accept, true);
  assert.equal(first.outcome, 'first');
  ledger = first.ledger;
  const newer = observeFrame(ledger, bucket, 5);
  assert.equal(newer.accept, true);
  assert.equal(newer.outcome, 'newer');
  ledger = newer.ledger;
  const stale = observeFrame(ledger, bucket, 4);
  assert.equal(stale.accept, false, '帧号 4 < 已见 5 → 陈旧，整条丢');
  assert.equal(stale.outcome, 'older');
  assert.equal(stale.seen, 5, '留痕要能带上已见值');
  assert.equal(stale.ledger.dropped, 1);
  assert.equal(stale.ledger.seen[bucket], 5, '丢弃不得把台账拉回去');
});

run('同帧重发必须放行（切会话后对账 pull 会原样再推一次）', () => {
  let ledger = emptyFrameLedger();
  const bucket = frameBucketKey('s1', 3);
  ledger = observeFrame(ledger, bucket, 1).ledger;
  const replay = observeFrame(ledger, bucket, 1);
  assert.equal(replay.accept, true, '相等不是陈旧；丢了它就没有历史环也没有建议');
  assert.equal(replay.outcome, 'same');
  assert.equal(replay.ledger.dropped, 0);
});

run('1000 帧乱序到达：只接受单调不减的前缀', () => {
  let ledger = emptyFrameLedger();
  const bucket = frameBucketKey('s1', 1);
  let accepted = 0;
  let dropped = 0;
  let maxSeen = 0;
  for (let frame = 1; frame <= 1000; frame += 1) {
    // 故意让一半的帧倒着来（模拟宿主重推/事件乱序）。
    const f = frame % 2 === 0 ? Math.max(1, frame - 30) : frame;
    const step = observeFrame(ledger, bucket, f);
    if (step.accept) { accepted += 1; if (f > maxSeen) maxSeen = f; ledger = step.ledger; }
    else dropped += 1;
    if (!step.accept) assert.ok(f < maxSeen, `被丢的帧 ${f} 必须真的小于已见最大值 ${maxSeen}`);
  }
  assert.ok(dropped > 0, '场景里必须真的出现过陈旧帧');
  assert.equal(ledger.seen[bucket], maxSeen);
});

// ── 3. 旧载荷不参与比较（lead 点名要钉住的方向）────────────────────────────
run('旧载荷（frame 缺省 → 0）：放行，且**不登记**台账', () => {
  const ledger = emptyFrameLedger();
  const bucket = frameBucketKey('s1', 5);
  const legacy = readFrameHint({ text: 'x', turn: 5 });
  assert.deepEqual(legacy, LEGACY_FRAME_HINT);
  const step = observeFrame(ledger, bucket, legacy.frame);
  assert.equal(step.accept, true);
  assert.equal(step.outcome, 'legacy');
  assert.equal(step.ledger.seen[bucket], undefined, '0 进台账就会污染后面的比较');
  assert.equal(step.ledger.dropped, 0);
});

run('旧载荷之后再收到 frame=1 → 必须放行（这条最容易写反）', () => {
  let ledger = emptyFrameLedger();
  const bucket = frameBucketKey('s1', 5);
  ledger = observeFrame(ledger, bucket, 0).ledger;       // 旧宿主推了一帧（无 frame 字段）
  const upgraded = observeFrame(ledger, bucket, 1);      // 宿主升级后从 1 开始出帧
  assert.equal(upgraded.accept, true, '0 不得把后来的 1 判成陈旧');
  assert.equal(upgraded.outcome, 'first', '该桶此前没有有效记录，1 就是首帧');
  assert.equal(upgraded.ledger.seen[bucket], 1);
});

run('先见过 frame=2，再来旧载荷（0）→ 仍然放行，且不把台账拉回', () => {
  let ledger = emptyFrameLedger();
  const bucket = frameBucketKey('s1', 5);
  ledger = observeFrame(ledger, bucket, 2).ledger;
  const step = observeFrame(ledger, bucket, 0);
  assert.equal(step.accept, true, '0 的语义是「不知道在第几帧」，不是「比 2 旧」');
  assert.equal(step.outcome, 'legacy');
  assert.equal(step.ledger.seen[bucket], 2, '台账保持 2：随后的 1 才是真陈旧');
  const after = observeFrame(ledger = step.ledger, bucket, 1);
  assert.equal(after.accept, false, '回到有帧号的一代，1 < 2 应被丢弃');
});

// ── 4. 非法值归一化 ─────────────────────────────────────────────────────────
run('frame 非法值全部落到 0（不参与比较）', () => {
  for (const bad of [undefined, null, NaN, Infinity, -1, 0, '2', true, {}, []]) {
    const hint = readFrameHint({ frame: bad, final: true });
    assert.equal(hint.frame, 0, `frame=${String(bad)} 应归一化为 0`);
  }
  assert.equal(readFrameHint({ frame: 3.7, final: true }).frame, 3, '小数向下取整');
  assert.equal(readFrameHint({ frame: 12, final: true }).frame, 12);
});

run('final 只认显式 false；缺省/null/字符串都算终帧', () => {
  assert.equal(readFrameHint({ frame: 1 }).final, true, '缺 final 字段 = 终帧（旧载荷不变）');
  assert.equal(readFrameHint({ frame: 1, final: false }).final, false);
  assert.equal(readFrameHint({ frame: 1, final: true }).final, true);
  assert.equal(readFrameHint({ frame: 1, final: null }).final, true, '缺字段视为 true');
  assert.equal(readFrameHint({ frame: 1, final: 'false' }).final, true, '非布尔不判为非终帧');
});

run('帧字段打在信封顶层也能读到（suggestion 身上没有时才兜底）', () => {
  const envelope = { frame: 4, final: false };
  assert.deepEqual(readFrameHint({ text: 'x' }, envelope), { frame: 4, final: false });
  // suggestion 自己带字段时以它为准，不被信封覆盖。
  assert.deepEqual(readFrameHint({ frame: 2, final: true }, envelope), { frame: 2, final: true });
});

run('载荷不是对象时退回缺省，不抛', () => {
  for (const bad of [null, undefined, 'x', 7, true]) {
    assert.deepEqual(readFrameHint(bad), LEGACY_FRAME_HINT);
  }
});

process.exit(failed === 0 ? 0 : 1);
