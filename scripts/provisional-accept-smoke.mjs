#!/usr/bin/env node
/**
 * provisional 帧不得被采纳冒烟（Gitea #38 第 1 条的采纳链部分）。
 *
 * 要钉住的是「判据落在哪、拦住什么」：
 *  1. `final === false` 时，Tab 整条与 `→` 逐词**都不写任何字符**（幽灵照旧不动）；
 *  2. 缺 `final` / `final === true` 时，采纳链与 #38 之前**逐字一致**——用旧实现的
 *     字面拷贝当回归预言（oracle）做等价比对（仿 `accept-cas-smoke.mjs` 的写法）；
 *  3. 采纳闸与草稿 CAS 是**串联**关系：帧闸在前、CAS 在后，两道都过才写字；
 *  4. 帧闸对 `llm` / `inline` / `history` 三种形态一视同仁（history 是本地候选，恒终帧）。
 *
 * 运行：`node --experimental-strip-types scripts/provisional-accept-smoke.mjs`
 */
import assert from 'node:assert/strict';
import {
  acceptTarget,
  buildFullAccept,
  buildWordAccept,
  commitDraftIfPristine,
  gateAccept,
  LEGACY_FRAME_HINT,
  readDraftSnapshot,
  wordAcceptSettled,
  wordMatchBase,
} from '../src/client/accept-guard.ts';
import { nextAcceptChunk } from '../src/client/chunk.ts';
import { stripCommandPrefix } from '../src/client/history.ts';

