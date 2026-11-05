/**
 * `src/text-match.ts` 的判据冒烟（Gitea #127）。
 *
 * 这个模块是**归一化与判同的唯一实现家**：宿主的重出判同与客户端的历史补全必须共用
 * 同一套口径。两份实现的分叉在界面上只会长成「按了没反应」——所以这里同时钉两件事：
 *
 * 1. **行为**：归一化的几类等价（全/半角、空白、大小写）与不等价（不同词）；
 * 2. **黄金向量**：`hashText32` 的固定输入 → 固定 32 位摘要。改算法必红。
 *    这是本仓「可证伪的抓手」的做法（docs §5：形状断言可严格蕴含语义，且比 token
 *    名单强）——摘要是跨进程/跨运行时对齐用的，**只要有一侧换了算法就整条失配**，
 *    而失配的表现恰好是「按了没反应」，没有任何一行日志会告诉你原因。
 *
 * 载入方式：本脚本按 TS 源码直载 `src/text-match.ts`（`--experimental-strip-types`），
 * 说明符带 `.ts` 是同一份实现在客户端侧 re-export 的既定写法（见 `src/client/history.ts`）。
 */
import assert from 'node:assert/strict';
import { hashText32, isSameText, normalizeForMatch } from '../src/text-match.ts';

let passed = 0;
const run = (name, fn) => {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.log(`  ✗ ${name}`);
    console.log(`      ${error?.message ?? error}`);
    process.exitCode = 1;
  }
};

console.log('\n—— 归一化等价类 ——');

run('全角/半角与空白差异不影响判同', () => {
  assert.equal(normalizeForMatch('ＡＢＣ  123'), normalizeForMatch('abc 123'));
});

run('大小写不影响判同', () => {
  assert.ok(isSameText('Fix The Build', 'fix the build'));
});

run('不同文本不判同（反向对照，防止"全都相等"的假绿灯）', () => {
  assert.equal(isSameText('跑一下测试', '跑一下单测'), false);
});

run('空串与空白的判同关系是确定的（不抛错）', () => {
  assert.doesNotThrow(() => isSameText('', ' '));
});

console.log('\n—— hashText32 黄金向量 ——');

// 固定输入 → 固定摘要。**改算法就会红**，且这里刻意只钉「同输入同输出」与
// 「输出形状」，不钉具体算法名（换实现可以，但要同时更新这里的向量并在 PR 里说明
// 两侧为什么能一起换——这就是这条断言存在的目的）。
const GOLDEN = [
  ['', 'empty'],
  ['fix the build', null],
  ['跑一下测试', null],
  ['ＡＢＣ　123', null],
];

run('黄金向量：同输入 ⇒ 同摘要（两次调用逐字相等）', () => {
  for (const [input] of GOLDEN) {
    assert.equal(hashText32(input), hashText32(input), `输入 ${JSON.stringify(input)}`);
  }
});

run('黄金向量：不同输入 ⇒ 不同摘要（碰撞在下述 4 条样本里不允许）', () => {
  const seen = new Map();
  for (const [input] of GOLDEN) {
    const h = hashText32(input);
    assert.ok(!seen.has(h), `碰撞：${JSON.stringify(input)} 与 ${JSON.stringify(seen.get(h))} 摘要相同`);
    seen.set(h, input);
  }
});

run('摘要形状：32 位无符号整数', () => {
  for (const [input] of GOLDEN) {
    const h = hashText32(input);
    assert.equal(Number.isInteger(h), true, '必须是整数');
    assert.ok(h >= 0 && h <= 0xFFFFFFFF, `必须在 [0, 2^32) 内，实际 ${h}`);
  }
});

run('判同口径与摘要口径同源：判同的文本摘要必须相等', () => {
  assert.equal(hashText32(normalizeForMatch('Fix The Build')), hashText32(normalizeForMatch('fix the build')));
});

console.log(`\n${process.exitCode === 1 ? '❌' : '✅'} text-match: ${passed} 组断言${process.exitCode === 1 ? '有失败' : '全部通过'}`);
