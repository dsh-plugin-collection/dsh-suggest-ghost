#!/usr/bin/env node
/**
 * overlay「同一次生成的文本增长」快路径冒烟（Gitea #38 第 2 条）。
 *
 * 判据本体是无 DOM 纯函数（`inline-arm-policy.ts` 末段），这里另附一份**强制同步布局
 * 次数的模型**：把「全量 / 快路径」各自每帧付几次 rect 测量算出来对比——这条快路径买到的
 * 就是这个数字，不是感觉。
 *
 * 同时钉住两条既有硬约束（不许被快路径破坏）：
 *  - 自检失败（`painted=false`）时**必须**走全量，快路径不得在没画出来的节点上只改文本；
 *  - 快路径不写 `display` / `data-shown`——由「只有 painted 才进快路径」这条前提保证，
 *    本冒烟用 `painted=false` 的一组断言把门守住。
 *
 * 运行：`node scripts/overlay-growth-smoke.mjs`
 */
import assert from 'node:assert/strict';
import {
  anchorMeasurable,
  anchorMovedBeyond,
  ANCHOR_REDRAW_TOLERANCE_PX,
  decideOverlayPaint,
  isSameGenerationGrowth,
  shouldSkipDeferredRepaint,
} from '../src/client/inline-arm-policy.ts';

