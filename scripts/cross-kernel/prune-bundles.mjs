#!/usr/bin/env node
/**
 * 把沙箱 profile 的 bundle 清单裁到**被测那代次的树里真的存在**的那些。
 *
 * ## 为什么需要它（0.1.5-rc.3 实测）
 * `dev-sandbox` 从 live profile 复制 `package.json`，而 live 是 0.2.1 的组合：它的
 * `dsh.profile.bundles` 里有 `@deepseek-ai/dsh-experimental-agent-team-profile` 一类
 * **老树里根本没发布**的包。0.1.5 的 `dsh-app-boot` 对不可解析 bundle 是**硬失败**：
 *   Error: dsh: cannot resolve profile bundle "@deepseek-ai/dsh-experimental-agent-team-profile"
 *     at resolveBundleDir (.../@deepseek-ai+dsh-app-boot@0.1.5-rc.3.../...)
 * ⇒ 实例根本不监听，长得像"该代次不支持这个插件"，其实是**沙箱组合越代**。
 *
 * ## 规则
 *  - 只保留：`@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app`（GUI 必需，缺了
 *    `dsh web` 不监听、不报错、零输出 —— 技能 §1b 第一条）、被测插件本身，
 *    以及**在该树 node_modules 里解析得到**的其它 bundle；
 *  - 解析不到的：丢弃并逐条打印（丢弃是有声音的，不静默）；
 *  - `cordis.patch.yml` **也必须一起裁**到白名单顶层条目。本脚本第一版在这里写过
 *    "patch 指向不存在的 id 是空操作，可以留着" —— **那句是错的**，0.1.5-rc.3 实测：
 *      Error: failed to apply loader entry webhook-listener (cordis:group)
 *    那些条目嵌在别的顶层条目里（不是顶层 `- id: webhook`），只裁 bundle 不裁 patch
 *    会让老代次在 compose 阶段直接抛错 ⇒ 实例不监听，又长得像"该代次不支持"。
 *    白名单：本插件条目 + hmr + LLM 路由（llm-pi-ai / agent-default-model / permission / locale）。
 *
 *  - 还要补 `<home>/node_modules` → **被测树**的 node_modules。dev-sandbox 把插件放在
 *    `<home>/plugin/`（不是 `profiles/web/node_modules/` 下），于是它的裸导入向上找不到
 *    依赖：0.1.5-rc.3 实测报
 *      Error: failed to import loader entry suggest-ghost (dsh-suggest-ghost):
 *             Cannot find package '@deepseek-ai/schemastery'
 *    指到被测树而不是指到 live profile 的 node_modules，是为了避免"两份内核模块实例"
 *    那种矩阵失真（技能 §1）。
 *
 * 用法：node scripts/cross-kernel/prune-bundles.mjs --home ~/dsh-sbx-xkg-0153 \
 *          --tree ~/dsh-versions/0.1.5-rc.3 [--plugin dsh-suggest-ghost] \
 *          [--keep-entries a,b,c] [--no-patch]
 * 退出码：0 成功（含"无需改动"）/ 1 失败。
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
const HOME_ = opt('home', '').replace(/^~/, homedir());
const TREE = opt('tree', '').replace(/^~/, homedir());
const PLUGIN = opt('plugin', 'dsh-suggest-ghost');
const KEEP_ALWAYS = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', PLUGIN];

assert.ok(HOME_ !== '' && TREE !== '', '需要 --home <沙箱> 与 --tree <代次树>');
const pkgPath = join(HOME_, 'profiles', 'web', 'package.json');
assert.ok(existsSync(pkgPath), `沙箱 profile 没有 package.json：${pkgPath}（先跑一次 dev-sandbox 建骨架）`);
assert.ok(existsSync(join(TREE, 'node_modules')), `代次树不存在：${TREE}`);

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const bundles = pkg?.dsh?.profile?.bundles ?? [];
assert.ok(Array.isArray(bundles) && bundles.length > 0, 'profile 里没有 dsh.profile.bundles 数组');
const treeNM = join(TREE, 'node_modules');
const resolvable = (b) => b === PLUGIN || existsSync(join(treeNM, b, 'package.json'));

const kept = [];
const dropped = [];
for (const b of bundles) {
  if (KEEP_ALWAYS.includes(b) || resolvable(b)) kept.push(b);
  else dropped.push(b);
}
for (const must of KEEP_ALWAYS) {
  if (!must.startsWith('@') || !must.includes('dsh-')) continue;
  if (!kept.includes(must) && resolvable(must)) kept.unshift(must);
}
assert.ok(kept.includes(PLUGIN), `保留清单里没有本插件 ${PLUGIN} ⇒ 组合不成立`);
assert.ok(kept.includes('@deepseek-ai/dsh-web-app'), '保留清单里没有 dsh-web-app ⇒ dsh web 不会监听');

pkg.dsh.profile.bundles = kept;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
console.log(`bundle 裁剪：${bundles.length} → ${kept.length}（丢弃 ${dropped.length}）`);
for (const d of dropped) console.log(`  丢弃（该树解析不到）：${d}`);
console.log(`  保留：${kept.join(' , ')}`);

// ── patch 同步裁剪（见上方"第一版那句是错的"）────────────────────────────────
if (!argv.includes('--no-patch')) {
  const patchPath = join(HOME_, 'profiles', 'web', 'cordis.patch.yml');
  if (existsSync(patchPath)) {
    const lines = readFileSync(patchPath, 'utf8').split('\n');
    const starts = [];
    lines.forEach((l, i) => { if (/^- id:\s*\S+/.test(l)) starts.push(i); });
    // 本插件的条目 id **不等于包名**（实测 id=suggest-ghost / name=dsh-suggest-ghost）
    // ⇒ 按 name 反查，别按包名猜（这个假设本轮错过两次）。
    const pluginIds = [];
    starts.forEach((from, idx) => {
      const to = idx + 1 < starts.length ? starts[idx + 1] : lines.length;
      const body = lines.slice(from, to).join('\n');
      const id = lines[from].match(/^- id:\s*(\S+)/)?.[1];
      if (id != null && new RegExp(`^\\s+name:\\s*'?${PLUGIN}'?\\s*$`, 'm').test(body)) pluginIds.push(id);
    });
    if (pluginIds.length === 0) pluginIds.push('suggest-ghost');
    const keepEntries = (opt('keep-entries', '').split(',').map((x) => x.trim()).filter(Boolean));
    const keep = new Set([...pluginIds, 'hmr', 'llm-pi-ai', 'agent-default-model', 'permission', 'locale', ...keepEntries]);
    const out = [];
    let dropping = false;
    for (let i = 0; i < lines.length; i += 1) {
      const m = lines[i].match(/^- id:\s*(\S+)/);
      if (m !== null) { dropping = !keep.has(m[1]); }
      if (!dropping) out.push(lines[i]);
    }
    const removed = starts.length - out.filter((l) => /^- id:\s*\S+/.test(l)).length;
    writeFileSync(patchPath, out.join('\n'));
    console.log(`patch 裁剪：顶层条目保留 ${out.filter((l) => /^- id:/.test(l)).length} 条（丢弃 ${removed} 条），白名单=${[...keep].join(',')}`);
  }
}

// ── 让插件的裸导入能解析到**被测树**那份依赖 ────────────────────────────────────
{
  const homeNM = join(HOME_, 'node_modules');
  const want = join(treeNM);
  if (!existsSync(homeNM)) {
    const { symlinkSync } = await import('node:fs');
    symlinkSync(want, homeNM, 'dir');
    console.log(`补软链：<home>/node_modules → ${want}`);
  } else {
    const { realpathSync, readlinkSync } = await import('node:fs');
    let cur = '';
    try { cur = realpathSync(homeNM); } catch { cur = '(断链)'; }
    if (cur !== want) {
      console.log(`⚠ <home>/node_modules 现指 ${cur}，应为 ${want} ⇒ 请人工确认后改，本脚本不擅自动它`);
      process.exitCode = 1;
    } else {
      console.log('OK <home>/node_modules 已指向被测树');
    }
  }
}
