#!/usr/bin/env node
/**
 * 跨内核代次回归 · dsh-suggest-ghost 版。
 *
 * 形状照搬 `../dsh-later/scripts/verify-across-kernels.mjs`（提交 7d801f4）：
 * 逐代次拉起**真内核**（不是 mock）→ 冷启动装配 → 从**真实入口**观测判据 →
 * 打印表格 + 落 JSON → 退出码 0（全绿）/ 1（有红）/ 2（有未判定）。
 *
 * ## 用法
 *
 *     npm run verify:kernels                     # 跑 KERNEL_GENERATIONS 全部 7 代
 *     node scripts/verify-across-kernels.mjs --no-install --kernel-root ~/dsh-versions
 *     node scripts/verify-across-kernels.mjs --versions 0.1.7-rc.1,0.2.1-rc.2
 *
 * 代次清单**取自 `scripts/cross-kernel/generations.mjs`**（唯一事实来源），
 * 不再写第二份列表。内核树缺失 → 该代报「未判定」，**不静默算过**。
 *
 * ## 与本插件（dsh-suggest-ghost）有关的四处必要改动
 *
 * dsh-later 的脚本是给**提醒类**插件写的，判据是「到点投递」（`schedule/change
 * operation:dispatch` + `agent/inbox/spliced`）。本插件**没有**注册任何命令
 * （`grep -rn 'commands' src/*.ts` 无命中），它是靠 `apply()` 往
 * `sessionProjections` 注册一个**投影单元**（`PROJECTION_KEY = 'suggestGhost'`，
 * `ctx.inject(['sessionProjections'])`）来工作的。所以：
 *
 * 1. **功能判据换了观测点**。本插件没有可派发的真实命令，硬套 `/user-schedule-create`
 *    只会测到"命令不存在"。这里改成观测它**真实的注册面**：装配后
 *    `sessionProjections` 上必须能查到 `suggestGhost` 单元，且我们必须确认
 *    `apply()` 真的跑了（`apply called; artifact mtime=…` 落痕），
 *    以及**跨代注册分支真的按代次形状走对**（0.1.2 起用 `stateSchema`+`wire.view`，
 *    之前用 `schema`+顶层 `view`——插件按 `cachedSnapshot` 探测代际，见 index.ts:2808）。
 *    这里我不看文本命中，而是**把注册进去的定义对象拿出来验形状**：
 *    形状对错是事件/对象形状，不是字符串。
 * 2. **at 文法五形状整段删除**。那是 dsh-later 的 `at` 解析回归，本插件不解析 `at`，
 *    照搬过来是纯粹的空转。
 * 3. **加了树身份戳（tree identity stamp）**。每代次在跑之前记下树的
 *    `stat` mtime 与 `@deepseek-ai` 条目数，跑完再复核一次；不一致 → 该代
 *    **未判定（tree mutated during run）**。这不是理论风险：本仓的 0.1.5-rc.1 树
 *    在 2026-10-23 17:2x–17:3x 之间被读到过不同形状，三个人先后给出过互相矛盾的
 *    "已验证"读数。CI 上比一次性跑重要得多。
 * 4. **不做假绿的双判**。本插件的 `engines.dsh` 覆盖 `0.1.7-rc.1`，但它的 7 个
 *    `@deepseek-ai/dsh-*` peer **一处都没枚举** `0.1.7-rc.1`。按 skill §0，
 *    ≤0.2.0 的内核只认 peer、`engines.dsh` 要到 0.2.1 起才单独决定（gate-runner
 *    在 `scripts/cross-kernel/out/gate.json` 里实测：只有 0.2.1-rc.2 的
 *    `evaluatePluginCompatibility` 读 `engines.dsh`，其余三代的
 *    `readsEnginesDsh=false`）。所以本脚本**不自己算准入判定**，而把
 *    每一代的判定语义标出来（`peer-only` / `engines.dsh`），避免把
 *    peer 语义的结论冒充成 engines.dsh 的结论。
 *
 * ## 沙箱决策（**明确决定：本插件在此处不加 unshare/容器，照 dsh-later 的强度跑**）
 *
 * dsh-later 的脚本只有目录级隔离（临时 `DSH_HOME` + 版本树软链 + 插件实体副本 +
 * 扫真实 `~/.dsh` 的越界自检），**没有** unshare、没有容器（其脚本内
 * `grep -c 'unshare\|docker'` = 0）。skill §6 说得很清楚：那个强度对"只写
 * `DSH_HOME` 内 sessions/storages/plugin-state 的插件"结论可信；对有**外发副作用**
 * 的插件（发 HTTP、spawn 子进程、`repoRoot` 指向真实仓库）**必须先加沙箱**，
 * 否则"回归"会改真实数据。
 *
 * 本插件的证据（本次核对，源码级）：
 *   - `grep -rn 'child_process|spawn|execSync|fetch(|http|axios' src/` → **0 命中**，
 *     即不 spawn 子进程、不发网络请求；
 *   - 唯一的 `node:fs` 用法是 `src/index.ts:387` 的
 *     `statSync(fileURLToPath(import.meta.url)).mtime` ——对**自己这份产物**做
 *     只读 stat，用来回答"现在跑的是哪份构建"，不写任何路径；
 *   - 持久化走宿主 `ctx.storageDomain`（`src/hotness-store.ts`），
 *     落点是 `$DSH_HOME/storages/`，即本轮临时目录内；没有绕过宿主直写
 *     `~/.dsh` 的路径；
 *   - 设置状态经 `ctx.settings`（同样在 `DSH_HOME` 内）。
 * **结论**：没有超出 `DSH_HOME` 的写入面，也没有外发副作用，属于 skill §6 明确
 * 认定"结论可信"的那一类。因此沿用目录级隔离是**有依据的决定**，不是省事；
 * 同时保留越界自检 + 新增树身份戳。**若本插件将来加了 HTTP/spawn 能力，
 * 这个决定必须重做**——那时"跑回归改真实数据"的风险是真的。
 *
 * ## 本脚本**没有**验证的东西（别把绿读成"这个插件在那一代能用"）
 *
 * 1. **没有跑真实的「回合结束 → 生成建议」**。那一步要模型（LLM 调用），
 *    成本与不确定性都高，且失败原因会混进内核/网络/模型三个方面。这里验证的是
 *    装配面（apply 真的跑了）与**注册面**（投影单元形状对不对）。
 *    也就是说：本脚本证明"插件挂得上、注册出来的形状自洽"，**不证明**"建议真的生成、
 *    真的推给客户端、Tab 真的能采纳"。后者仍要 e2e / 人工。
 * 2. **没有覆盖 client 侧**。`dsh.client` 声明的两个注入面
 *    （`dsh-client-ui-settings` / `dsh-client-ui-conversation`）在本脚本里**完全没测**：
 *    它只 boot 内核插件树，不构建/不加载 client bundle。
 *    某代次没发布过某个 client 包这类问题，本脚本**发现不了**。
 * 3. **没有覆盖 UI**。没有任何渲染/交互断言（那需要实例或容器 + 人看）。
 * 4. **没有做准入的双判结论**。脚本只**标注**这一代内核按哪份声明判准入
 *    （peer-only / engines.dsh），不替 gate-runner 下结论；准入判定以
 *    `scripts/cross-kernel/out/gate.json` 为准。
 * 5. **0.1.5-rc.1 不是干净的一代**：它的启动器是 0.1.5-rc.3（见 kernelTree 的
 *    `启动器版本≠代次` 备注）。所以"0.1.5-rc.1 GREEN"要读成
 *    「在被测树给出的装配下绿」，不是「0.1.5-rc.1 这一版逐字节验证通过」。
 *
 * @module dsh-suggest-ghost/verify-across-kernels
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { KERNEL_GENERATIONS, GENERATION_IDS } from './cross-kernel/generations.mjs';
// 留痕自 2026-10-26 起分级：默认只有 warn/error 到达用户侧（心跳类走 console.debug 静默）。
// 本脚本靠抓 `[ops-trace]` 文本断言行为，故在加载插件前把门槛放到 debug。
// 这是**测试自己开档**，不改生产默认。
process.env.DSH_SUGGEST_GHOST_TRACE ??= 'debug';

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt;
};
const ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..');
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const NAME = PKG.name;
const KERNEL_ROOT = resolve(opt('kernel-root', join(homedir(), 'dsh-versions')));
const OUT_DIR = resolve(opt('out', join(ROOT, 'scripts', 'cross-kernel', 'out')));
const given = (opt('versions', '') || '').split(',').map((x) => x.trim()).filter(Boolean);
const VERSIONS = given.length ? given : GENERATION_IDS;

/** worker 把结果 JSON 打在 stdout 的这个标记之后（前面允许有插件的 ops-trace 行）。 */
const WORKER_JSON_MARKER = '<<<GHOST-XK-WORKER-JSON>>>';

