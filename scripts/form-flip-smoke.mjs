#!/usr/bin/env node
/**
 * 幽灵形态在单次生成内不得翻转冒烟（Gitea #38 第 4 条）。
 *
 * 现场：`alignCompletion` 的裁空一支（`completion-align.ts:87`）返回 `ok:false`，
 * 而 `computeGhostContent` 的分支顺序是「续写 → 历史补全 → LLM 建议」，于是这一帧
 * 会往下落，形态从 `inline` 掉到 `history`。
 *
 * 判据的证据是 `alignCompletion` 的**归属前缀**关系（#33「边打边等」的主路径），
 * **不是**草稿逐字相同——所以本冒烟必须同时钉住：
 *  1. 裁空 → 不许回落 history（宁可不显示）；
 *  2. 草稿继续变长（对齐仍成立）→ 该显示照显示，不许被形态判据误伤；
 *  3. 这次生成一结束（改中间 / 删字 / 清空 / 换会话 / 空文本 / 无载荷 / 开关关闭）
 *     → history 立刻回来，不留「再也不出补全」的死区。
 *
 * 运行：`node --experimental-strip-types scripts/form-flip-smoke.mjs`
 */
import assert from 'node:assert/strict';
import { alignCompletion, decideInlineForm } from '../src/client/completion-align.ts';