let failed = 0;
const run = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}\n      ${String(error.message).split('\n')[0]}`);
  }
};

// ── 假输入机 face（与 accept-cas-smoke.mjs 同款形态）───────────────────────
function makeFace(initialDraft) {
  let rev = 11;
  let snapshot = { draft: initialDraft, draftRev: rev };
  const wrote = [];
  return {
    wrote,
    state: { getSnapshot: () => snapshot, subscribe: () => () => {} },
    setDraft: (text) => { wrote.push(text); snapshot = { draft: text, draftRev: ++rev }; },
    type: (chars) => { snapshot = { draft: snapshot.draft + chars, draftRev: ++rev }; },
  };
}

/**
 * 新采纳链（Tab 整条）：帧闸 → 计算目标 → CAS → 写字。
 * @returns 本次是否真的写了草稿，以及写的是什么。
 */
function acceptFullWithGate(face, content, frame, action) {
  const gate = gateAccept(frame);
  if (!gate.allow) return { written: null, consumed: false, gate: gate.reason };
  const base = readDraftSnapshot(face.state.getSnapshot());
  const accepted = buildFullAccept(content, base.draft);
  const outcome = commitDraftIfPristine(base, readDraftSnapshot(face.state.getSnapshot()), () => {
    face.setDraft(accepted);
  });
  return { written: outcome.committed ? accepted : null, consumed: true, gate: 'allow', outcome };
}

/**
 * 旧采纳链（#38 之前 index.ts:onKeyDown 的字面拷贝，无帧闸）——回归预言。
 */
function acceptFullLegacy(face, content) {
  const base = readDraftSnapshot(face.state.getSnapshot());
  const accepted = buildFullAccept(content, base.draft);
  const outcome = commitDraftIfPristine(base, readDraftSnapshot(face.state.getSnapshot()), () => {
    face.setDraft(accepted);
  });
  return { written: outcome.committed ? accepted : null, consumed: true };
}

/** 逐词采纳（`→`）新链：同样先过帧闸。 */
function acceptWordWithGate(face, content, frame) {
  const gate = gateAccept(frame);
  if (!gate.allow) return { written: null, consumed: false, gate: gate.reason };
  const base = readDraftSnapshot(face.state.getSnapshot());
  const full = acceptTarget(content);
  const matchBase = wordMatchBase(content, base.draft);
  if (!full.startsWith(matchBase) || matchBase.length >= full.length) return { written: null, consumed: false, gate: 'no-chunk' };
  const chunk = nextAcceptChunk(full.slice(matchBase.length));
  if (chunk === '') return { written: null, consumed: false, gate: 'no-chunk' };
  const accepted = buildWordAccept(content, base.draft, matchBase, chunk);
  const outcome = commitDraftIfPristine(base, readDraftSnapshot(face.state.getSnapshot()), () => {
    face.setDraft(accepted);
  });
  return { written: outcome.committed ? accepted : null, consumed: true, settled: wordAcceptSettled(content, accepted) };
}

const PROVISIONAL = { frame: 1, final: false };
const FINAL = { frame: 1, final: true };

const LLM = { kind: 'llm', text: '帮我重新部署一下这个服务', acceptKey: 'Tab' };
const INLINE = { kind: 'inline', prefix: '帮我看一下', suffix: '这个插件的构建流程', full: '帮我看一下这个插件的构建流程' };
const HISTORY = { kind: 'history', prefix: '/later +3m 我', suffix: '重新部署了服务', full: '我重新部署了服务' };

// ── 1. provisional 帧：两条采纳链都拦，且不写任何字符 ──────────────────────
for (const [label, content, draft] of [
  ['llm', LLM, ''],
  ['inline', INLINE, '帮我看一下'],
  ['history', HISTORY, '/later +3m 我'],
]) {
  run(`${label}：Tab 在 provisional 帧上直接放弃（一个字符都不写）`, () => {
    const face = makeFace(draft);
    const result = acceptFullWithGate(face, content, PROVISIONAL, 'tab');
    assert.equal(result.written, null);
    assert.equal(result.consumed, false, '不吞按键：Tab 回到浏览器原生行为');
    assert.equal(result.gate, 'provisional-frame');
    assert.deepEqual(face.wrote, [], 'provisional 帧不得有任何 setDraft');
    assert.equal(readDraftSnapshot(face.state.getSnapshot()).draft, draft, '草稿原样不动');
  });

  run(`${label}：→ 逐词在 provisional 帧上同样放弃`, () => {
    const face = makeFace(draft);
    const result = acceptWordWithGate(face, content, PROVISIONAL);
    assert.equal(result.written, null);
    assert.equal(result.consumed, false, '不吞按键：光标照常移动');
    assert.deepEqual(face.wrote, []);
  });

  run(`${label}：同一份内容改成终帧后照常采纳（帧闸不是永久闸）`, () => {
    const face = makeFace(draft);
    const result = acceptFullWithGate(face, content, FINAL, 'tab');
    assert.equal(result.written, acceptFullLegacy(makeFace(draft), content).written);
  });
}

// ── 2. 帧闸与 CAS 的串联关系 ───────────────────────────────────────────────
run('帧闸在 CAS **之前**：provisional 时连 CAS 都不必跑（不读第二次快照）', () => {
  let reads = 0;
  const face = {
    wrote: [],
    state: { getSnapshot: () => { reads += 1; return { draft: '帮我看一下', draftRev: 3 }; }, subscribe: () => () => {} },
    setDraft: (text) => { face.wrote.push(text); },
  };
  acceptFullWithGate(face, INLINE, PROVISIONAL, 'tab');
  assert.equal(reads, 0, '帧闸拒绝时不该再碰输入机');
  assert.deepEqual(face.wrote, []);
});

run('终帧 + 草稿被改：CAS 仍然拦住（两道判据互不替代）', () => {
  const face = makeFace('帮我看一下');
  // 计算基线之后、写入之前插一次用户键击——用 face 直接模拟（同 accept-cas-smoke）。
  const base = readDraftSnapshot(face.state.getSnapshot());
  face.type('X');
  const outcome = commitDraftIfPristine(base, readDraftSnapshot(face.state.getSnapshot()), () => {
    face.setDraft(buildFullAccept(INLINE, base.draft));
  });
  assert.equal(outcome.committed, false);
  assert.equal(outcome.reason, 'draft-changed');
});

// ── 3. 缺省兜底：旧载荷行为逐字不变 ────────────────────────────────────────
run('LEGACY_FRAME_HINT 放行采纳', () => {
  assert.equal(gateAccept(LEGACY_FRAME_HINT).allow, true);
  assert.equal(gateAccept(undefined).allow, true, '连帧提示都没读到也放行');
  assert.equal(gateAccept(null).allow, true);
  assert.equal(gateAccept({ frame: 0, final: true }).allow, true);
});

run('旧载荷（无 frame/final）下新链与旧链逐字符等价', () => {
  const cases = [
    [LLM, ''],
    [LLM, '已有草稿'],
    [INLINE, '帮我看一下'],
    [HISTORY, '/later +3m 我'],
    [HISTORY, '普通草稿'],
  ];
  for (const [content, draft] of cases) {
    const legacy = acceptFullLegacy(makeFace(draft), content);
    // 旧载荷的帧提示由 readFrameHint 兜底成 LEGACY_FRAME_HINT（见 frame-monotonic-smoke）。
    const gated = acceptFullWithGate(makeFace(draft), content, LEGACY_FRAME_HINT, 'tab');
    assert.equal(gated.written, legacy.written, `${content.kind}/${draft} 结果必须逐字符相同`);
    assert.equal(gated.consumed, legacy.consumed);
  }
});

run('斜杠命令整行在 provisional 帧上同样不许破坏命令意图', () => {
  const face = makeFace('/later +3m 我');
  acceptFullWithGate(face, HISTORY, PROVISIONAL, 'tab');
  assert.deepEqual(face.wrote, []);
  // 对照：终帧时命令前缀必须回填（与 accept-cas-smoke 的预言一致）。
  const ok = acceptFullWithGate(makeFace('/later +3m 我'), HISTORY, FINAL, 'tab');
  assert.ok(ok.written.startsWith('/later +3m '), `命令前缀段必须保留，实际 ${String(ok.written)}`);
  assert.equal(stripCommandPrefix('/later +3m 我'), '我');
});

process.exit(failed === 0 ? 0 : 1);