/**
 * 子进程 worker：在**被测那一代**内核里冷启动一次，装配本插件，回报
 *   - `applyRan`：stdout 里是否有 `apply called; artifact mtime=` 落痕（插件真的被装并被 apply）
 *   - `registered` / `shapes`：`sessionProjections.registrations` 里 `suggestGhost` 单元的形状
 *   - `events`：DSH_HOME 下的全部事件（判据只看形状）
 *
 * 为什么单独一个文件：插件用 `console.log` 打落痕（src/index.ts:372 明说这是运行期唯一
 * 可见面），只有把 boot 放进独立进程，这行才归属"被测插件的输出"而不是本脚本的输出。
 *
 * 这个源码是通过 `writeFileSync` 落到临时 DSH_HOME 里的，**不是**仓库里的第二个文件：
 * 它必须与宿主解析树同处一个 DSH_HOME 才能 import 到被测那一代的 `dsh-app-boot`。
 */
const WORKER_SOURCE = String.raw`
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [root, profile, pluginRoot, projectionKey] = process.argv.slice(2);
const nm = join(profile, 'node_modules');
const thisPlugin = join(nm, 'dsh-suggest-ghost');

/** 多帧 zstd 必须按帧 magic 切分逐帧解：zstdDecompressSync 只解第一帧。 */
function unzstdAllFrames(buf) {
  const MAGIC = [0x28, 0xb5, 0x2f, 0xfd];
  const cuts = [0];
  for (let i = 0; i + 4 <= buf.length; i += 1) {
    if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) cuts.push(i);
  }
  const parts = [];
  for (let k = 0; k < cuts.length; k += 1) {
    const from = cuts[k];
    const to = cuts[k + 1] ?? buf.length;
    if (to <= from) continue;
    try { parts.push(zstdDecompressSync(buf.subarray(from, to)).toString('utf8')); }
    catch (error) { parts.push('#frame' + k + ' 解码失败 ' + String(error.message).slice(0, 60)); }
  }
  return parts.join('\n');
}

/** 收集 DSH_HOME 下全部事件。 */
function readEvents(home) {
  const out = [];
  const stack = [home];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') stack.push(p); continue; }
      if (!/\.(jsonl|log)(\.zstd)?$/.test(e.name)) continue;
      try {
        if (statSync(p).size > 40 * 1024 * 1024) continue;
        const text = /\.zstd$/.test(e.name) ? unzstdAllFrames(readFileSync(p)) : readFileSync(p, 'utf8');
        for (const line of text.split('\n')) {
          if (!line.trim().startsWith('{')) continue;
          try { out.push(JSON.parse(line)); } catch { /* 非事件行跳过 */ }
        }
      } catch { /* 读不了就跳过 */ }
    }
  }
  return out;
}

const result = { ok: false, applyRan: false, registered: null, shapes: null, events: [], error: null };

// 「apply 落痕」判据：插件在 apply() 第一行打一条 ops-trace 落痕
// （src/index.ts:397，含 "apply called; artifact mtime=" 字样）。
// 这里**实时**监听自己的 stdout——不用事后读回，因为 stdout 是流；
// 记一行形状标志即可，不做业务正文匹配。
const APPLY_MARK = 'apply called; artifact mtime=';
const write = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...rest) => {
  if (String(chunk).includes(APPLY_MARK)) result.applyRan = true;
  return write(chunk, ...rest);
};
try {
  const home = process.env.DSH_HOME;
  const rootConfig = join(profile, 'cordis.yml');
  const off = join(home, 'off.patch.yml');
  const boot = await import(pathToFileURL(join(root, 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js')).href);
  // profile 必须交给**内核自己的** initProfile 初始化：它写 profile/package.json、
  // cordis.patch.yml、pnpm-workspace.yaml（且逐代次形状不同，手写会漂）。
  // 但它**不写** cordis.yml，而那正是 include 插件要找的根配置——补一行 空数组。
  try { boot.initProfile?.(profile, ['@deepseek-ai/dsh-base']); } catch { /* 个别代次无此导出，下面兜底 */ }
  if (!existsSync(rootConfig)) writeFileSync(rootConfig, '[]\n');
  const layers = [
    join(root, 'node_modules', '@deepseek-ai', 'dsh-base', 'cordis.patch.yml'),
    join(thisPlugin, 'cordis.patch.yml'),
    off,
  ];
  const patches = layers.flatMap((f) => existsSync(f) ? boot.loadOverlayPatches('dsh-ghost-xkernel', f) : []);
  const ctx = await boot.boot('dsh-ghost-xkernel', rootConfig, patches, (c) => {
    c.provide('profileContext', { name: 'x', dir: profile, patchPath: join(profile, 'cordis.patch.yml'), installAnchor: root, startedBundles: [], cwd: home, home, overlays: [] });
  });
  if (!ctx.agents) throw new Error('没有 ctx.agents（AgentRegistry 未装配）');

  const svc = ctx.get?.('sessionProjections') ?? null;
  const regs = svc?.registrations;
  const unit = regs instanceof Map ? regs.get(projectionKey) : undefined;
  const def = unit?.def ?? null;
  if (def) {
    const hasTopView = typeof def.view === 'function';
    const hasWireView = typeof def.wire?.view === 'function';
    const hasSchema = !!def.schema;
    const hasStateSchema = !!def.stateSchema;
    result.registered = { key: projectionKey, found: true, registrationCount: regs.size };
    result.shapes = {
      hasTopView, hasWireView, hasSchema, hasStateSchema,
      stateVersion: def.stateVersion ?? null,
      modernShape: hasStateSchema && hasWireView && !hasTopView,
      legacyShape: hasSchema && hasTopView && !hasStateSchema,
    };
  } else {
    result.registered = {
      key: projectionKey, found: false,
      registrationCount: regs instanceof Map ? regs.size : null,
      reason: regs instanceof Map ? 'registrations 里没有该 key' : 'sessionProjections.registrations 不是 Map（可能未组合）',
    };
  }
  result.events = readEvents(home);
  try { await ctx.fiber?.dispose?.(); } catch { /* 释放失败不改写结论 */ }
  result.ok = true;
} catch (error) {
  result.error = String(error?.message ?? error).slice(0, 220);
}
console.log('${WORKER_JSON_MARKER}' + JSON.stringify({ ...result, eventsCount: result.events.length, events: undefined }));
`;

