#!/usr/bin/env node
/**
 * 跨内核装配面 + 功能面回归：每一代次**真冷启动**一次真内核，看插件是否真的被装载、
 * `apply()` 是否真的跑、投影单元是否真的注册成**该代次认得**的形状。
 *
 * 由 Lead 接手实现：原 owner（mount-runner）在做到"hmr 需要 appReady、准备在 prepare()
 * 里补上"这一步时中断，未留下产物。其诊断我已复核属实（dsh-hmr/lib/index.js:832 会
 * `ownerContext.get('appReady')`，而 `boot()` 不提供该服务——只有启动器的 runProfile
 * 提供）。本实现**绕开**这个问题而不是解决它：hmr 行在 dsh-base 里本来就是
 * `disabled: !!js "!ctx.get('profileContext')"`，而这里**故意不提供 profileContext**
 * 之外的 appReady，并把 hmr 显式关掉——装配面要的是"插件进没进 loader"，
 * 不是"热重载能不能用"。见 off.patch.yml 那一段。
 *
 * ## 判据（全部是形状判据，不搜业务正文）
 *
 * 1. **装配面**：stdout 出现 `[dsh-suggest-ghost][ops-trace] apply called; artifact mtime=`。
 *    这行是 `console.log` 打的（src/index.ts:372 说这是健康进程里唯一可见面），
 *    所以必须从**本进程 stdout** 取，不能去 DSH_HOME 的日志文件里找。
 * 2. **注册面**：从 `ctx.get('sessionProjections').registrations`（Map<key,{def,cells,refs}>）
 *    取 `def`，验它有没有 `stateSchema` / `wire.viewSchema`（新形状）或 `schema` / `view`
 *    （旧形状）。**注册成功 ≠ 能落地**：registry 会静默丢掉不认识的形状（见下）。
 *
 * ## 隔离（skill §1）
 *
 * - `DSH_HOME` = realpath 过的 mkdtemp，在 import 内核**之前**设好。
 * - 插件是**实体副本**放 `<profile>/node_modules/dsh-suggest-ghost`；仓库目录绝不上解析路径。
 * - 该代次版本树的 node_modules 逐项软链到同一层。
 * - 跑完扫真实 `~/.dsh`，本次 nonce 出现即报红并删除。
 * - **一代次一进程**（worker 子进程），内存态不跨代次串味。
 *
 * 用法：
 *   node scripts/cross-kernel/mount-run.mjs [--kernel-root ~/dsh-versions] [--only 0.2.1-rc.2]
 * 退出码：0 全绿 / 1 有红 / 2 有未判定。
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { KERNEL_GENERATIONS } from './generations.mjs';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
const ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..', '..');
const KERNEL_ROOT = resolve(opt('kernel-root', join(homedir(), 'dsh-versions')));
const ONLY = (opt('only', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
const OUT_DIR = join(ROOT, 'scripts', 'cross-kernel', 'out');
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const NAME = PKG.name;

/** worker：在子进程里冷启动一代内核并回报形状。 */
const WORKER = `
import { existsSync, mkdirSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const [root, home, pluginRoot, projectionKey] = process.argv.slice(2);
const profile = join(home, 'profiles', 'x');
const REQUIRED = '@deepseek-ai/dsh-app-boot/lib/index.js';

// stdout 落痕捕获：插件的 apply 行是 console.log，且用户代码也会用它。
const traceLines = [];
const realLog = console.log.bind(console);
console.log = (...a) => { const l = a.map(String).join(' '); if (l.includes('[dsh-suggest-ghost]')) traceLines.push(l); else realLog(l); };

const out = { ok: false, applyRan: false, registered: null, shapes: null, events: 0, error: null, treeStamp: null };
const mark = () => { try { return { entries: readdirSync(join(root, 'node_modules', '@deepseek-ai')).length, mtimeMs: statSync(root).mtimeMs }; } catch { return null; } };
out.treeStamp = mark();
try {
  const boot = await import(pathToFileURL(join(root, 'node_modules', REQUIRED)).href);
  // 内核自己的 initProfile：写 package.json / cordis.patch.yml / pnpm-workspace.yaml。
  if (typeof boot.initProfile !== 'function') throw new Error('这一代次的 app-boot 没有 initProfile 导出');
  boot.initProfile(profile, ['@deepseek-ai/dsh-base']);
  // initProfile **不写** cordis.yml，而 boot() 第一个参数就是它 —— 不补写整棵 profile 树
  // 会 config file not found，插件根本进不了 loader（这条踩过，见 FINDINGS.md §5）。
  const rootConfig = join(profile, 'cordis.yml');
  if (!existsSync(rootConfig)) writeFileSync(rootConfig, '[]' + String.fromCharCode(10));
  const off = join(home, 'off.patch.yml');
  // 关掉 hmr：它要 appReady，而 boot() 不提供该服务（那由启动器 runProfile 提供）。
  // 装配面不需要热重载，显式关掉，别把无关告警当故障。
  // 用数组 join 而不是模板里的 \\n 转义：嵌套模板里写 \\n 会被外层再吃一层，
  // 落成字面量反斜杠 n，YAML 直接 bad indentation（踩过）。
  writeFileSync(off, ['- id: hmr', '  disabled: true', ''].join(String.fromCharCode(10)));
  const layers = [
    join(root, 'node_modules', '@deepseek-ai', 'dsh-base', 'cordis.patch.yml'),
    join(pluginRoot, 'cordis.patch.yml'),
    off,
  ];
  const patches = layers.flatMap((f) => existsSync(f) && typeof boot.loadOverlayPatches === 'function' ? boot.loadOverlayPatches('ghost-xk', f) : []);
  const ctx = await boot.boot('ghost-xk', rootConfig, patches, (c) => {
    c.provide('profileContext', { name: 'x', dir: profile, patchPath: join(profile, 'cordis.patch.yml'), installAnchor: root, startedBundles: [], cwd: home, home, overlays: [] });
  });
  out.agents = ctx.agents !== undefined;
  out.sessions = ctx.sessions !== undefined;
  out.settings = ctx.settings !== undefined;

  // 等一拍让 ctx.effect 里的注册与 apply 落定。
  await new Promise((r) => setTimeout(r, 400));

  out.applyRan = traceLines.some((l) => l.includes('apply called'));
  const svc = ctx.get?.('sessionProjections');
  const regs = svc?.registrations;
  const def = regs instanceof Map ? regs.get(projectionKey)?.def : undefined;
  out.registered = { key: projectionKey, found: def !== undefined };
  if (def !== undefined) {
    out.shapes = {
      modernShape: def.stateSchema !== undefined && def.wire?.viewSchema !== undefined,
      legacyShape: def.schema !== undefined && def.view !== undefined,
      hasStateSchema: def.stateSchema !== undefined,
      hasWire: def.wire !== undefined,
      stateVersion: def.stateVersion ?? null,
    };
  }
  out.ok = true;
  try { await ctx.fiber?.dispose?.(); } catch {}
} catch (error) {
  out.error = String(error?.message ?? error).slice(0, 400);
}
out.events = traceLines.length;
out.traceTail = traceLines.slice(-4);
out.stdoutTrace = traceLines.filter((l) => l.includes('apply called')).slice(0, 1);
// ⚠️ 不能靠 stdout 回报：内核 boot() 过程中会接管/替换 console.log，
// 于是"覆盖 console.log 收落痕"这一招连自己的最后一行报表一起吃掉
// （实测 exit 0 + stdout 空 + stderr 空，看起来像 worker 没跑，其实跑完了）。
// 报表一律写文件，由父进程读。落痕本身仍从 console.log 覆盖里收集。
writeFileSync(join(home, 'report.json'), JSON.stringify(out));
`;

