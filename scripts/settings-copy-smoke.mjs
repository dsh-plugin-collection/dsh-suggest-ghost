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
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findHardcodedCopy } from './copy-source-check.mjs';

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

// ─── 渲染路径里不许有硬编码中文 ──────────────────────────────────────────
// 用户可见文案只有两条合法来源：`GHOST_FIELDS` 的 `{ zh, en }` 双值，和
// `zhStrings`/`enStrings` 字典（en 由映射类型锁键集）。写在 JSX 里的中文**没有任何
// 测试能拦住**——类型对、渲染对、中文界面下看甚至是对的，只有切了语言才露。
// 掩码式扫描（剥注释 → 掩字典块 → 掩双语字面量 → 剩下的 CJK 才算违规）在
// `scripts/copy-source-check.mjs`，那里记录了每一步在消哪一类假阳性。
// 覆盖面是**整个 src/client/**，不是只看设置卡片：键位提示、导航条目名同样是用户界面。
// 放行表：每条**必须写理由**，理由是「这不是界面文案」或「这已经是双语的第 ③ 种写法」。
// 表里没有的中文 ⇒ 红。加一条放行等于认一次「这不是文案」，所以理由要能被下一个人反驳。
const COPY_ALLOW = [
  // （曾有一条 `key-hint-text.ts` 的放行：本文件把「按 lang 分支拼中文」改成
  //  { zh, en } 双值的 WORDING 表之后它就空转了 ⇒ 按本闸自己的规矩删掉，不留后门。）
  // 非 UI 文本：给模型看的工具参数说明，不进界面。
  { file: 'stream-ghost.ts', re: /^\s*description:/, why: 'typert 工具参数的 description，读者是模型不是人' },
  // 非 UI 文本：诊断串，出现在 `｜目录 …` 里，是**工程读数**而非用户文案；
  // 真要双语化得先决定它该不该出现在用户界面（见放行表下方第二条 check）。
  { file: 'index.ts', re: /officialCatalogDiag = |console\.warn\(/, why: '目录诊断/console 读数，非界面文案' },
];

check('src/client/** 无硬编码中文文案（必须走 { zh, en }、字典或 lang 分支）', () => {
  const dir = join('src', 'client');
  const offenders = [];
  for (const name of readdirSync(dir)) {
    if (!/\.(ts|tsx)$/.test(name)) continue;
    const allow = COPY_ALLOW.filter((a) => a.file === name).map((a) => ({ re: a.re }));
    const hits = findHardcodedCopy(readFileSync(join(dir, name), 'utf8'), allow);
    if (hits.length > 0) offenders.push(`${name}\n        ${hits.join('\n        ')}`);
  }
  assert.deepEqual(offenders, [], `以下中文文案没走合法来源，切走语言就会露：\n      ${offenders.join('\n      ')}`);
});

// 放行表不许烂掉：条目一旦不再命中任何行（文案被双语化了、或文件改名了），
// 留着它就等于给未来的中文文案预先开了后门 ⇒ 红。
check('放行表没有空转条目', () => {
  const dir = join('src', 'client');
  const idle = [];
  for (const a of COPY_ALLOW) {
    const file = join(dir, a.file);
    let exists = true;
    try { readFileSync(file, 'utf8'); } catch { exists = false; }
    if (!exists) { idle.push(`${a.file}（文件不存在）`); continue; }
    const without = findHardcodedCopy(readFileSync(file, 'utf8'), []);
    // 命中项带 `行号: ` 前缀，而放行正则（如 `^\s*description:`）是**对着源码行**写的
    // ⇒ 必须先把前缀摘掉再比，否则条目永远"空转"，闸就会逼人把正则写歪。
    const matched = without.filter((h) => a.re.test(h.replace(/^\d+:\s*/, '')));
    if (matched.length === 0) idle.push(`${a.file}: ${a.why}`);
  }
  assert.deepEqual(idle, [], `放行条目已空转 ⇒ 删掉它（留着就是后门）：\n      ${idle.join('\n      ')}`);
});

console.log(`\n${failed === 0 ? '✅' : '❌'} settings-copy-smoke: ${failed === 0 ? '设置页文案是用户视角' : `${failed} 条不合格`}`);
process.exit(failed === 0 ? 0 : 1);
