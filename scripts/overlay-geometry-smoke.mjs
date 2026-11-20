#!/usr/bin/env node
/**
 * 幽灵 overlay 盒子几何冒烟（纯函数，无 DOM）。
 *
 * 钉住的是「折行口径」：幽灵只是预览，它折出来的每一行都必须与「这段文字真的插进
 * 编辑器之后」逐行同形。旧口径（锚在行尾、宽度只取行末余量）会把续行全部排到
 * 行尾那一列，长建议在输入框右侧折成窄栏（用户截图）。
 *
 * 运行：`node --experimental-strip-types scripts/overlay-geometry-smoke.mjs`
 */
import assert from 'node:assert/strict';
import { overlayGeometry } from '../src/client/overlay-geometry.ts';

let failed = 0;
const run = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}\n      ${String(error.message).split('\n')[0]}`);
  }
};

/** 一个典型的 hero/标准 composer 量出来的数字（842px 内容宽、行高 24）。 */
const base = {
  originLeft: 14,
  originTop: 4,
  contentWidth: 842,
  originViewportX: 53,
  originViewportY: 130,
  caret: null,
  lineHeight: 24,
};
const caretAt = (offsetX, over = {}) => ({
  ...base,
  caret: { right: 53 + offsetX, top: 130, height: 17 },
  ...over,
});

run('llm 形态（没有行尾锚点）：整块从内容原点起，占满内容宽', () => {
  const g = overlayGeometry(base);
  assert.equal(g.left, 14);
  assert.equal(g.top, 4);
  assert.equal(g.width, 842);
  assert.equal(g.textIndent, 0);
});

run('草稿非空：盒子整行全宽，首行靠 text-indent 起笔（不是缩窄盒子）', () => {
  const g = overlayGeometry(caretAt(600));
  assert.equal(g.left, 14, '左缘必须是内容原点：折行后的续行从这里起排');
  assert.equal(g.width, 842, '宽度必须是整行：续行可用整行，而不是行末那一小段');
  assert.equal(g.textIndent, 600, '首行由 text-indent 顶到草稿行尾');
});

run('旧口径不得复活：行尾越靠右，盒子不得越窄（这就是右侧窄栏的成因）', () => {
  for (const offset of [0, 120, 600, 800, 842]) {
    const g = overlayGeometry(caretAt(offset));
    assert.equal(g.width, 842, `offset=${offset} 时宽度被缩窄了：旧口径复活`);
    assert.equal(g.left, 14, `offset=${offset} 时盒子被推到行尾了：旧口径复活`);
  }
});

run('缩进夹在 [0, 内容宽]：测量抖动不许把首行顶出内容区', () => {
  assert.equal(overlayGeometry(caretAt(-40)).textIndent, 0, '负偏移夹到 0');
  assert.equal(overlayGeometry(caretAt(900)).textIndent, 842, '超宽夹到内容宽');
});

run('垂直：顶上移 (lineHeight - 字高)/2，让灰字与正文字形同高', () => {
  const g = overlayGeometry(caretAt(600));
  assert.equal(g.top, 4 + 0 - (24 - 17) / 2);
});

run('行高是 normal（NaN）时不做行内偏移，也不得算出 NaN', () => {
  const g = overlayGeometry(caretAt(600, { lineHeight: Number.NaN }));
  assert.equal(g.top, 4);
  assert.ok(Number.isFinite(g.left) && Number.isFinite(g.width) && Number.isFinite(g.textIndent));
});

run('行尾落在内容原点（空最后一行）：缩进 0、整行可用', () => {
  const g = overlayGeometry(caretAt(0));
  assert.deepEqual({ left: g.left, width: g.width, textIndent: g.textIndent }, { left: 14, width: 842, textIndent: 0 });
});

console.log(`\n结果：${failed === 0 ? '全部通过' : `${failed} 条失败`}`);
process.exit(failed === 0 ? 0 : 1);