const results = [];
const VERSIONS = ONLY.length ? KERNEL_GENERATIONS.filter((g) => ONLY.includes(g.id)) : KERNEL_GENERATIONS;

for (const gen of VERSIONS) {
  const v = gen.id;
  const root = gen.kernelRootOverride ?? join(KERNEL_ROOT, v);
  const rec = { version: v, note: gen.note ?? null, verdict: null, notes: [] };
  if (!existsSync(join(root, 'node_modules', '@deepseek-ai', 'dsh-app-boot'))) {
    rec.verdict = 'UNDETERMINED';
    rec.notes.push(`该代次树里没有 @deepseek-ai/dsh-app-boot：${root}`);
    results.push(rec);
    console.log(`\n### ${v} … 未判定\n    ${rec.notes[0]}`);
    continue;
  }
  let runtime = '?';
  try { runtime = JSON.parse(readFileSync(join(root, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8')).version; } catch {}
  let launcher = '?';
  try { launcher = JSON.parse(readFileSync(join(root, 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'package.json'), 'utf8')).version; } catch {}
  rec.runtime = runtime; rec.launcher = launcher;
  if (launcher !== runtime) rec.notes.push(`启动器版本≠dsh 版本（app-boot=${launcher}，dsh=${runtime}）——该代次树不自洽`);

  const home = realpathSync(mkdtempSync(join(tmpdir(), 'ghost-xk-')));
  const nonce = `ghost-xk-${Math.random().toString(36).slice(2, 8)}`;
  rec.nonce = nonce;
  try {
    const profile = join(home, 'profiles', 'x');
    const nm = join(profile, 'node_modules');
    mkdirSync(nm, { recursive: true });
    for (const entry of readdirSync(join(root, 'node_modules'))) {
      if (entry === '.bin' || entry.startsWith('.')) continue;
      const src = join(root, 'node_modules', entry);
      if (entry.startsWith('@')) {
        mkdirSync(join(nm, entry), { recursive: true });
        for (const c of readdirSync(src)) symlinkSync(join(src, c), join(nm, entry, c), 'dir');
        continue;
      }
      symlinkSync(src, join(nm, entry), 'dir');
    }
    // 实体副本：挂仓库目录会让插件解析到自己 node_modules 里那份宿主包，跨版本矩阵当场失真。
    const copy = join(nm, NAME);
    mkdirSync(copy, { recursive: true });
    for (const f of ['package.json', 'cordis.patch.yml', 'icon.svg']) if (existsSync(join(ROOT, f))) cpSync(join(ROOT, f), join(copy, f));
    for (const d of ['lib', 'docs']) if (existsSync(join(ROOT, d))) cpSync(join(ROOT, d), join(copy, d), { recursive: true });

    const workerFile = join(home, 'worker.mjs');
    writeFileSync(workerFile, WORKER);
    const wr = spawnSync(process.execPath, [workerFile, root, home, copy, 'suggestGhost'], {
      encoding: 'utf8', timeout: 300_000, env: { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' },
    });
    const so = String(wr.stdout ?? '');
    const se = String(wr.stderr ?? '');
    rec.workerExit = wr.status;
    // 报表从文件读：内核 boot() 会接管 console.log，靠 stdout 回报会连报表一起被吃掉。
    let W = null;
    const reportFile = join(home, 'report.json');
    if (existsSync(reportFile)) {
      try { W = JSON.parse(readFileSync(reportFile, 'utf8')); }
      catch (e) { rec.notes.push(`worker 报表解析失败：${String(e.message).slice(0, 100)}`); }
    }
    rec.workerStdoutTail = so.split('\n').filter(Boolean).slice(-4).join('\n').slice(0, 300);
    if (!W) {
      rec.verdict = 'UNDETERMINED';
      rec.notes.push(`worker 没有回报结果（exit=${wr.status}）${se ? `；stderr 末行：${se.split('\n').filter(Boolean).slice(-1)[0]?.slice(0,200)}` : ''}`);
    } else {
      rec.worker = { ok: W.ok, applyRan: W.applyRan, registered: W.registered, shapes: W.shapes, agents: W.agents, sessions: W.sessions, settings: W.settings, treeStamp: W.treeStamp, traceTail: W.traceTail };
      if (W.error) rec.notes.push(`worker 报错：${W.error}`);
      if (!W.ok) rec.verdict = 'UNDETERMINED';
      else if (!W.applyRan) { rec.verdict = 'RED'; rec.notes.push('apply() 没有落痕：插件没被 loader 装载'); }
      else if (!W.registered?.found) { rec.verdict = 'RED'; rec.notes.push('apply() 跑了，但投影单元 suggestGhost 没注册上'); }
      else if (W.shapes?.modernShape) rec.verdict = 'GREEN';
      else if (W.shapes?.legacyShape) { rec.verdict = 'RED'; rec.notes.push('注册的是 legacy 形状（schema+view）；该形状在任何内核上都不落地，投影永远不会被服务'); }
      else { rec.verdict = 'RED'; rec.notes.push(`注册了但形状不明：${JSON.stringify(W.shapes)}`); }
    }
  } catch (error) {
    rec.verdict = 'UNDETERMINED';
    rec.notes.push(`装配异常：${String(error?.message ?? error).slice(0, 200)}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
  // 越界自检：本代次的 nonce 若出现在真实 ~/.dsh，说明隔离没生效。
  const leaked = [];
  try {
    const rs = join(homedir(), '.dsh', 'sessions');
    for (const top of readdirSync(rs, { withFileTypes: true })) {
      if (!top.isDirectory()) continue;
      const d = join(rs, top.name);
      for (const kid of readdirSync(d)) if (kid.includes(nonce)) leaked.push(join(d, kid));
    }
  } catch {}
  if (leaked.length) { rec.verdict = 'RED'; rec.notes.push(`隔离失效：写入真实 DSH_HOME：${leaked.join(', ').slice(0,160)}`); for (const p of leaked) rmSync(p, { recursive: true, force: true }); }
  results.push(rec);
  const badge = rec.verdict === 'GREEN' ? 'GREEN' : rec.verdict === 'RED' ? 'RED' : '未判定';
  console.log(`\n### ${v} … ${badge}`);
  if (rec.runtime) console.log(`    内核=${rec.runtime} 启动器=${rec.launcher} apply落痕=${rec.worker?.applyRan ? 'Y' : 'N'} 投影=${rec.worker?.registered?.found ? 'Y' : 'N'}${rec.worker?.shapes ? ` 形状=${rec.worker.shapes.modernShape ? 'modern' : rec.worker.shapes.legacyShape ? 'legacy' : '?'}` : ''}`);
  for (const n of rec.notes) console.log(`      · ${n}`);
  for (const t of rec.worker?.traceTail ?? []) console.log(`      │ ${t.slice(0, 150)}`);
}

mkdirSync(OUT_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const file = join(OUT_DIR, `mount-${stamp}.json`);
writeFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), versions: VERSIONS.map((g) => g.id), results }, null, 2)}\n`);
const red = results.filter((r) => r.verdict === 'RED').length;
const und = results.filter((r) => r.verdict === 'UNDETERMINED').length;
console.log(`\n汇总：绿 ${results.length - red - und} / 红 ${red} / 未判定 ${und}；明细 ${file}`);
process.exit(red > 0 ? 1 : und > 0 ? 2 : 0);