/** 本插件的投影单元 key（与 src/domain.ts:106 的 PROJECTION_KEY 一致，测试里硬编码以便发现漂移）。 */
const PROJECTION_KEY = 'suggestGhost';

/**
 * 取该代次的内核安装树。
 * 与 dsh-later 的差异：核树台账**已铺好**，本仓默认不联网安装；`--no-install` 时缺树即未判定。
 * 另外这里**一并把启动器版本读出来**：0.1.5-rc.1 的顶层 app-boot 是软链，
 * 解析到 0.1.5-rc.3——只判 existsSync 会把它当"同版树"，那是假绿。
 */
function kernelTree(version) {
  if (version.startsWith('/')) return { root: version, note: null };
  const root = join(KERNEL_ROOT, version);
  const appBootPkg = join(root, 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'package.json');
  const dshPkg = join(root, 'node_modules', '@deepseek-ai', 'dsh', 'package.json');
  if (!existsSync(appBootPkg)) {
    if (argv.includes('--no-install')) return { root: null, note: `本地树不完整（缺 @deepseek-ai/dsh-app-boot/package.json）且 --no-install：${root}` };
    mkdirSync(root, { recursive: true });
    if (!existsSync(join(root, 'package.json'))) writeFileSync(join(root, 'package.json'), '{"private":true}\n');
    const r = spawnSync('npm', ['i', '--no-audit', '--no-fund', `@deepseek-ai/dsh@${version}`], { cwd: root, encoding: 'utf8', timeout: 420_000 });
    if (!existsSync(appBootPkg)) {
      const miss = String(`${r.stdout}${r.stderr}`).match(/No matching version found for (\S+)/);
      return { root: null, note: miss ? `该代次没有可安装的启动器：${miss[1]}` : `npm i 失败或未装出 app-boot：${String(r.stderr ?? '').split('\n').slice(-1)[0].slice(0, 120)}` };
    }
    return { root, note: '现场安装' };
  }
  let launcher = null;
  try { launcher = JSON.parse(readFileSync(appBootPkg, 'utf8')).version; } catch { /* 读不到就留 null */ }
  const note = launcher && launcher !== version ? `启动器版本≠代次（app-boot=${launcher}）` : null;
  return { root, note, launcher };
}