let failed = 0;
const run = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}\n      ${String(error.message).split('\n')[0]}`);
  }
};

const shape = (over = {}) => ({ kind: 'inline', anchorText: '帮我看一下', suffixText: '这个插件', ...over });

// ── 1. 「同一次生成的文本增长」的识别 ──────────────────────────────────────
run('尾巴变长 = 增长；尾巴换内容 = 不是增长', () => {
  assert.equal(isSameGenerationGrowth(shape(), shape({ suffixText: '这个插件的构建流程' })), true);
  assert.equal(isSameGenerationGrowth(shape(), shape({ suffixText: '一段不相干的建议' })), false);
  assert.equal(isSameGenerationGrowth(shape(), shape({ suffixText: '这个' })), false, '变短不是增长（那是新一次生成）');
  assert.equal(isSameGenerationGrowth(shape(), shape({ suffixText: '这个插件' })), true, '等长也算同代，只是没变化');
});

run('换形态 / 换锚定文本 / 首帧 都不是增长', () => {
  assert.equal(isSameGenerationGrowth(null, shape()), false);
  assert.equal(isSameGenerationGrowth(shape({ kind: 'llm' }), shape({ kind: 'inline' })), false);
  assert.equal(isSameGenerationGrowth(shape({ anchorText: '帮我看' }), shape({ anchorText: '帮我看一下' })), false,
    '草稿变了 → 尾巴的起点变了，锚点必须重测');
});

// ── 2. 绘制动作裁决 ────────────────────────────────────────────────────────
run('未绘制（首帧 / 自检被拦 / 刚 hide）一律全量：顺序约束不许被绕开', () => {
  for (const painted of [false]) {
    assert.equal(decideOverlayPaint({ prev: shape(), next: shape({ suffixText: '这个插件的构建流程' }), painted, anchorDirty: false }),
      'rebuild', 'painted=false 时绝不能走快路径');
  }
});

run('已绘制 + 锚点未脏 → grow-only：一次测量都不做', () => {
  assert.equal(decideOverlayPaint({ prev: shape(), next: shape({ suffixText: '这个插件的构建流程' }), painted: true, anchorDirty: false }),
    'grow-only');
});

run('已绘制 + 锚点脏 + 非 llm → grow-remeasure（只量一次行尾，不重排）', () => {
  assert.equal(decideOverlayPaint({ prev: shape(), next: shape({ suffixText: '这个插件的构建流程' }), painted: true, anchorDirty: true }),
    'grow-remeasure');
});

run('llm 形态没有行尾可量：锚点一脏就全量重排', () => {
  const llm = shape({ kind: 'llm', anchorText: '', suffixText: '帮我' });
  assert.equal(anchorMeasurable('llm'), false);
  assert.equal(decideOverlayPaint({ prev: llm, next: { ...llm, suffixText: '帮我重新部署' }, painted: true, anchorDirty: true }),
    'rebuild');
  assert.equal(decideOverlayPaint({ prev: llm, next: { ...llm, suffixText: '帮我重新部署' }, painted: true, anchorDirty: false }),
    'grow-only');
});

// ── 3. 行尾位移阈值 ────────────────────────────────────────────────────────
run('阈值内的抖动不重排，越界必须重排', () => {
  const base = { right: 320, top: 100 };
  assert.equal(anchorMovedBeyond(base, { right: 320, top: 100 }), false);
  assert.equal(anchorMovedBeyond(base, { right: 320.6, top: 100.4 }), false, '亚像素舍入');
  assert.equal(anchorMovedBeyond(base, { right: 320 + ANCHOR_REDRAW_TOLERANCE_PX, top: 100 }), false, '等于阈值不算动');
  assert.equal(anchorMovedBeyond(base, { right: 320 + ANCHOR_REDRAW_TOLERANCE_PX + 0.5, top: 100 }), true);
  assert.equal(anchorMovedBeyond(base, { right: 320, top: 130 }), true, '换行了必须重排');
});

run('任一端未知一律判「动了」（保守重测）', () => {
  assert.equal(anchorMovedBeyond(null, { right: 1, top: 1 }), true);
  assert.equal(anchorMovedBeyond({ right: 1, top: 1 }, null), true);
  assert.equal(anchorMovedBeyond({ right: Number.NaN, top: 1 }, { right: 1, top: 1 }), true);
  assert.equal(anchorMovedBeyond({ right: 1, top: 1 }, { right: Number.POSITIVE_INFINITY, top: 1 }), true);
});

// ── 4. 错峰补渲染在增长期让路 ──────────────────────────────────────────────
run('增长流里 [60,300,900] 三次补渲染都跳过；不在绘制中则照跑', () => {
  for (const ms of [60, 300, 900]) {
    assert.equal(shouldSkipDeferredRepaint({ painted: true, growing: true }), true, `${ms}ms 那一拍`);
  }
  assert.equal(shouldSkipDeferredRepaint({ painted: true, growing: false }), false, '不是增长流：竞态还得靠它');
  assert.equal(shouldSkipDeferredRepaint({ painted: false, growing: true }), false, '没画出来：必须让它跑');
});

// ── 5. 强制同步布局次数模型（这条快路径买到的东西）─────────────────────────
/** 全量一轮付几次 rect/getComputedStyle 触发的同步布局：align() 1 + verify() 1 = 2。 */
const REBUILD_LAYOUTS = 2;
/** grow-remeasure 只付一次行尾 Range 测量，且不跑 align/verify。 */
const REMEASURE_LAYOUTS = 1;
/** grow-only 零测量。 */
const GROW_LAYOUTS = 0;

run('40 帧流式增长：旧路径 80 次强制布局 → 快路径 0 次（无外部事件时）', () => {
  let prev = shape({ suffixText: '' });
  let oldCost = 0;
  let newCost = 0;
  for (let i = 1; i <= 40; i += 1) {
    const next = shape({ suffixText: '这个插件的构建流程是什么'.slice(0, i) });
    oldCost += REBUILD_LAYOUTS;                       // 旧实现：每帧都全量
    const action = decideOverlayPaint({ prev, next, painted: true, anchorDirty: false });
    newCost += action === 'rebuild' ? REBUILD_LAYOUTS : action === 'grow-remeasure' ? REMEASURE_LAYOUTS : GROW_LAYOUTS;
    assert.equal(action, 'grow-only', `第 ${i} 帧应当零测量，实际 ${action}`);
    prev = next;
  }
  assert.equal(newCost, 0, `快路径实测 ${newCost}，期望 0`);
  assert.equal(oldCost, 80);
  assert.ok(oldCost > 0 && newCost === 0, '倍率必须无穷（旧 80 → 新 0）');
});

run('每 5 帧滚一次屏（锚点脏）：新路径 8 次测量，仍是旧路径 80 次的 1/10', () => {
  let prev = shape({ suffixText: '' });
  let oldCost = 0;
  let newCost = 0;
  let dirty = false;
  let anchor = { right: 320, top: 100 };
  for (let i = 1; i <= 40; i += 1) {
    if (i % 5 === 0) dirty = true;                    // 滚动/尺寸事件置脏
    const next = shape({ suffixText: '这个插件的构建流程是什么'.slice(0, i) });
    oldCost += REBUILD_LAYOUTS;
    const action = decideOverlayPaint({ prev, next, painted: true, anchorDirty: dirty });
    if (action === 'grow-remeasure') {
      newCost += REMEASURE_LAYOUTS;
      // 滚动时 overlay 随内容一起走，行尾在 offsetParent 坐标系里没动 → 不必重排。
      if (!anchorMovedBeyond(anchor, anchor)) dirty = false;
    } else if (action === 'rebuild') {
      newCost += REBUILD_LAYOUTS;
      dirty = false;
    } else {
      assert.equal(action, 'grow-only');
      newCost += GROW_LAYOUTS;
    }
    prev = next;
  }
  assert.ok(newCost <= oldCost / 5, `新路径 ${newCost} 次，旧路径 ${oldCost} 次，倍率不足`);
});

run('尾巴换成另一段文本 → 立刻回全量（快路径不吞掉真实变化）', () => {
  const prev = shape({ suffixText: '这个插件' });
  const next = shape({ suffixText: '另一份建议' });
  assert.equal(decideOverlayPaint({ prev, next, painted: true, anchorDirty: false }), 'rebuild');
});

run('kind 从 inline 换到 history → 全量：形态变化永远重新自检', () => {
  const prev = shape({ kind: 'inline', anchorText: '草稿', suffixText: '尾巴' });
  const next = shape({ kind: 'history', anchorText: '草稿', suffixText: '尾巴了' });
  assert.equal(decideOverlayPaint({ prev, next, painted: true, anchorDirty: false }), 'rebuild');
});

process.exit(failed === 0 ? 0 : 1);
