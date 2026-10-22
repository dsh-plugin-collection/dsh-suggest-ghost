#!/usr/bin/env node
/**
 * 客户端源码「带扩展名的相对说明符」白名单闸（Gitea #81 / #34，task-26）。
 *
 * ## 这条闸防的是什么
 * #34 的归因表里 TS5097 有 9 条（潜在 4 条，合计 13），修法是把 `src/client/**` 里
 * 指向本仓源码的相对说明符统一成宿主侧的 `.js` 写法（B 方案；`import type` 一并改，
 * 因为「同文件一半 `.js` 一半 `.ts`」的混用正是这条要消的根源不对称）。
 *
 * 改完还剩**唯一一处刻意保留**：`src/client/accept-guard.ts` 的 `'./history.ts'`。
 * 它不是漏网，是**两条约束的交叉点**：那 5 条离线冒烟
 * （`accept-cas-smoke` / `frame-monotonic-smoke` / `legacy-payload-smoke` /
 * `provisional-accept-smoke` / `ghost-frame-e2e`）**刻意按 TS 源码直载**，为的就是
 * `docs/gitea-workflow.md` 记的那条「`lib/` 是入库产物 ⇒ 改 src 不重建就跑冒烟会假绿」。
 * 而 Node 的 type-stripping **不做** `.js → .ts` 回退解析（实测
 * `ERR_MODULE_NOT_FOUND`，url 指向 `src/client/history.js`）⇒ 这一处改成 `.js`
 * 会当场断那 5 条链，等价于把「产物陈旧假绿」这个坑请回来。
 *
 * ## 为什么要有这个文件（而不是写段注释就完事）
 * 例外一旦被**人记住**，就会被下一个人当成漏网顺手修掉（然后 5 条冒烟红在 CI 上、
 * 或者更糟：被改成载 `lib/` 让它安静下来）。所以例外由机器钉住，两个方向都拦：
 *  1. 命中数 > 1 或命中位置变了 ⇒ 红（新引入的 `.ts` 说明符）；
 *  2. 命中数 = 0 ⇒ 也红 ⇒ 说明那唯一一处被"顺手修掉了"，此时必须回头确认那 5 条
 *     冒烟的加载方式有没有被同时改掉（那是本条禁止的方向）。
 *
 * 用法：node scripts/client-import-surface-smoke.mjs
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const CLIENT_DIR = fileURLToPath(new URL('../src/client', import.meta.url));

/**
 * 白名单：**文件 + 行号 + 目标说明符**三者全钉。
 * 只钉文件名不够——挪了行位的改动应当被看见；只钉行号不够——挪动行位会误报。
 */
const ALLOWED = [
  { file: 'accept-guard.ts', line: 51, specifier: './history.ts' },
];

/** 带 `.ts` / `.tsx` 扩展名的**相对**说明符（指向本仓源码；不含 `@deepseek-ai/*` 那类裸包名）。 */
const RE = /from\s+['"](\.[^'"]*\.tsx?)['"]/g;

const findings = [];
for (const name of readdirSync(CLIENT_DIR).sort()) {
  if (!/\.(ts|tsx)$/.test(name)) continue;
  const lines = readFileSync(join(CLIENT_DIR, name), 'utf8').split('\n');
  lines.forEach((text, i) => {
    // 注释行里的示例文本不算命中（本文件与 tsconfig.client.json 的说明里都会出现这种字样）。
    if (/^\s*(\/\/|\/?\*)/.test(text)) return;
    for (const m of text.matchAll(RE)) {
      findings.push({ file: name, line: i + 1, specifier: String(m[1]) });
    }
  });
}

const expected = ALLOWED.map((a) => `${a.file}:${a.line}:${a.specifier}`).sort().join(' , ');
const actual = findings.map((f) => `${f.file}:${f.line}:${f.specifier}`).sort().join(' , ');

// 方向 1：不许多出任何一处（新引入的 `.ts`/`.tsx` 相对说明符）。
for (const f of findings) {
  assert.ok(
    ALLOWED.some((a) => a.file === f.file && a.line === f.line && a.specifier === f.specifier),
    `src/client 里出现了白名单外的带扩展名说明符：${f.file}:${f.line} → '${f.specifier}'。`
    + '指向本仓源码的相对导入一律写 `.js`（宿主侧 NodeNext 口径，esbuild 与 tsc 两侧都认）。',
  );
}

// 方向 2：那唯一一处不许被「顺手修掉」——修掉它意味着要么改成了 `.js`（会断 5 条按
// TS 源码直载的离线冒烟），要么改了那些冒烟的加载方式（本条禁止的方向）。二者都得先过
// 一遍 #81 里记的架构遗留，不许顺手做。
assert.equal(
  findings.length,
  ALLOWED.length,
  `带扩展名说明符的命中数应为 ${ALLOWED.length}（唯一刻意保留的例外），实得 ${findings.length}。`
  + `\n  期望 ${expected}\n  实得 ${actual || '(无命中)'}`
  + (findings.length === 0
    ? '\n  命中为 0 ⇒ 唯一的刻意例外被移除了：请确认那 5 条离线冒烟仍在按 TS 源码直载'
      + '（改成载 lib/ 是被禁止的做法，见本文件头）。'
    : ''),
);

// 逐字节对齐（文件/行/目标三者），让「行位挪了」也红，而不是靠数量巧合放过。
assert.equal(actual, expected, `白名单例外发生了位移或被替换：\n  期望 ${expected}\n  实得 ${actual}`);

console.log(`✅ client-import-surface: 带扩展名说明符命中 ${findings.length} 处，与白名单逐字一致（${expected}）`);
