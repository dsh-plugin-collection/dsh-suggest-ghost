#!/usr/bin/env node
/**
 * 旧载荷兜底冒烟（Gitea #38 的兼容面）：`resolvePayloadFrames` 吃「没有 frame/final 的
 * `_push`」时，结论必须与 #38 之前**逐字一致**——不丢帧、不改采纳、不引入新终态。
 *
 * 本期宿主对一次生成只出**一个终帧**（`final: true`），所以这份兜底不是「将来才用得上」
 * 的边角，而是**今天线上唯一的形态**：宿主那三条分支还没合并之前，客户端吃的全部是旧载荷。
 *
 * 运行：`node --experimental-strip-types scripts/legacy-payload-smoke.mjs`
 */
import assert from 'node:assert/strict';
import {
  emptyFrameLedger,
  gateAccept,
  LEGACY_FRAME_HINT,
  readFrameHint,
  resolvePayloadFrames,
} from '../src/client/accept-guard.ts';

let failed = 0;
const run = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}\n      ${String(error.message).split('\n')[0]}`);
  }
};

/** 宿主线上真实形状（0.6.0 的 `_push`：suggestion 无帧字段）。 */
const legacyPushed = (over = {}) => ({
  suggestion: { version: 1, turn: 12, baseSeq: 99, text: '把构建脚本改一下', truncated: false, acceptKey: 'Tab' },
  suggestionSessionId: 'sess-1',
  hot: [{ text: '把构建脚本改一下', count: 3 }],
  history: ['帮我看一下这个插件', '把构建脚本改一下'],
  historySessionId: 'sess-1',
  ...over,
});

const resolve = (pushed, ledger = emptyFrameLedger(), prev = LEGACY_FRAME_HINT) =>
  resolvePayloadFrames({ ledger, pushed, prevCompletionFrame: prev });

// ── 1. 建议：旧载荷永不被丢弃 ──────────────────────────────────────────────
run('线上现状：无 frame/final 的 suggestion → accept，outcome=legacy', () => {
  const out = resolve(legacyPushed());
  assert.equal(out.accept, true);
  assert.equal(out.outcome, 'legacy');
  assert.deepEqual(out.suggestionFrame, LEGACY_FRAME_HINT);
  assert.equal(out.ledger.dropped, 0);
  assert.equal(Object.keys(out.ledger.seen).length, 0, '旧载荷不得登记台账');
});

run('连推 500 条旧载荷：全部接受，一条不丢', () => {
  let ledger = emptyFrameLedger();
  for (let i = 0; i < 500; i += 1) {
    const out = resolve(legacyPushed({ suggestion: { turn: i % 7 } }), ledger);
    assert.equal(out.accept, true, `第 ${i} 条旧载荷被丢了`);
    ledger = out.ledger;
  }
  assert.equal(ledger.dropped, 0);
});

run('同一份旧载荷重发（对账 pull 场景）：仍然接受', () => {
  const a = resolve(legacyPushed());
  const b = resolve(legacyPushed(), a.ledger);
  assert.equal(b.accept, true);
  assert.equal(b.outcome, 'legacy');
});

// ── 2. 建议缺失 / 作废 ─────────────────────────────────────────────────────
run('suggestion 省略或 null → outcome=absent，accept=true，帧提示回缺省', () => {
  for (const pushed of [legacyPushed({ suggestion: null }), legacyPushed({ suggestion: undefined })]) {
    const out = resolve(pushed);
    assert.equal(out.accept, true);
    assert.equal(out.outcome, 'absent');
    assert.equal(out.bucket, null);
    assert.deepEqual(out.suggestionFrame, LEGACY_FRAME_HINT);
  }
});

run('整条 _push 不存在（revision 只动了别的字段）→ 一切照旧', () => {
  for (const pushed of [null, undefined]) {
    const out = resolve(pushed);
    assert.equal(out.accept, true);
    assert.equal(out.outcome, 'absent');
    assert.deepEqual(out.completionFrame, LEGACY_FRAME_HINT, '没有载荷就没有终态证据 → 缺省');
  }
});

// ── 3. 续写：省略=保留现值 / 显式 null=归回缺省 ────────────────────────────
run('completion 省略 → 保留上一帧的 completionFrame（与 completion 本体同款语义）', () => {
  const prev = { frame: 0, final: false };
  const out = resolve(legacyPushed({ completion: undefined }), emptyFrameLedger(), prev);
  assert.equal(out.completionFrame, prev, '必须是同一个引用：省略即保留');
});

run('completion 显式 null（切会话/回合结束作废）→ 帧提示归回缺省', () => {
  const out = resolve(legacyPushed({ completion: null }), emptyFrameLedger(), { frame: 0, final: false });
  assert.deepEqual(out.completionFrame, LEGACY_FRAME_HINT);
});

run('completion 带 final:true（宿主本期会带上）→ inline 采纳照常', () => {
  const out = resolve(legacyPushed({ completion: { draft: '帮我看一下', text: '构建流程', final: true } }));
  assert.equal(out.completionFrame.final, true);
  assert.equal(out.completionFrame.frame, 0, '本期续写没有帧号，不得借到 suggestion 的帧号');
  assert.equal(gateAccept(out.completionFrame).allow, true);
});

run('completion 带 final:false → inline 采纳被拒（#38 的 inline 判据只认这一条）', () => {
  const out = resolve(legacyPushed({ completion: { draft: '帮我看一下', text: '构建流程', final: false } }));
  assert.equal(gateAccept(out.completionFrame).allow, false);
  assert.equal(gateAccept(out.completionFrame).reason, 'provisional-frame');
});

run('信封顶层的 frame 不会被 inline 借用（两个对象同时在场时互不污染）', () => {
  const out = resolve(legacyPushed({
    frame: 9, final: false,
    completion: { draft: 'x', text: 'y' },
  }));
  assert.equal(out.suggestionFrame.frame, 9, 'suggestion 身上没有帧字段时才兜底读信封');
  assert.deepEqual(out.completionFrame, LEGACY_FRAME_HINT, 'completion 只认自己身上的字段');
});

// ── 4. 与「有帧号的一代」的接缝 ────────────────────────────────────────────
run('旧载荷（0）之后再收 frame=1 → 放行（宿主升级的那一拍不能掉建议）', () => {
  const legacy = resolve(legacyPushed());
  const upgraded = resolve(legacyPushed({ suggestion: { turn: 12, frame: 1, final: true } }), legacy.ledger);
  assert.equal(upgraded.accept, true);
  assert.equal(upgraded.outcome, 'first');
  assert.equal(upgraded.ledger.seen['sess-1|12'], 1);
});

run('有帧号的一代退回旧载荷（例如宿主回滚）→ 仍然放行', () => {
  const withFrame = resolve(legacyPushed({ suggestion: { turn: 12, frame: 4, final: true } }));
  const back = resolve(legacyPushed(), withFrame.ledger);
  assert.equal(back.accept, true, '旧载荷不参与帧序比较，不能被 4 判成陈旧');
  assert.equal(back.outcome, 'legacy');
});

run('兜底路径下 readFrameHint 与 resolvePayloadFrames 结论一致', () => {
  const payloads = [
    { text: 'x' },
    { text: 'x', frame: undefined, final: undefined },
    { text: 'x', frame: 0, final: true },
    { text: 'x', frame: 2, final: true },
    { text: 'x', frame: 2, final: false },
  ];
  for (const payload of payloads) {
    const direct = readFrameHint(payload);
    const viaResolve = resolve({ suggestion: payload, suggestionSessionId: 's' }).suggestionFrame;
    assert.deepEqual(viaResolve, direct, `载荷 ${JSON.stringify(payload)} 两条路径结论不同`);
  }
});

process.exit(failed === 0 ? 0 : 1);