let failed = 0;
const run = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}\n      ${String(error.message).split('\n')[0]}`);
  }
};

/** 由「当前草稿 + 载荷 + align 结果」拼出判据入参（与 index.ts 的接法逐字同构）。 */
function frameOf(draft, payload, sessionId = 's1', currentId = 's1', inlineEnabled = true) {
  const belongs = payload !== null && payload !== undefined && sessionId === currentId;
  const aligned = !belongs ? null : alignCompletion(draft, payload.draft, payload.text);
  return decideInlineForm({
    inlineEnabled,
    draft,
    payload,
    payloadBelongsToCurrentSession: belongs,
    alignedOk: aligned !== null && aligned.ok,
    alignedReason: aligned === null || aligned.ok ? null : aligned.reason,
  });
}

const P = { draft: '帮我看一下', text: '这个插件的构建流程' };

// ── 1. 裁空：同一次生成内不许从 inline 掉到 history ────────────────────────
run('把整段续写一个字一个字打完：最后一帧被扣住，不许换成 history', () => {
  const consumed = '帮我看一下这个插件的构建流程';   // 用户把续写全打出来了
  const aligned = alignCompletion(consumed, P.draft, P.text);
  assert.equal(aligned.ok, false, 'align 的这一步确实返回裁空（不是错误）');
  assert.equal(aligned.reason, 'empty-text');
  const verdict = frameOf(consumed, P);
  assert.equal(verdict.hold, 'inline-consumed', '必须扣住');
  assert.equal(verdict.allowHistory, false, '扣住 = 本帧不显示，而不是换成历史补全');
  assert.equal(verdict.showInline, false);
});

run('打完续写又补一个不相干的字：仍属同一次生成，仍然扣住', () => {
  const verdict = frameOf('帮我看一下这个插件的构建流程X', P);
  assert.equal(verdict.hold, 'inline-consumed');
});

run('扣住是逐帧成立的判据（无内部状态），重复调用不会自己松开', () => {
  for (let i = 0; i < 200; i += 1) {
    assert.equal(frameOf('帮我看一下这个插件的构建流程', P).allowHistory, false);
  }
});

// ── 2. #33 主路径不被误伤：草稿继续变长时该显示就显示 ──────────────────────
run('边打边等（草稿比载荷长且未打完）：inline 照显示，判据不许掺和', () => {
  const verdict = frameOf('帮我看一下这个插件', P);
  assert.equal(verdict.showInline, true);
  assert.equal(verdict.hold, null);
});

run('载荷未变、草稿逐字相同：inline 照显示（exact 分支）', () => {
  const verdict = frameOf('帮我看一下', P);
  assert.equal(verdict.showInline, true);
});

run('续写开头已被打出一部分：显示裁过的尾巴，形态仍是 inline', () => {
  const verdict = frameOf('帮我看一下这个插件', { draft: '帮我看一下', text: '这个插件的构建流程' });
  assert.equal(verdict.showInline, true);
  const aligned = alignCompletion('帮我看一下这个插件', '帮我看一下', '这个插件的构建流程');
  assert.equal(aligned.ok, true);
  assert.equal(aligned.suffix, '的构建流程', '重合部分被裁掉（尾巴变短不是翻转）');
});

// ── 3. 这次生成一结束，历史补全立刻回来（不留死区）──────────────────────────
run('改了草稿中间：载荷不再拥有这份草稿 → history 可用', () => {
  const verdict = frameOf('帮我看**一下', P);
  assert.equal(verdict.hold, null);
  assert.equal(verdict.allowHistory, true);
});

run('删掉了末尾的字：同样判为「这次生成结束」→ history 可用', () => {
  const verdict = frameOf('帮我看', P);
  assert.equal(verdict.hold, null);
  assert.equal(verdict.allowHistory, true);
});

run('草稿清空：不是「边打边等」的形态 → 不扣（此时该出 LLM 建议）', () => {
  assert.equal(frameOf('', P).hold, null);
  assert.equal(frameOf('   ', P).hold, null);
});

run('载荷属于别的会话：本次生成本来就不归本会话管 → history 可用', () => {
  const verdict = frameOf('帮我看一下这个插件的构建流程', P, 's2', 's1');
  assert.equal(verdict.hold, null);
  assert.equal(verdict.allowHistory, true);
});

run('宿主推了空续写（text=""）：这不是一次生成，没有形态可保护', () => {
  const verdict = frameOf('帮我看一下', { draft: '帮我看一下', text: '' });
  assert.equal(verdict.hold, null);
  assert.equal(verdict.allowHistory, true, '空文本对齐也会给 empty-text，必须区分开');
});

run('续写开关关闭：判据整体退出，不产生任何扣留', () => {
  const verdict = frameOf('帮我看一下这个插件的构建流程', P, 's1', 's1', false);
  assert.equal(verdict.hold, null);
  assert.equal(verdict.allowHistory, true);
});

run('无载荷（宿主还没推续写）：与 #38 之前逐字一致', () => {
  for (const payload of [null, undefined]) {
    const verdict = frameOf('帮我看一下这个插件的构建流程', payload);
    assert.equal(verdict.hold, null);
    assert.equal(verdict.allowHistory, true);
  }
});

// ── 4. 一次真实的「边打边等 → 打完」序列 ───────────────────────────────────
run('打字序列回放：形态只在 inline 上成长，扣住时不切换，生成结束后才交回 history', () => {
  const typed = [
    '帮我看一下',
    '帮我看一下这',
    '帮我看一下这个插件',
    '帮我看一下这个插件的构建流',
    '帮我看一下这个插件的构建流程',        // 打完 → 扣住
    '帮我看一下这个插件的构建流程！',      // 仍拥有 → 继续扣住
  ];
  const seen = typed.map((draft) => {
    const v = frameOf(draft, P);
    return v.showInline ? 'inline' : (v.hold !== null ? 'held' : 'fallback');
  });
  assert.deepEqual(seen, ['inline', 'inline', 'inline', 'inline', 'held', 'held'],
    `实际形态序列：${seen.join(' → ')}`);
  // 用户接着把句子改成「不相干的一句」（载荷不再拥有）→ 这次生成结束，history 回来。
  assert.equal(frameOf('今天天气不错', P).allowHistory, true);
});

run('载荷被宿主作废（completion:null）后，同一份草稿立刻可显示 history', () => {
  assert.equal(frameOf('帮我看一下这个插件的构建流程', P).hold, 'inline-consumed');
  const afterVoid = frameOf('帮我看一下这个插件的构建流程', null);
  assert.equal(afterVoid.hold, null);
  assert.equal(afterVoid.allowHistory, true);
});

process.exit(failed === 0 ? 0 : 1);
