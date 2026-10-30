#!/usr/bin/env node
// 设置页文案的判别冒烟：字段说明必须是"给用户看的"，不是工程笔记。
//
// ## 为什么要有这条
// 这些文案会被写成：`宿主会退一档重发一次，日志里记 effort_rejected=1`、
// `profile 里 18 个模型有 9 个没声明`、`typert 流`、`流式收益中位 1.8%/91ms`。
// 这些都是**实现者视角**，用户看不懂也不该看到。而它们没有任何测试能拦住 ——
// 类型对、功能正常、渲染也没错。所以只能把"什么算用户文案"写成可机械检查的规则：
//   ① 不出现 issue 编号（`#116`）
//   ② 不出现实现/运维术语（宿主、落盘、终帧、净化、profile、typert、_push…）
//   ③ 不出现研究数字（p50、1.8%、91ms）
//   ④ 长度有上限（说明是一句话，不是小作文）
//
// 用法：node scripts/settings-copy-smoke.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(process.cwd(), 'src', 'client', 'settings-card.tsx'), 'utf8');
const start = SRC.indexOf('export const GHOST_FIELDS');
assert.ok(start > 0, '找不到 GHOST_FIELDS');
const region = SRC.slice(start, start + 40000);

/** 实现者视角的词：出现在用户文案里就说明写错了对象。 */
const BANNED = [
  /#\d+/,                       // issue 编号
  /typert/i,
  /volatile/i,
  /落盘|终帧|净化|宿主|埋点|留痕/,
  /\bprofile\b/i,
  /_push|_hot|effort_rejected/,
  /\bp50\b|\b1\.8%|\b91ms\b/,
  /重发|退一档|兜底分支/,
];

const zh = [...region.matchAll(/zh: '([^']*)'/g)].map((m) => m[1]);
const en = [...region.matchAll(/en: '([^']*)'/g)].map((m) => m[1]);

let failed = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); } catch (error) {
    failed += 1;
    console.log(`  ✗ ${name}\n      ${String(error.message).split('\n')[0]}`);
  }
};

check(`中文说明条数 (${zh.length}) ≥ 25`, () => assert.ok(zh.length >= 25, `只有 ${zh.length} 条`));
check(`英文说明条数 (${en.length}) ≥ 25`, () => assert.ok(en.length >= 25, `只有 ${en.length} 条`));

check('中文说明里没有实现者视角的词', () => {
  const hits = [];
  for (const text of zh) for (const re of BANNED) if (re.test(text)) hits.push(`${re} → ${text.slice(0, 40)}`);
  assert.deepEqual(hits, []);
});

check('英文说明里没有实现者视角的词', () => {
  const hits = [];
  for (const text of en) for (const re of BANNED) if (re.test(text)) hits.push(`${re} → ${text.slice(0, 40)}`);
  assert.deepEqual(hits, []);
});

check('中文说明长度 ≤ 130（超过就是在写小作文）', () => {
  const long = zh.filter((s) => s.length > 130).map((s) => `${s.length}字：${s.slice(0, 30)}…`);
  assert.deepEqual(long, []);
});

check('英文说明长度 ≤ 200', () => {
  const long = en.filter((s) => s.length > 200).map((s) => `${s.length}：${s.slice(0, 30)}…`);
  assert.deepEqual(long, []);
});

check('没有空说明', () => {
  assert.ok(zh.every((s) => s.trim() !== ''), '存在空的中文说明');
  assert.ok(en.every((s) => s.trim() !== ''), '存在空的英文说明');
});

console.log(`\n${failed === 0 ? '✅' : '❌'} settings-copy-smoke: ${failed === 0 ? '设置页文案是用户视角' : `${failed} 条不合格`}`);
process.exit(failed === 0 ? 0 : 1);
