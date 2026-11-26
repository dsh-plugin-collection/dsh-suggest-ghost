#!/usr/bin/env node
/**
 * `.tsx` 的**未定义标识符**闸（本单的附带产物，不是键位功能的一部分）。
 *
 * ## 为什么必须有这道闸
 *
 * `tsconfig.client.json` 的 include 是 `src/client/` 下的 `.ts` —— `.tsx` **不在类型检查范围内**
 * （该文件 `:19`/`:47` 记着原因：开 `jsx` 会照出上百条存量问题，记在 Gitea #87，刻意不开）。
 * 于是本单在 `settings-card.tsx` 里漏 import 一个函数时：
 *  - `tsc -p tsconfig.json` 绿（host 不看它）；
 *  - `node build.mjs` 绿（esbuild 打包**不做名称解析**，未定义的自由变量原样留在产物里）；
 *  - 68 条冒烟全绿（没有一条载得动 `.tsx`）；
 *  - 真浏览器里一打开插件详情页 ⇒ `ReferenceError: bindingTableFor is not defined`
 *    ⇒ 宿主报 `slot entry crashed in 'plugins.bundle.config'`，整块设置界面没了。
 *
 * 这条不是在假想：**它就是本单实际踩到的**（2026-11-26，沙箱 web 实例 + Playwright 取证时炸出来的）。
 * `docs/keybinding-settings-design.md` §3.5 当时写的是「本分区的验收必须靠冒烟与 GUI，不能靠编译」——
 * 那句话是对的，但它只描述了风险，没关掉洞。这个脚本把洞关掉。
 *
 * ## 为什么不干脆打开 `jsx`、把 199 条一起修了
 *
 * 不在本单范围，而且那 53 条存量错误里多数要动的不是 `.tsx`（TS2307 缺宿主包类型、
 * TS2532 是 `noUncheckedIndexedAccess` 口径、TS2341/TS18047 是**刻意留着的哨兵**，
 * 见 `tsconfig.client.json` 的逐条归因）。本闸只取**一类**：TS2304（Cannot find name）
 * 与 TS2552（Cannot find name 的 suggestion 变体）——它们与那 53 条互不重叠，
 * 且实测在干净的 `origin/main` 上是 **0 条**，所以「必须为 0」不是一句会自己红的话。
 *
 * ## 变异自证（本仓 §6 的规矩：加一道闸先证它是活的）
 *
 * 见文件末尾：往 `settings-card.tsx` 的一份**临时副本**里注入一个不存在的标识符，
 * 断言本闸能抓到它。注入不改磁盘文件（写临时目录 + 只在那儿跑 tsc），所以失败也不会留脏产物。
 *
 * 用法：`node scripts/client-name-check-smoke.mjs`
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const NAME_ERRORS = /error TS(2304|2552):/;
const TSC = join(process.cwd(), 'node_modules', '.bin', 'tsc');
const CONFIG = 'tsconfig.client.json';

let failed = 0;
const run = (name, fn) => {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}\n      ${String(error.message).split('\n').slice(0, 6).join('\n      ')}`);
  }
};

/** 跑一次 tsc 并返回 TS2304/TS2552 行。工具本身跑不起来必须抛，不许当成「零错误」。 */
const nameErrors = (cwd) => {
  if (!existsSync(join(cwd, 'node_modules', '.bin', 'tsc'))) {
    throw new Error(`${cwd} 下没有 tsc（软链没建？）`);
  }
  let out = '';
  try {
    out = execFileSync(join(cwd, 'node_modules', '.bin', 'tsc'), ['-p', CONFIG, '--noEmit', '--jsx', 'react-jsx'],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    // tsc 有错误时退出码非 0 —— 这是**预期路径**，不是工具坏了。
    out = `${error.stdout ?? ''}${error.stderr ?? ''}`;
    if (!/error TS\d+/.test(out) && !/error TS\d+/.test(`${error.message}`)) {
      throw new Error(`tsc 没有产出任何错误行，工具可能没跑起来：${String(error.message).split('\n')[0]}`);
    }
  }
  return out.split('\n').filter((line) => NAME_ERRORS.test(line));
};

// ── 1. 真产物：未定义标识符必须为 0 ───────────────────────────────────────
run('src/client/**.tsx 里没有未定义标识符（TS2304 / TS2552 = 0）', () => {
  const hits = nameErrors(process.cwd());
  assert.deepEqual(hits, [], `以下名字在用之前没有 import/声明（构建与冒烟都不会红，浏览器里会炸 slot）：\n${hits.join('\n')}`);
});

// ── 2. 注入自证：这道闸抓得住本单真实踩过的那类错 ────────────────────────
run('★ 注入自证：漏 import 一个函数时本闸必须红', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sg-name-check-'));
  try {
    // 只拷检查需要的东西：src + 两个 tsconfig + package.json；node_modules 用软链（同 §4 的口径）。
    for (const f of ['src', 'tsconfig.json', CONFIG, 'package.json']) cpSync(join(process.cwd(), f), join(dir, f), { recursive: true });
    // node_modules 走软链（§4 的口径：不 install，几秒建好、不吃磁盘）。
    symlinkSync(join(process.cwd(), 'node_modules'), join(dir, 'node_modules'), 'dir');
    const file = join(dir, 'src', 'client', 'settings-card.tsx');
    const src = readFileSync(file, 'utf8');
    // 复刻本单实际发生的错：**删掉**那行 import，而不是随便造个假语法。
    const without = src.replace(/import \{ bindingTableFor \} from '\.\/accept-key\.js';/, '');
    assert.notEqual(without, src, '注入锚点没命中（import 行形状变了？）—— 注入无效，本条不算过');
    writeFileSync(file, without, 'utf8');
    const hits = nameErrors(dir).filter((line) => line.includes('bindingTableFor'));
    assert.ok(hits.length >= 1, '删掉 import 之后本闸仍然全绿 ⇒ 闸是瞎的，本单那条事故抓不住');
    // 顺带确认：不是「整个文件都不检查」——只有 TS2304 这一类被抓到即可，不要求别的错误。
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

console.log(`\n${failed === 0 ? '✅' : '❌'} client-name-check-smoke: ${failed === 0 ? '.tsx 的名称检查这道闸活着' : `${failed} 条不合格`}`);
process.exit(failed === 0 ? 0 : 1);