/**
 * 树身份戳：`stat` mtime + `@deepseek-ai` 条目数（+ 启动器版本）。
 * 跑之前与跑之后各取一次，用来发现"树在被安装/被改写"这类并发变更。
 */
function treeStamp(root) {
  const agentScope = join(root, 'node_modules', '@deepseek-ai');
  let mtimeMs = null;
  let entries = null;
  let launcher = null;
  try { mtimeMs = statSync(root).mtimeMs; } catch { /* 读不到留 null */ }
  try { entries = readdirSync(agentScope).length; } catch { /* 同上 */ }
  try { launcher = JSON.parse(readFileSync(join(agentScope, 'dsh-app-boot', 'package.json'), 'utf8')).version; } catch { /* 同上 */ }
  return { mtimeMs, entries, launcher };
}

const sameStamp = (a, b) => !!a && !!b && a.mtimeMs === b.mtimeMs && a.entries === b.entries && a.launcher === b.launcher;


async function runOne(version) {
  const meta = KERNEL_GENERATIONS.find((g) => g.id === version) ?? null;
  const { root, note, launcher } = kernelTree(version);
  if (!root) return { version, verdict: 'UNDETERMINED', notes: [note ?? '无内核树'] };

  // 跑之前的树身份戳。
  const stampBefore = treeStamp(root);
  const runtime = (() => {
    try { return JSON.parse(readFileSync(join(root, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8')).version; } catch { return null; }
  })();
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-ghost-xk-')));
  const profile = join(home, 'profiles', 'x');
  const nm = join(profile, 'node_modules');
  const record = { version, runtime, launcher, bootModel: meta?.bootModel ?? null, semanticsContract: null, projection: null, notes: [], treeStampBefore: stampBefore };
  try {
    mkdirSync(nm, { recursive: true });
    for (const entry of readdirSync(join(root, 'node_modules'))) {
      if (entry === '.bin' || entry.startsWith('.')) continue;
      const src = join(root, 'node_modules', entry);
      if (entry.startsWith('@')) {
        mkdirSync(join(nm, entry), { recursive: true });
        for (const child of readdirSync(src)) symlinkSync(join(src, child), join(nm, entry, child), 'dir');
        continue;
      }
      symlinkSync(src, join(nm, entry), 'dir');
    }
    // 插件放**实体副本**：直接挂仓库目录时插件目录就是解析根，它会 import 自己
    // node_modules 里那份宿主包，跨版本矩阵当场失真（"两份内核模块实例"）。
    const copy = join(nm, NAME);
    mkdirSync(copy, { recursive: true });
    for (const f of ['package.json', 'cordis.patch.yml', 'icon.svg']) if (existsSync(join(ROOT, f))) cpSync(join(ROOT, f), join(copy, f));
    for (const d of ['lib', 'locale', 'assets', 'docs']) if (existsSync(join(ROOT, d))) cpSync(join(ROOT, d), join(copy, d), { recursive: true });
    // 装配在**子进程**里做：插件把 apply 落痕用 console.log 打在 stdout（src/index.ts:372），
    // 而 stdout 是健康进程里唯一可见面。同进程 boot 会让这行混进本脚本的 stdout、
    // 无法当证据引用；交给子进程就能原样捕获，且一代次一进程，符合 skill §1
    // 「一次一进程、内存态不清零」，不给跨代次留串味的机会。
    // 内核装配需要的两份文件必须在 worker 起来**之前**写好（重构时漏过一次：
    // 少了它们，worker 里的 include 插件直接报 "config file not found"，整代假红）。
    //   - 根配置：空数组，代表"只要 loader 树，不要额外组合"；
    //   - off.patch.yml：hmr 行要求真实启动器给的 appReady，这里显式关掉，
    //     别把无关警告当故障。
    const rootConfig = join(profile, 'cordis.yml');
    writeFileSync(rootConfig, '[]\n');
    const off = join(home, 'off.patch.yml');
    writeFileSync(off, '- id: hmr\n  disabled: true\n');
    const workerFile = join(home, 'worker.mjs');
    writeFileSync(workerFile, WORKER_SOURCE);
    // `cwd: profile` 是必须的：内核的 `include` 插件按 **cwd** 解析相对路径，
    // 子进程默认继承本脚本的 cwd（仓库根），于是它去找
    // `<仓库>/profiles/x/cordis.yml` 而报 "config file not found"，
    // 整代装配就红在一个与插件无关的地方。dsh-later 是同进程 boot（cwd 恰好对），
    // 改成子进程后这一条必须显式补上。
    const wr = spawnSync(process.execPath, [workerFile, root, profile, ROOT, PROJECTION_KEY], {
      encoding: 'utf8', timeout: 240_000, cwd: profile,
      env: { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' },
    });
    const workerStdout = String(wr.stdout ?? '');
    const workerStderr = String(wr.stderr ?? '');
    record.workerExit = wr.status;
    record.workerStdoutTail = workerStdout.split('\n').filter(Boolean).slice(-6).join('\n').slice(0, 600);
    if (workerStderr.trim()) record.workerStderr = workerStderr.split('\n').filter(Boolean).slice(-4).join('\n').slice(0, 400);
    let WORKER = null;
    const marker = workerStdout.lastIndexOf(WORKER_JSON_MARKER);
    if (marker >= 0) {
      try { WORKER = JSON.parse(workerStdout.slice(marker + WORKER_JSON_MARKER.length).trim().split('\n')[0]); }
      catch (error) { record.notes.push(`worker 结果解析失败：${String(error.message).slice(0, 120)}`); }
    }
    if (!WORKER) {
      throw new Error(`worker 没有回报结果（exit=${wr.status}）${workerStderr ? `；stderr 末行：${workerStderr.split('\n').filter(Boolean).slice(-1)[0].slice(0, 160)}` : ''}`);
    }

    // ── 判据 1：装配面。插件真的被 loader 装进来、apply() 真的跑了。
    //
    // 注意观测面：`traceOps` 是 `console.log` → **stdout**（src/index.ts:372，
    // 注释明说 ctx.logger 在健康进程里一个字都不落盘），所以"apply 落痕"**不在**
    // DSH_HOME 的任何日志文件里。第一版脚本拿 readEvents(home) 找它，结果 7 代全报
    // "没落痕"——那是判据错，不是插件错（插件明明把 apply called 打在了 stdout，
    // 被本脚本继承的 stdout 直接可见）。这里改成从**子进程 stdout** 取，
    // 与真实运行面一致；形状判据仍然是"有没有这一行落痕"，不是搜业务正文。
    const applyRan = WORKER.applyRan;
    const loaderMounted = WORKER.applyRan; // loader 装上了才会跑 apply

    // ── 判据 2：投影注册面。这是本插件真正的功能入口（它没有注册命令）。
    //
    // 服务查法实测（0.2.0-rc.2）：`ctx.get('sessionProjections')` 返回 cordis Service，
    // 注册表在 `svc.registrations`，是 **Map<key, {def, cells, refs}>**——不是
    // `svc.get(key)`。第一版用 `reg.get(...)` 永远 undefined，7 代全报"未注册"；
    // 那是判据错，不是插件错。这里读 `registrations.get(PROJECTION_KEY).def` 验**形状**。
    let registered = WORKER.registered ?? { key: PROJECTION_KEY, found: false, reason: 'worker 未回报' };
    let shapes = WORKER.shapes ?? null;

    // ── 判据 3：真跑一次「回合结束 → 生成建议」需要模型，成本与不确定性都高，
    // 这里**不做**（见文件尾"未验证"一节）。本脚本只声明它验证了装配面与注册面。
    record.projection = { ...registered, shapes, applyRan, loaderMounted };

    // 双判语义标注：这一代的内核到底按哪份声明判准入。
    // 实测（gate-runner scripts/cross-kernel/out/gate.json）：只有 0.2.1-rc.2 的
    // evaluatePluginCompatibility 读 engines.dsh；其余 readsEnginesDsh=false。
    record.semanticsContract = (runtime ?? '').startsWith('0.2.1')
      ? { judgedBy: 'engines.dsh', readsEnginesDsh: true, scope: 'engines.dsh 单独决定（0.2.1 起）' }
      : { judgedBy: 'peer-only', readsEnginesDsh: false, scope: '该代内核不读 engines.dsh，只认 dsh-* peerDependencies（≤0.2.0）' };

    // 「peer 枚举里没有这一代」**不等于**「声明不支持这一代」，别把它写成缺陷。
    // 本仓 peer 写的是 `^0.1.1-rc.2 || ^0.1.2-rc.1 || ^0.1.5-rc.1 || ^0.1.7-rc.2 || ^0.2.0-rc.2`；
    // 用内核自己的 semver 按内核的匹配模式（includePrerelease）实测：
    //   ^0.1.1-rc.2 -> 0.1.7-rc.1 = true     ← **同一个范围就覆盖了**，只是没逐字写出来
    //   ^0.1.2-rc.1 -> 0.1.7-rc.1 = true
    //   ^0.1.5-rc.1 -> 0.1.7-rc.1 = true
    //   ^0.1.7-rc.2 -> 0.1.7-rc.1 = false
    //   ^0.2.0-rc.2 -> 0.2.1-rc.2 = true
    // 即 0.1.7-rc.1 与 0.2.1-rc.2 都被 `^0.1.1-rc.2` / `^0.2.0-rc.2` 的范围**匹配**，
    // 只是没逐字枚举。所以两份声明**一致**，此前那条"声明缺口"是假缺陷，已撤回。
    if (meta?.peerRange && !(PKG.peerDependencies?.['@deepseek-ai/dsh-session'] ?? '').includes(meta.peerRange.replace(/^\^/, ''))) {
      record.notes.push(`${version}：peer 未**逐字**枚举，但由 ^0.1.1-rc.2 / ^0.2.0-rc.2 的范围在 includePrerelease 下匹配（两份声明一致，非缺口）`);
    }

    try { await ctx.fiber?.dispose?.(); } catch { /* 释放失败不改写结论 */ }

    // 越界自检：任何本次产物出现在真实 ~/.dsh 里，就说明隔离没生效——大声失败并清干净。
    const leaked = [];
    const realSessions = join(homedir(), '.dsh', 'sessions');
    try {
      for (const top of readdirSync(realSessions, { withFileTypes: true })) {
        if (!top.isDirectory()) continue;
        const dir = join(realSessions, top.name);
        for (const kid of readdirSync(dir)) if (kid.startsWith('ghost-xk-') || kid.startsWith('xk-')) leaked.push(join(dir, kid));
      }
    } catch { /* 目录不存在就是没泄漏 */ }
    if (leaked.length) {
      record.notes.push(`隔离失效：本次会话写进了真实 DSH_HOME（${leaked.length} 个），已删除：${leaked.join(', ').slice(0, 160)}`);
      for (const p of leaked) rmSync(p, { recursive: true, force: true });
      const tops = new Set(leaked.map((p) => dirname(p)));
      for (const t of tops) { try { if (readdirSync(t).length === 0) rmSync(t, { recursive: true, force: true }); } catch { /* 忽略 */ } }
      record.leak = true;
    }
  } catch (error) {
    record.assemblyError = `装配失败：${String(error?.message ?? error).slice(0, 220)}`;
    record.notes.push(record.assemblyError);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }

  // 跑之后的树身份戳：树在跑动期间被改写 → 未判定，绝不绿。
  const stampAfter = treeStamp(root);
  record.treeStampAfter = stampAfter;
  const stable = sameStamp(stampBefore, stampAfter);
  record.treeStable = stable;
  if (!stable) {
    record.verdict = 'UNDETERMINED';
    record.notes.unshift(`树在跑动期间被改写（tree mutated during run）：before=${JSON.stringify(stampBefore)} after=${JSON.stringify(stampAfter)}`);
    return record;
  }
  if (note) record.notes.unshift(note);

  const p = record.projection ?? {};
  const assemblyOk = !!p.applyRan;
  const projectionOk = !!p.found && !!(p.shapes?.modernShape || p.shapes?.legacyShape);
  record.verdict = (record.leak || record.assemblyError) ? 'RED' : (assemblyOk && projectionOk ? 'GREEN' : 'RED');
  if (!assemblyOk) record.notes.push('apply() 没有落痕（插件可能没被装配）');
  if (!p.found) record.notes.push(`投影单元 ${PROJECTION_KEY} 未在 sessionProjections 上注册（${p.reason ?? '未知'}）`);
  else if (!projectionOk) {
    // 这不是"插件没装"，而是**注册出来的单元形状不自洽**：stateSchema/wire 两个槽位
    // 都在（own property 存在，descriptor 是 value），但**值都是 undefined**。
    // 本次实测把因果钉到了内核源码一级：
    //   1. 插件用 `typeof registry.cachedSnapshot === 'function'` 探测代际
    //      （src/index.ts:2808 `const is02 = ...`），选到 legacy 分支 → 只传 `schema` + 顶层 `view`。
    //   2. 0.1.1-rc.2 的注册**接受** legacy 形状、不抛错：它的
    //      `dsh-session-projection/lib/index.js:51-62` 归一化时只读
    //      `definition.stateSchema` 与 `definition.wire`——两个都不在 legacy 对象上，
    //      于是被写成 `undefined`，产出一个"有槽位、无内容"的单元。
    //   3. 该成员在本代**确实不存在**：`cachedSnapshot` 不在 0.1.1-rc.2 的
    //      `dsh-session-projection`（grep 计数 0），它定义在
    //      `dsh-session-projection-cache/lib/index.js:140`；而 0.1.1-rc.2 的
    //      `dsh-base/cordis.patch.yml` 只挂 `dsh-session-projection`，不挂 cache 包。
    //      0.1.2-rc.1 则在 registry 上就有 `cachedSnapshot`（同文件 :165，grep 计数 1）
    //      → 探测按现代分支走 → 形状自洽。**这就是 0.1.1-rc.2 与其余六代的分界。**
    // 观测原始值：stateSchema/wire 的 descriptor 均为「value: undefined」，
    // 故 `'stateSchema' in def === true` 而 `def.stateSchema === undefined`；
    // 宿主同代的单元（如 `title`）wire.view 正常——所以是插件传错了形状，不是内核缺能力。
    // 注意措辞：这是**注册面**的红，未证明真实回合会因此失败（那需要模型）。
    record.notes.push(`投影单元形状不自洽（stateSchema/wire 槽位存在但值均 undefined；宿主同代单元是 wire.view 现代形状）：${JSON.stringify(p.shapes)}`);
    record.notes.push('成因（源码级）：插件的 cachedSnapshot 代际探测在本代取到 undefined（该成员在 dsh-session-projection-cache，本代未挂载），误选 legacy 分支；registry 归一化只读 stateSchema/wire，二者缺位即被写成 undefined');
  }
  return record;
}

console.log(`${NAME}@${PKG.version} · 跨内核回归 · 代次取自 scripts/cross-kernel/generations.mjs（${VERSIONS.length} 个）`);
console.log('沙箱决策：不加 unshare/容器（本插件无 spawn/无网络、唯一 fs 用法是对自身产物只读 stat；详见脚本头）。');
const results = [];
for (const v of VERSIONS) {
  process.stdout.write(`\n### ${v} … `);
  const r = await runOne(v);
  results.push(r);
  if (r.verdict === 'UNDETERMINED') { console.log('未判定'); for (const n of r.notes) console.log(`      · ${n}`); continue; }
  console.log(r.verdict === 'GREEN' ? 'GREEN' : 'RED');
  const sh = r.projection?.shapes;
  console.log(`    内核=${r.runtime} · 启动器=${r.launcher} · 契约=${r.semanticsContract?.judgedBy} · apply落痕=${r.projection?.applyRan ? 'Y' : 'N'} · 投影=${r.projection?.found ? 'Y' : 'N'}${sh ? `（${sh.modernShape ? 'modern:stateSchema+wire.view' : sh.legacyShape ? 'legacy:schema+view' : '形状不明'}）` : ''}`);
  console.log(`    树戳=${r.treeStampBefore?.entries} 项 / mtime=${r.treeStampBefore?.mtimeMs}`);
  for (const n of r.notes) console.log(`      · ${n}`);
}
mkdirSync(OUT_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const file = join(OUT_DIR, `across-kernels-${stamp}.json`);
writeFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), versions: VERSIONS, sandboxDecision: 'no-unshare-no-container (justified in script header)', results }, null, 2)}\n`);
// ---- 准入门禁（admission gate）必须在这一条合并入口里跑 ----
// 上面那段 verdict 量的是**装配 + 投影**（插件起不起来、投影有没有落），它**不调
// evaluatePluginCompatibility** ⇒ 在 peers-only 的代次（≤0.2.0）上，一个会被内核**直接拒绝装载**
// 的 manifest 照样能跑到 GREEN。**#110 就是这么静默进 main 的**：三条 RED 只有 gate-matrix 看得见。
// ⇒ 从这条起，改依赖/peer 面一定会被这道子进程闸拦住；`gate-matrix.mjs --self-test` 里另有
//   「把那条 peer 声明原样加回去 ⇒ 门禁必须拒绝」的**可证伪**断言，所以这不是数条目数的假绿闸。
const gateRun = (() => {
  const r = spawnSync(
    process.execPath,
    [join(ROOT, 'scripts', 'cross-kernel', 'gate-matrix.mjs')],
    { cwd: ROOT, encoding: 'utf8', timeout: 420_000, env: { ...process.env, DSH_TELEMETRY_DISABLED: '1' } },
  );
  const text = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const exitMatch = text.match(/EXIT (\d+)/);
  return {
    exit: exitMatch ? Number(exitMatch[1]) : 2,
    red: (text.match(/^\s*\[RED\]/gm) ?? []).length,
    und: (text.match(/^\s*\[UNDETERMINED\]/gm) ?? []).length,
    lines: text.split('\n').filter((l) => /^\[(GREEN|RED|UNDETERMINED)\]/.test(l.trim()) || /^EXIT/.test(l.trim())),
  };
})();
console.log('');
console.log('准入分面（gate-matrix.mjs，用各代自己的 evaluatePluginCompatibility）：');
for (const l of gateRun.lines) console.log(`  ${l.trim()}`);
if (gateRun.exit !== 0) console.log(`  ⇒ 门禁分面 EXIT=${gateRun.exit}：RED = 声明支持但内核拒绝装载 ⇒ 整条命令判红`);

const red = results.filter((r) => r.verdict === 'RED').length;
const und = results.filter((r) => r.verdict === 'UNDETERMINED').length;
console.log(`\n汇总：绿 ${results.length - red - und} / 红 ${red} / 未判定 ${und}；明细 ${file}；`
  + `门禁分面 红 ${gateRun.red} / 未判定 ${gateRun.und}（EXIT=${gateRun.exit}）`);
// 退出码口径（技能 §2：0 全绿 / 1 有红 / 2 有未判定）——**红必须压过未判定**：
// 反证实测（task-41）：把那条 peer 声明加回去之后，本条命令报"红 3"却退出 2，
// 因为原来按 max() 合成，2 把 1 盖住了 ⇒ "有红"被读成"只是没测到"。
// 那是闸的口径缺陷，不是小事：合并门禁只看非零的话还能过，但 CI 里"1 要修 / 2 要等"会分错。
const anyRed = red > 0 || gateRun.red > 0;
const anyUnd = und > 0 || gateRun.und > 0 || gateRun.exit >= 2;
process.exit(anyRed ? 1 : anyUnd ? 2 : 0);
