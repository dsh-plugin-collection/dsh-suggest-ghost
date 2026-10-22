#!/usr/bin/env node
/**
 * 一次性隔离的 DSH 第二实例（插件开发回路工具）。
 *
 * ## 为什么需要它
 *
 * 插件宿主层改动要生效，默认得重启 DSH —— 而重启会打断人正在跑的会话，于是"改完等重启"
 * 一轮一轮地烧时间。本脚本起一个独立实例，隔离做在两层：
 *
 * 1. `DSH_HOME` 独立 → `sessions` / `storages` / `logs` 全落进沙箱目录。实测 `dshHomePath()`
 *    认这个环境变量（`dsh-home-paths/lib/index.js:73-84`），所以不会写到真实家目录。
 * 2. **插件产物也独立**：沙箱里 `node_modules/<本包名>` 指向一份私有副本，其余依赖逐条软链到
 *    真实 profile 的 node_modules，**不跑 install**（几秒建好、不吃磁盘）。这层是必须的：否则往
 *    沙箱放未验证构建，会污染 live 宿主下次重启真正加载的那份 `lib/`。
 *
 * ## 通用性：脚本不含插件专有知识
 *
 * 插件身份从当前仓 `package.json` 的 `name` 推导；profile 里的条目 id 再用 `name: <包名>` 反查
 * （或 `--entry` 指定）。仓特定的东西（要改的端口、要关的顶层条目、验收该 grep 什么）放进该仓
 * `package.json` 的 `sandbox` 字段，命令行可叠加覆盖：
 *
 * ```json
 * "sandbox": {
 *   "entry": "suggest-ghost",
 *   "rewrites": ["port: 3081=port: 3983"],
 *   "disable": ["our-free-model"],
 *   "greps": ["apply called; artifact mtime=", "completion generated", "push landed"]
 * }
 * ```
 *
 * ## 两条会让"量出来的数据"骗人的使用坑（实测）
 *
 * - 不带 `--deploy` 会 `rmSync(HOME_)` 整体重建并从仓里拷 `lib/`，所以**手改沙箱私有产物再重启
 *   会被冲掉**。要做 A/B（例如临时压小超时值验证超时路径），先拷一份 deploy 源目录、改它、再用
 *   `--deploy <那个目录>`；启动后回读 `plugin/lib` 里的实际值，确认了才认数据。
 * - 启动时打印的 `dsh web:` URL 可能取自日志里的**旧**行（日志是追加写的，上一轮的行还在）。
 *   真实端口要用 pid 去 `ss -ltnp` 对。
 *
 * ## 收尾：一条命令（Gitea #72）
 *
 * 沙箱会留下**两处**东西：沙箱目录（`--home`，默认 `~/dsh-sbx-<entry>`）与**工作区**
 * （`--ws`，默认 `<--home>/ws`）。工作区默认**收在沙箱目录内部** ⇒ 删沙箱目录就一并带走。
 * 这条是 #72 的结论：旧默认把工作区放在 `~/dsh-sbx-<entry>-ws`（**不在 `--home` 里**）⇒
 * `rm -rf $SBX` 带不走它 ⇒ 每次用完都留下一个目录（**里面可能有凭据副本**）⇒ 「清掉了
 * 还会再长出来」的根因之一；而且只看「`~/dsh-sbx*` 残留 0」就以为清干净了，其实工作区
 * 还在另一个名字下。
 *
 * ```bash
 * node scripts/dev-sandbox.mjs --cleanup     # 收尾：停实例 → 体检并删工作区 → 删沙箱目录 → 残留自检
 * node scripts/dev-sandbox.mjs --residual    # 只做残留自检（只读，不删任何东西）
 * ```
 *
 * `--cleanup` 的输出会**逐处**说明它动了哪里：删了哪两处、哪一处因为**脏/认不出**而
 * **没删**（⇒ 退出码 1，不静默跳过）。删除工作区前必过两道闸：**确实是本沙箱建的**
 * （本脚本的标记文件，或空 git 仓签名）+ **干净**（`git status --porcelain` 为空）；
 * 有提交历史或含凭据副本的一律交给人判断（凭据只读键名，不打印值）。
 *
 * ⚠️ 工作区默认在沙箱目录**内部** ⇒ 它脏的时候**连沙箱目录也不删**（删它等于间接删掉
 * 别人的工作区）——这时 `--cleanup` 会明确报出来，处理掉那个工作区再跑一次即可。
 *
 * ⚠️ **验这条命令时取退出码不要在管道后面读 `$?`**：`cmd | head -3; echo $?` 读到的是
 * `head` 的退出码（0），不是被验命令的 ⇒ 会把「护栏没生效」读成「通过」（本轮真踩过：
 * 差点把一条没生效的护栏当成生效记进 CHANGELOG）。用 `cmd > file; echo $?` 或
 * `${PIPESTATUS[0]}`。同一条口径见 `docs/gitea-workflow.md`。
 *
 * ## 三条实测踩过的坑（改回去就会再踩，实现里都留了注释）
 *
 * 1. **profile 里的 volatile 值是跨多行的单引号标量**（本仓 `_push` 实测跨 16~35 行，里面存着
 *    建议正文）。按行 `grep -v` / 逐行删会把续行留给下一个键，直接改坏 profile：
 *    `historyMinChars expected number but got 3 A","truncated":false,…` → 条目不挂载。
 *    所以剥离一律**按缩进整块删**，且只删本插件条目名下的 `_` 前缀键（别人的 `_x` 可能有意义）。
 * 2. **`--gui-port` 只管主 GUI 端口**，profile 里被别的插件钉死的监听端口照样会 `EADDRINUSE`；
 *    webServer 服务缺失会让实例在跑第一个 agent 回合时静默退出。所以脚本扫副本里全部
 *    `port: <n>`，只要有一个被占就拒绝启动并列出该用什么 `--rewrite` 换掉。替换按**整行相等**
 *    匹配：用 `/port: 3081$/` 这种没加 `m` 标志的正则，会在该行不在文件末尾时静默不生效（踩过，
 *    而且当时"端口已改"的提示是无条件打印的假话）。
 * 3. **group 成员条目关不掉**：`--patch` 叠加层对顶层条目生效，对嵌在 `group: true` 条目 `config:`
 *    列表里的成员无效（实测指 group 与指叶子都无效）。这类只能改端口/配置绕开。
 *
 * ## 用法
 *
 * ```
 * node scripts/dev-sandbox.mjs                  # 建沙箱并后台启动（读仓内 sandbox 配置）
 * node scripts/dev-sandbox.mjs --check          # 只合成校验，不启动
 * node scripts/dev-sandbox.mjs --deploy <dir>   # 把某 worktree 构建的 lib/ 装进沙箱
 * node scripts/dev-sandbox.mjs --home ~/sbx --watch --rewrite 'port: 8080=port: 8081'
 * ```
 *
 * `--watch` 打开宿主层源码热重载（只盯本插件私有产物目录）。触发要**真改内容**：只 `touch` 换
 * mtime 不产生第二次 `apply called`（实测）。判据就是那行 `artifact mtime=` 变没变 —— 没变说明
 * 进程还在跑旧字节，这一轮的观察一概不算（issue #20 的根子）。
 *
 * ⚠️ 依赖"在 `apply()` 期建立的异步上下文"才能工作的东西（例如本仓 #22 的事务外排水 pump）**不能
 * 用热重载验证**：HMR 的 `partialReload` 跑在 `runExclusive → executing.run(true, …)` 里，那样建
 * 出来的定时器仍带 `store=true`。这类必须整进程重启。
 */
import { execFileSync, spawn } from 'node:child_process';
import {
  chmodSync, closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, openSync,
  readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt;
};
const flag = (name) => argv.includes(`--${name}`);

/** 可重复参数（`--rewrite a=b --rewrite c=d` / `--disable x` / `--grep y` / `--strip k`）。 */
export function collect(list, name) {
  /** @type {string[]} */
  const out = [];
  for (let i = 0; i < list.length; i += 1) {
    if (list[i] === `--${name}` && list[i + 1] !== undefined) { out.push(list[i + 1]); i += 1; }
  }
  return out;
}

/**
 * 读当前仓配置：包名 + `sandbox` 字段。脚本的通用性靠它 —— 插件专有值不进脚本本体。
 * @param {string} repo @returns {{pkgName: string, cfg: Record<string, any>}}
 */
export function readRepoConfig(repo) {
  const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
  if (typeof pkg.name !== 'string' || pkg.name === '') throw new Error(`${repo}/package.json 缺 name`);
  return { pkgName: pkg.name, cfg: pkg.sandbox ?? {} };
}

/**
 * 按缩进整块删除一个 YAML 键（键行 + 比它更深缩进的全部续行）。
 * @param {string} text @param {string} key @returns {{text: string, removed: number}}
 */
export function stripKeyBlock(text, key) {
  const lines = text.split('\n');
  /** @type {string[]} */
  const out = [];
  let i = 0;
  let removed = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim().startsWith(`${key}: `)) {
      const indent = line.length - line.trimStart().length;
      let j = i + 1;
      while (j < lines.length) {
        const nxt = lines[j];
        if (nxt.trim() === '') { j += 1; continue; }
        if (nxt.length - nxt.trimStart().length > indent) { j += 1; continue; }
        break;
      }
      removed = j - i;
      i = j;
      continue;
    }
    out.push(line);
    i += 1;
  }
  return { text: out.join('\n'), removed };
}

/**
 * 只剥**指定条目名下**的易失键（默认：键名以 `_` 开头），别的条目一概不碰。
 *
 * 为什么不全局删 `_ops`/`_push`：那是某个插件的键名；别的插件条目里的 `_x` 键可能是有意义的
 * 配置，全局删等于顺手改了别人的状态。
 * @param {string} text @param {string} entryId
 * @param {(key: string) => boolean} [isVolatile]
 * @returns {{text: string, removed: Array<{key: string, lines: number}>}}
 */
export function stripEntryVolatileKeys(text, entryId, isVolatile = (k) => k.startsWith('_')) {
  const lines = text.split('\n');
  /** @type {Array<{key: string, at: number, end: number}>} */
  const found = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^(\s*)- id:\s*(\S+)\s*$/.exec(lines[i]);
    if (m === null || m[2] !== entryId) continue;
    const entryIndent = m[1].length;
    let j = i + 1;
    while (j < lines.length) {
      const line = lines[j];
      if (line.trim() === '') { j += 1; continue; }
      const indent = line.length - line.trimStart().length;
      if (indent <= entryIndent) break; // 回到同级/更浅 = 已出条目
      const kv = /^([A-Za-z0-9_-]+): /.exec(line.trim());
      if (kv !== null && isVolatile(kv[1])) {
        let k = j + 1;
        while (k < lines.length) {
          const nxt = lines[k];
          if (nxt.trim() === '') { k += 1; continue; }
          if (nxt.length - nxt.trimStart().length > indent) { k += 1; continue; }
          break;
        }
        found.push({ key: kv[1], at: j, end: k });
        j = k;
        continue;
      }
      j += 1;
    }
    break; // 同名条目只处理第一处
  }
  const drop = new Set();
  for (const f of found) for (let n = f.at; n < f.end; n += 1) drop.add(n);
  return { text: lines.filter((_, n) => !drop.has(n)).join('\n'), removed: found.map((f) => ({ key: f.key, lines: f.end - f.at })) };
}

/**
 * 解析 `--rewrite '旧整行=新整行'`。整行 trim 相等匹配，不用正则（`$` 少 `m` 标志那次静默失效）。
 * @param {string[]} specs @returns {Array<{from: string, to: string}>}
 */
export function parseRewrites(specs) {
  return specs.map((spec) => {
    const i = spec.indexOf('=');
    if (i <= 0) throw new Error(`--rewrite 需要 '旧行=新行' 形式，收到 ${JSON.stringify(spec)}`);
    return { from: spec.slice(0, i).trim(), to: spec.slice(i + 1).trim() };
  });
}

/**
 * 应用整行替换；命中数交回调用方决定去留（0 命中必须拒绝启动：静默不替换比报错坏）。
 * @param {string[]} lines @param {Array<{from: string, to: string}>} rules
 * @returns {{lines: string[], hits: number[]}}
 */
export function applyRewrites(lines, rules) {
  const hits = rules.map(() => 0);
  const out = lines.map((line) => {
    let next = line;
    rules.forEach((r, k) => {
      if (next.trim() === r.from) { hits[k] += 1; next = next.replace(r.from, r.to); }
    });
    return next;
  });
  return { lines: out, hits };
}

/**
 * 副本里钉死的监听端口（`port: <n>` 整行）。
 * @param {string[]} lines @returns {number[]}
 */
export function declaredPorts(lines) {
  const out = new Set();
  for (const line of lines) {
    const m = /^\s*port:\s*(\d+)\s*$/.exec(line);
    if (m !== null) out.add(Number(m[1]));
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * 按包名在 profile 里反查条目 id（`- id: X` 后数行内出现 `name: <pkgName>`）。
 * @param {string} patchText @param {string} pkgName @returns {string | null}
 */
export function findEntryId(patchText, pkgName) {
  const lines = patchText.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^(\s*)- id:\s*(\S+)\s*$/.exec(lines[i]);
    if (m === null) continue;
    for (let j = i + 1; j < Math.min(i + 6, lines.length); j += 1) {
      if (lines[j].trim() === `name: ${pkgName}`) return m[2];
    }
  }
  return null;
}

/**
 * 找出**属于某个 DSH_HOME** 的进程（按 `/proc/<pid>/environ` 里的 `DSH_HOME` 认领）。
 *
 * 为什么不用 pidfile 认领：pidfile 里可能是 npx 包装进程的 pid（实测踩过三次：按它
 * kill 之后真正的 node 子进程还活着占着端口 ⇒ 误判成「沙箱已停」）。按 DSH_HOME 反查
 * 认的是**整棵进程树**，且天然只认自己的（别的沙箱/live 宿主的 DSH_HOME 不同）。
 *
 * @param {string} home - 要认领的 DSH_HOME 绝对路径。
 * @returns {{ pid: number, cmd: string }[]}
 */
function pidsOfHome(home) {
  let out = '';
  try { out = execFileSync('sh', ['-c', 'ls /proc | grep -E "^[0-9]+$"'], { encoding: 'utf8' }); }
  catch { return []; }
  const mine = [];
  for (const p of out.split('\n')) {
    const n = p.trim();
    if (n === '') continue;
    let e = '';
    try { e = readFileSync(`/proc/${n}/environ`, 'utf8'); } catch { continue; }
    if (e.split('\0').includes(`DSH_HOME=${home}`)) {
      try { mine.push({ pid: Number(n), cmd: readFileSync(`/proc/${n}/cmdline`, 'utf8').replace(/\0/g, ' ').trim() }); }
      catch { /* 已退出 */ }
    }
  }
  return mine;
}

// 只有直接执行才跑主流程：否则 `import { stripKeyBlock }` 会顺手起一个实例，纯函数就没法测。
const invokedDirectly = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) main();

function main() {
  const say = (m) => console.log(`  ${m}`);
  const die = (m) => { console.error(`dev-sandbox: ${m}`); process.exit(1); };
  const lstatSafe = (p) => { try { lstatSync(p); return true; } catch { return false; } };
  const portInUse = (port) => {
    try { return execFileSync('ss', ['-ltnH', `( sport = :${port} )`], { encoding: 'utf8' }).trim().length > 0; }
    catch { return false; }
  };

  let REPO = opt('repo', '');
  if (REPO === '') {
    try { REPO = execFileSync('git', ['-C', process.cwd(), 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim(); }
    catch { REPO = resolve(dirname(dirname(new URL(import.meta.url).pathname))); }
  }
  REPO = resolve(REPO);
  let conf;
  try { conf = readRepoConfig(REPO); } catch (error) { die(String(error)); }
  const { pkgName, cfg } = conf;
  const entryCfg = String(opt('entry', String(cfg.entry ?? '')));
  const short = (entryCfg || pkgName.split('/').pop() || pkgName).replace(/^dsh-/, '');

  const HOME_ = resolve(opt('home', join(homedir(), `dsh-sbx-${short}`)));
  /**
   * 工作区目录（**本仓口径：收在沙箱目录内部**，Gitea #72）。
   *
   * #72 的结论：旧默认把工作区建在 `~/dsh-sbx-<entry>-ws`（**不在 `--home` 里**）⇒
   * `rm -rf $SBX` 带不走它 ⇒ 每次用完沙箱都留下一个目录，而那个目录里可能有凭据副本
   * ⇒ 「清掉了还会再长出来」的根因之一；而且只看「`~/dsh-sbx*` 残留 0」就以为清干净了，
   * 其实工作区还在另一个名字下。
   *
   * **为什么可以收进来（选 (b) 而不是 (a) 的依据）**：
   *  - 它与 `--deploy <dir>` **毫无关系**：那条路装的是 `opt('deploy')` 指向的**某个
   *    worktree** 里的 `lib/`，复制到 `join(HOME_, 'plugin')/lib`（全程在 `--home` 内），
   *    从不碰 WS ⇒ (b) 不会把「用户指定的部署源」和「沙箱自建的副本」混在一棵树里。
   *  - WS 的**真实用途是别的脚本的夹具**：`scripts/hot-yield-ratio.mjs` 往里写
   *    `note.txt`、再把路径打进 client 的「工作区选择器」（它**显式传 `--ws`**，
   *    不受这里的默认值影响；它自己也管这个目录的生死）。
   *  - dev-sandbox 自己对 WS **只创建不使用**（历史上三个版本都只有 `mkdir` + `git init`）
   *    ⇒ 收进 `--home` 不丢任何功能。
   *
   * ⚠️ 因此**显式传 `--ws <dir>` 的用法不变**（那是调用方自己的目录，本脚本只保证它
   * 存在；收尾时也只有「确实是本沙箱建的且干净」才会删，见 `--cleanup`）。
   */
  const WS = resolve(opt('ws', join(HOME_, 'ws')));
  /**
   * 旧默认位置（#72 之前）：收尾时要**一并查**——老版本留下的目录不会自己消失，
   * 而它恰好是「`~/dsh-sbx*` 为 0 却没清干净」的那个漏网之处。
   */
  const WS_LEGACY = resolve(join(homedir(), `dsh-sbx-${short}-ws`));
  const GUI_PORT = String(opt('gui-port', '0'));
  const PROFILE = join(HOME_, 'profiles', 'web');
  const PLUGIN = join(HOME_, 'plugin');
  const LIVE_PROFILE = resolve(opt('live-profile', join(homedir(), '.dsh', 'profiles', 'web')));
  const LIVE_NM = resolve(opt('live-nm', join(LIVE_PROFILE, 'node_modules')));

  let rules;
  try { rules = parseRewrites([...asArray(cfg.rewrites), ...collect(argv, 'rewrite')]); }
  catch (error) { die(String(error)); }
  const disables = [...asArray(cfg.disable), ...collect(argv, 'disable')];
  const greps = [...asArray(cfg.greps), ...collect(argv, 'grep')];
  const extraStrip = collect(argv, 'strip');
  /** @param {unknown} v @returns {string[]} */
  function asArray(v) { return Array.isArray(v) ? v.map(String) : []; }

  if (GUI_PORT !== '0' && portInUse(Number(GUI_PORT))) die(`--gui-port ${GUI_PORT} 已被占用`);

  // ── 收尾与残留自检（#72）────────────────────────────────────────────────────
  //
  // `--cleanup`：**只收尾，不建沙箱、不启实例**（收尾前跑一次正常启动会把刚建的沙箱
  // 又删一遍，那不是收尾）。它做四件事，输出必须让人看出**它动了哪两处**：
  //   ① 停实例（只杀 DSH_HOME 认领到的那些 ⇒ 不会误杀 live 宿主或别人的沙箱）；
  //   ② 体检工作区（**不许删别人的工作区**：见下面两道闸），能删才删；
  //   ③ 删沙箱目录（工作区默认在里面 ⇒ 它脏时这一步也要停手）；
  //   ④ 残留自检：**两处**都查（`~/dsh-sbx*` 与 `~/dsh-sbx-*-ws`）。
  //
  // `--residual`：只做 ④（只读，不删任何东西）——用来回答「到底清干净了没」。
  const WS_MARKER = '.dsh-sandbox-ws';
  const CREDENTIAL_FILES = ['.credentials.yaml', 'env.local'];

  /**
   * 凭据文件里的**键名**（只取顶层键；值一律不进输出）。
   *
   * 口径见 `docs/real-session-harness.md` §6：**只读键名，不打印任何值**。
   */
  const credentialKeyNames = (file) => {
    try {
      const keys = [];
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        const m = /^([A-Za-z0-9_][A-Za-z0-9_.\-]*):/.exec(line);
        if (m !== null) keys.push(m[1]);
      }
      return keys;
    } catch { return []; }
  };

  /**
   * 工作区体检：是不是本沙箱建的、干净不干净、有没有凭据副本。
   *
   * **三道闸**（#72 的硬要求：不许删别人的工作区）：
   *  ① 「确实是本沙箱建的」：有本脚本写的标记文件，或**空仓签名**。
   *  ② 「干净」：`git status --porcelain` 为空（**只有同名**的标记文件不算脏）。
   *  ③ 「里面没有别人的东西」：无提交历史、无远端、无凭据副本。
   *
   * ⚠️ **fail-closed**：任何**查不出来**的情况一律判「无法确认 ⇒ 拒绝删除」，**绝不**
   * 当成「干净」。上一版把 `git status` 抛错读成「工作树里没有别的文件」⇒ index.lock /
   * 索引损坏 / 权限问题会把「没检查成」变成「检查通过」——删的可是带凭据副本的目录，
   * 这种方向错不得（fail-open ⇒ 删掉别人的东西；fail-closed ⇒ 最多多留一个目录）。
   * ⇒ 「空仓签名」因此改用**文件系统**判定（目录里**只有** `.git` 外加可选的标记文件
   * 才算空），这与判据的字面意思一致；「有提交」也改用文件系统判定（`refs/heads` 或
   * `packed-refs`），不拿 git 的失败当「没有」。
   */
  const inspectWorkspace = (dir) => {
    const info = {
      dir, exists: false, ours: false, clean: false, hasCommit: false, hasRemote: false,
      unverifiable: false, deletable: false, why: '', dirty: [], credentialFiles: [], credentialKeys: [],
    };
    if (!lstatSafe(dir)) return info;
    info.exists = true;
    // ── 文件系统事实：目录里到底有什么（readdir 失败 ⇒ 无法确认 ⇒ 拒）──
    let entries = null;
    try { entries = readdirSync(dir); } catch { entries = null; }
    if (entries === null) {
      info.unverifiable = true;
      info.why = '目录读不出来（权限？）⇒ 无法确认，拒绝删除';
      return info;
    }
    const gitPath = join(dir, '.git');
    let gitStat = null;
    try { gitStat = lstatSync(gitPath); } catch { gitStat = null; }
    if (gitStat !== null && !gitStat.isDirectory()) {
      info.unverifiable = true;
      info.why = '`.git` 是文件（worktree 指针）⇒ 里面可能连着别的仓，不删';
      return info;
    }
    const hasMarker = lstatSafe(join(dir, WS_MARKER));
    // 「空仓签名」：**只有** `.git`（外加可选的标记文件）⇒ 别的什么都不算。
    const others = entries.filter((n) => n !== '.git' && n !== WS_MARKER);
    const emptyByFs = others.length === 0;
    // ── git 的回答：**失败 = 无法确认**，不是「干净」 ──
    let isRepo = true;
    try { execFileSync('git', ['-C', dir, 'rev-parse', '--git-dir'], { stdio: 'ignore' }); }
    catch { isRepo = false; }
    if (!isRepo) {
      info.unverifiable = true;
      info.why = '不是 git 仓（无法确认是本沙箱建的）⇒ 不删';
      return info;
    }
    let porcelain = null;
    try { porcelain = execFileSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8' }); }
    catch { porcelain = null; }
    if (porcelain === null) {
      info.unverifiable = true;
      info.why = 'git 检查失败（index.lock / 索引损坏 / 权限？）⇒ 无法确认，拒绝删除';
      return info;
    }
    // porcelain 的行是 `XY <path>`；**只**放过 basename **正好**是标记文件的那一个
    // （用 endsWith 会连带放过 `foo.dsh-sandbox-ws` 这种别的路径 ⇒ 与原意不符）。
    const pathOf = (line) => {
      const body = line.slice(3).trim();
      const arrow = body.split(' -> ');
      return (arrow[arrow.length - 1] ?? body).replace(/^"|"$/g, '');
    };
    info.dirty = porcelain.split('\n').filter((l) => l.trim() !== '').filter((l) => pathOf(l).split('/').pop() !== WS_MARKER);
    info.clean = info.dirty.length === 0;
    // 「有提交历史」「有远端」：同样用文件系统判定（refs/heads、packed-refs、config）。
    info.hasCommit = (() => {
      try { if (readdirSync(join(gitPath, 'refs', 'heads')).some((n) => n.trim() !== '')) return true; } catch { /* 没有 */ }
      try {
        return readFileSync(join(gitPath, 'packed-refs'), 'utf8').split('\n').some((l) => l.trim() !== '' && !l.startsWith('#'));
      } catch { return false; }
    })();
    info.hasRemote = (() => {
      try { return readFileSync(join(gitPath, 'config'), 'utf8').split('\n').some((l) => /^\s*\[remote\s/.test(l)); }
      catch { return false; }
    })();
    for (const f of CREDENTIAL_FILES) {
      if (!lstatSafe(join(dir, f))) continue;
      info.credentialFiles.push(f);
      info.credentialKeys.push(...credentialKeyNames(join(dir, f)));
    }
    info.ours = hasMarker || emptyByFs;
    if (!info.ours) info.why = '不像本沙箱建的（既没有本脚本的标记，目录里也不止 .git）';
    else if (!info.clean) info.why = `有未提交内容（${info.dirty.slice(0, 3).join(' ')}${info.dirty.length > 3 ? ' …' : ''}）`;
    else if (info.hasCommit) info.why = '有提交历史（里面可能有别人的工作）';
    else if (info.hasRemote) info.why = '配了远端（里面可能连着别人的仓）';
    else if (info.credentialFiles.length > 0) info.why = `含凭据副本 ${info.credentialFiles.join(', ')}（键名 ${info.credentialKeys.join(',') || '无'}）⇒ 人工确认后再删`;
    info.deletable = info.ours && info.clean && !info.hasCommit && !info.hasRemote && info.credentialFiles.length === 0;
    return info;
  };

  /**
   * 残留自检：**两处**都要查（#72 的原话：只看 `~/dsh-sbx*` 为 0 就以为清干净了，
   * 其实工作区还在另一个名字下）。
   *
   * 三处一起报：本次的 `--home` 目录 + `~/dsh-sbx*`（不含 `-ws`）+ `~/dsh-sbx*-ws`。
   */
  const residualReport = () => {
    const home = homedir();
    let names = [];
    try { names = readdirSync(home); } catch { names = []; }
    const sandboxDirs = names.filter((n) => n.startsWith('dsh-sbx') && !/-ws$/.test(n)).sort();
    const wsDirs = names.filter((n) => /^dsh-sbx.*-ws$/.test(n)).sort();
    const homeIsUnderHome = HOME_.startsWith(home + sep);
    say(`残留自检：本次 --home ${HOME_} ${lstatSafe(HOME_) ? '仍在' : '已无'}；`
      + `~/dsh-sbx*（不含 -ws）${sandboxDirs.length} 个；~/dsh-sbx*-ws ${wsDirs.length} 个`);
    for (const n of [...sandboxDirs, ...wsDirs]) {
      const dir = join(home, n);
      const creds = CREDENTIAL_FILES.filter((f) => lstatSafe(join(dir, f)));
      const keys = creds.flatMap((f) => credentialKeyNames(join(dir, f)));
      // 沙箱目录里那个**默认位置**的工作区也要报出来（它不再以 `~/dsh-sbx*-ws`
      // 的名字出现了，但仍然是「两处」之一 ⇒ 漏了它就等于又漏一次 #72）。
      const inner = lstatSafe(join(dir, 'ws')) ? '，含工作区 ws/' : '';
      say(`  · ${n}${creds.length > 0 ? `（含凭据副本 ${creds.join(', ')}；键名 ${keys.join(',') || '无'}）` : ''}${inner}`);
    }
    if (sandboxDirs.length === 0 && wsDirs.length === 0 && !homeIsUnderHome) say('  两处都是 0 ⇒ 清干净了');
    return sandboxDirs.length === 0 && wsDirs.length === 0;
  };

  /**
   * 收尾：停实例 → 体检并删工作区 → 删沙箱目录 → 残留自检。
   * @returns {number} 退出码：有东西被拒绝删（脏/不认识的）⇒ 1（**不许静默跳过**）。
   */
  const cleanupSandbox = () => {
    console.log('');
    // 护栏先行：**在停实例与任何删除之前**先证明「要删的是沙箱自己的目录」。
    // 放晚了就成了「先删了工作区、再发现沙箱目录不该删」——那已经删出去了。
    assertHomeIsDeletable();
    say('收尾：停实例 → 体检工作区 → 删沙箱目录 → 残留自检');
    const pids = pidsOfHome(HOME_);
    let killed = 0;
    for (const p of pids) {
      try { process.kill(p.pid, 'SIGTERM'); killed += 1; } catch { /* 已退出 */ }
    }
    say(killed > 0
      ? `已停实例：${killed} 个进程（按 DSH_HOME=${HOME_} 认领，只杀自己的）`
      : '没有在跑的实例（按 DSH_HOME 反查为空）');
    let refused = 0;
    const infos = [...new Set([WS, WS_LEGACY])].map(inspectWorkspace);
    for (const info of infos) {
      if (!info.exists) { say(`工作区 ${info.dir}：不存在（无需处理）`); continue; }
      if (!info.ours || !info.clean || info.hasCommit || info.credentialFiles.length > 0) {
        refused += 1;
        say(`⚠ 工作区 ${info.dir} 未删：${info.why}`);
        continue;
      }
      assertDeletablePath(info.dir, '工作区');
      rmSync(info.dir, { recursive: true, force: true });
      say(`已删工作区 ${info.dir}`);
    }
    // 工作区默认在沙箱目录**内部** ⇒ 它脏的时候连沙箱目录也不能删（否则等于间接删掉
    // 别人的工作区）。这时明确报出来，并让退出码非 0。
    const dirtyInside = infos.find((i) => i.exists && i.dir.startsWith(HOME_ + sep) && (!i.clean || i.hasCommit));
    if (dirtyInside !== undefined) {
      refused += 1;
      say(`⚠ 沙箱目录 ${HOME_} 未删：里面有未提交的工作区 ${dirtyInside.dir}（${dirtyInside.why}）`
        + ' ⇒ 删它等于删掉别人的工作区；处理掉那个工作区再跑一次收尾');
    } else if (lstatSafe(HOME_)) {
      rmSync(HOME_, { recursive: true, force: true });
      say(`已删沙箱目录 ${HOME_}（里面是**沙箱自带的凭据副本**，与 ~/.dsh/.credentials.yaml 无关——那份未动）`);
    } else {
      say(`沙箱目录 ${HOME_}：不存在（无需处理）`);
    }
    console.log('');
    residualReport();
    if (refused > 0) say(`⚠ 有 ${refused} 处拒绝删除（见上面的原因）—— 退出码 1，不静默跳过`);
    return refused > 0 ? 1 : 0;
  };

  /**
   * 删除前的护栏（fail-closed）：只允许删「沙箱自己的」路径。
   *
   * `--cleanup` 是本 PR **新增**的一条以「删除」为名的路径 ⇒ 它有权删东西，就必须先证明
   * 删的是沙箱自己的目录。任一条不满足 ⇒ **直接 die，一个字都不删**：
   *  - 不是主目录本身、不是 `~/.dsh`、也不是 `~/.dsh` 的**祖先**目录（`~`、`/`……）
   *  - 不是仓库目录（自身带 `.git` 的也算）
   *  - 形状对：要么是 `--home` **显式给出**的，要么**正好等于**默认的 `~/dsh-sbx-<entry>`
   */
  const assertDeletablePath = (target, what) => {
    const t = resolve(target);
    const homeDir = resolve(homedir());
    const live = resolve(join(homeDir, '.dsh'));
    const repoDir = resolve(REPO);
    const problems = [];
    if (t === homeDir) problems.push('它就是主目录本身');
    if (t === live) problems.push('它是 live 宿主的 ~/.dsh');
    if (live.startsWith(t + sep)) problems.push('它是 ~/.dsh 的祖先目录（live 的状态在它下面）');
    if (t === repoDir) problems.push('它是仓库目录');
    if (problems.length > 0) {
      die(`拒绝删除${what} ${t}：${problems.join('；')}\n`
        + '      沙箱目录必须是「--home 显式给出的」或「正好等于默认的 ~/dsh-sbx-<entry>」那种专用目录，\n'
        + '      且不得是主目录、~/.dsh（含其祖先）或仓库目录。');
    }
    return t;
  };

  /** 沙箱目录专属的那一条：在通用护栏之外，还要「形状对」。 */
  const assertHomeIsDeletable = () => {
    const t = assertDeletablePath(HOME_, '沙箱目录');
    // 沙箱目录自己带 .git ⇒ 它是个仓库目录（不是沙箱）⇒ 拒。
    // ⚠️ 这条**只对沙箱目录**成立：工作区**本来就**是个 git 仓（脚本 git init 出来的）。
    if (lstatSafe(join(t, '.git'))) die(`拒绝删除沙箱目录 ${t}：它自己带 .git（是个仓库目录，不是沙箱目录）。`);
    const explicit = opt('home', '') !== '';
    const defaultHome = resolve(join(resolve(homedir()), `dsh-sbx-${short}`));
    if (!explicit && t !== defaultHome) {
      die(`拒绝删除沙箱目录 ${t}：它既不是 --home 显式给出的，也不是默认的 ${defaultHome}。`);
    }
    return t;
  };

  if (flag('cleanup')) process.exit(cleanupSandbox());
  if (flag('residual')) { console.log(''); residualReport(); process.exit(0); }

  let entryId = entryCfg;
  if (!flag('deploy')) {
    // 护栏：删沙箱目录前先证明「删的是沙箱自己的目录」（fail-closed，见 assertDeletablePath）。
    assertHomeIsDeletable();
    rmSync(HOME_, { recursive: true, force: true });
    mkdirSync(PROFILE, { recursive: true });             // 漏了它，copyFileSync 直接 ENOENT
    mkdirSync(join(HOME_, 'logs'), { recursive: true }); // 建错位置会让启动崩在 spawn 之后
    for (const f of ['package.json', 'cordis.yml', 'compatibility.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml', 'cordis.patch.yml']) {
      const src = join(LIVE_PROFILE, f);
      if (existsSync(src)) copyFileSync(src, join(PROFILE, f));
    }
    for (const d of ['patches', 'external-plugins']) {
      const src = join(LIVE_PROFILE, d);
      if (existsSync(src)) execFileSync('cp', ['-rp', src, PROFILE], { stdio: 'ignore' });
    }
    const patchPath = join(PROFILE, 'cordis.patch.yml');
    if (!existsSync(patchPath)) die(`副本里没有 cordis.patch.yml：${patchPath}`);
    let patch = readFileSync(patchPath, 'utf8');
    if (entryId === '') {
      entryId = findEntryId(patch, pkgName) ?? '';
      if (entryId === '') say(`⚠ 没按 name: ${pkgName} 反查到条目 id → 跳过易失载荷剥离（可用 --entry <id> 指定）`);
      else say(`条目 id 反查：${pkgName} → ${entryId}`);
    }
    if (rules.length > 0) {
      const r = applyRewrites(patch.split('\n'), rules);
      rules.forEach((rule, k) => {
        if (r.hits[k] === 0) die(`--rewrite 未命中任何行：${JSON.stringify(rule.from)}（profile 结构变了？先人工确认，别猜）`);
        say(`rewrite 命中 ${r.hits[k]} 处：${rule.from} → ${rule.to}`);
      });
      patch = r.lines.join('\n');
    }
    const clash = declaredPorts(patch.split('\n')).filter((p) => portInUse(p));
    if (clash.length > 0) {
      die(`副本里这些端口已被占用：${clash.join(', ')}。第二实例必须避开 —— 加 `
        + `--rewrite 'port: ${clash[0]}=port: ${clash[0] + 900}'（group 成员条目 --patch 关不掉，只能改配置）`);
    }
    if (entryId !== '') {
      const st = stripEntryVolatileKeys(patch, entryId);
      patch = st.text;
      if (st.removed.length > 0) say(`剥除条目 ${entryId} 的易失载荷：${st.removed.map((r) => `${r.key}(${r.lines}行)`).join('、')}`);
    }
    for (const key of extraStrip) {
      const one = stripKeyBlock(patch, key);
      patch = one.text;
      say(`按 --strip 剥除 ${key}：${one.removed} 行`);
    }
    if (disables.length > 0) {
      patch += disables.map((id) => `\n# dev-sandbox：关掉 ${id}\n- id: ${id}\n  disabled: true`).join('\n') + '\n';
      say(`将禁用顶层条目：${disables.join('、')}（group 成员关不掉）`);
    }
    if (flag('watch')) {
      patch += '\n# dev-sandbox：宿主层源码热重载（只盯本插件私有产物目录）\n'
        + `- id: hmr\n  disabled: false\n  config:\n    root:\n      - node_modules/${pkgName}/lib\n    ignored: []\n    debounce: 100\n`;
      say('热重载已开：要**真改内容**才触发（只 touch 换 mtime 无效）');
    }
    writeFileSync(patchPath, patch);
    rmSync(PLUGIN, { recursive: true, force: true });
    mkdirSync(PLUGIN, { recursive: true });
    for (const f of ['package.json', 'cordis.patch.yml', 'icon.svg', 'README.md']) {
      const src = join(REPO, f);
      if (existsSync(src)) copyFileSync(src, join(PLUGIN, f));
    }
    for (const d of ['lib', 'docs']) {
      const src = join(REPO, d);
      if (existsSync(src)) execFileSync('cp', ['-rp', src, PLUGIN], { stdio: 'ignore' });
    }
    const nm = join(PROFILE, 'node_modules');
    mkdirSync(nm, { recursive: true });
    if (!existsSync(LIVE_NM)) die(`找不到真实 node_modules：${LIVE_NM}`);
    for (const entry of readdirSync(LIVE_NM)) {
      if (entry === pkgName) continue;
      const link = join(nm, entry);
      if (!existsSync(link) && !lstatSafe(link)) symlinkSync(join(LIVE_NM, entry), link);
    }
    const mine = join(nm, pkgName);
    if (lstatSafe(mine)) rmSync(mine, { recursive: true, force: true });
    symlinkSync(PLUGIN, mine);
    chmodSync(HOME_, 0o700);
    say(`产物独立副本：${mine} → ${PLUGIN}（放构建不会污染 live 要加载的 ${join(REPO, 'lib')}）`);
  } else if (!existsSync(join(PROFILE, 'node_modules'))) {
    die('沙箱还不存在，先不带 --deploy 建一次');
  }

  if (flag('deploy')) {
    const srcArg = opt('deploy', '');
    if (srcArg === '') die('--deploy 需要一个含 lib/ 的目录路径');
    const src = resolve(String(srcArg));
    if (!existsSync(join(src, 'lib'))) die(`--deploy 指向的目录里没有 lib/：${src}`);
    rmSync(join(PLUGIN, 'lib'), { recursive: true, force: true });
    execFileSync('cp', ['-rp', join(src, 'lib'), PLUGIN], { stdio: 'ignore' });
    say(`已部署构建：${src}/lib → ${PLUGIN}/lib`);
  }

  // 凭据**必须**复制成文件：`credentials-local` 读的是 `dshHomePath('.credentials.yaml')`
  // （`dsh-credentials-local/lib/index.js:58`），沙箱换了 DSH_HOME 就读到空文件，于是任何
  // 走 `apiKeyEnv` 的路由都报 `no credential for provider route …`，而这类失败与"路由没配好"
  // 在现象上很难区分（实测踩过：整整一轮沙箱观测全废）。
  //
  // 这一步必须在 `--check` 之前做：`--check` 会提前 `process.exit`，而它建的沙箱同样要能跑
  // 真实回合（`dsh headless`），所以"只有启动 web 那条路径才复制凭据"是错的 —— 踩过。
  // 权限压回 0600，且只落在沙箱目录内（原文件本来就是 0600，复制不扩大权限面）。
  const copyCredentials = () => {
    const credSrc = join(homedir(), '.dsh', '.credentials.yaml');
    if (!existsSync(credSrc)) {
      say('⚠ 宿主机没有 ~/.dsh/.credentials.yaml：需要凭据的路由在沙箱里会报 no credential');
      return;
    }
    const credDst = join(HOME_, '.credentials.yaml');
    copyFileSync(credSrc, credDst);
    chmodSync(credDst, 0o600);
    say('已复制 ~/.dsh/.credentials.yaml 进沙箱（0600）—— 否则 apiKeyEnv 路由全部解析不到凭据');
  };
  if (!flag('deploy')) copyCredentials();

  const BIN = findBin();
  if (flag('check')) {
    const out = execFileSync('node', [BIN, '--profile', 'web', '--dump-config'], {
      encoding: 'utf8', env: { ...process.env, DSH_HOME: HOME_ }, timeout: 180_000, stdio: ['ignore', 'pipe', 'ignore'],
    });
    const present = entryId === '' ? null : new RegExp(`^- id: ${entryId}$`, 'm').test(out);
    const bad = out.split('\n').filter((l) => /invalid config|ValidationError/i.test(l)).slice(0, 3);
    say(`合成校验：条目 ${entryId || '（未指定）'} ${present === null ? '跳过' : present ? '在册 ✓' : '缺失 ✗'}；校验错误 ${bad.length} 条`);
    for (const b of bad) say(`    ${b.slice(0, 140)}`);
    process.exit((present === null || present) && bad.length === 0 ? 0 : 1);
  }

  mkdirSync(WS, { recursive: true });
  try { execFileSync('git', ['-C', WS, 'rev-parse', '--git-dir'], { stdio: 'ignore' }); }
  catch { try { execFileSync('git', ['-C', WS, 'init', '-q'], { stdio: 'ignore' }); } catch { /* 非致命 */ } }
  // 标记文件：收尾时据此判断「这个工作区**确实是本沙箱建的**」（#72 的硬要求：不许删
  // 别人的工作区 ⇒ 删除前必须能证明它是我们的、且干净）。
  // 故意放在工作树里（不是 `.git/` 里）：它要能被 `git status --porcelain` 看见，
  // 收尾时才能把它从「脏」里**排除**（否则自己写的标记会让自己永远「脏」）。
  try { writeFileSync(join(WS, WS_MARKER), `home=${HOME_}\ncreated=${new Date().toISOString()}\n`); } catch { /* 非致命 */ }

  const env = { ...process.env, DSH_HOME: HOME_ };
  const envFile = join(homedir(), '.dsh', 'env.local');
  if (existsSync(envFile)) {
    // 密钥只进子进程环境，不复制文件（env.local 里的值本来就只是环境变量形态）
    for (const line of readFileSync(envFile, 'utf8').split('\n')) {
      const m = /^export\s+([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
      if (m !== null) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
    say('已把 ~/.dsh/env.local 注入子进程环境（仅内存，未落进沙箱）');
  }
  const log = join(HOME_, 'logs', 'sbx.log');
  // 日志 fd 归子进程：父进程接管道的话，父进程一退出管道就断，子进程下次写日志吃 EPIPE 而死
  // （表现为"启动成功、稍后自行退出"，极易被误判成热重载或内核问题）。
  let logFd;
  try { logFd = openSync(log, 'a'); } catch (error) { die(`日志打不开 ${log}: ${String(error)}`); }
  // 启动前的行数：下面取 URL 时只看**本次**新增的行。日志是追加写的，上一轮的 `dsh web:` 行还在，
  // 直接全文 grep 会拿到上一轮的（旧）端口 —— 用它去连一个已经停掉的实例，结论必然错。
  const logLinesBefore = existsSync(log) ? readFileSync(log, 'utf8').split('\n').length : 0;
  const child = spawn('node', [BIN, '--profile', 'web', '--port', GUI_PORT, '--no-open'], {
    env, cwd: HOME_, detached: true, stdio: ['ignore', logFd, logFd],
  });
  child.unref();
  try { closeSync(logFd); } catch { /* 已关 */ }
  /**
   * 记录**真正在监听的那个 node 进程** pid，而不是 `spawn` 返回的 pid。
   *
   * 实测教训：`dsh` 是 npx 的启动器包装，`child.pid` 可能只是一个 shell/包装进程；按它 kill
   * 之后 node 子进程仍然活着占着端口（我据此误判过"沙箱已停"，然后一个残留实例继续跑）。
   * 所以启动后按 DSH_HOME 反查，把实际进程的 pid 写进 pidfile（查不到才退回 child.pid）。
   */
  const pidFile = join(HOME_, 'sbx.pid');
  writeFileSync(pidFile, `${child.pid}\n`);
  const realPids = () => pidsOfHome(HOME_);
  const settlePid = () => {
    const mine = realPids().filter((x) => x.cmd.includes('.bin/dsh'));
    if (mine.length > 0) {
      writeFileSync(pidFile, mine.map((x) => `${x.pid}`).join('\n') + '\n');
      return mine.map((x) => x.pid);
    }
    return [child.pid];
  };
  say(`已启动 pid=${child.pid}（稍后会写回真实 node pid）；停它请用 ${pidFile} 里的 pid`
    + ' —— `pkill -f` 的模式串会匹配到调用方自己的命令行（踩过三次）');

  const deadline = Date.now() + 45_000;
  const tick = () => {
    const all = existsSync(log) ? readFileSync(log, 'utf8').split('\n') : [];
    // 只看本次启动之后新增的行（见上面 logLinesBefore 的理由）
    const fresh = all.slice(logLinesBefore).join('\n');
    const url = (/http:\/\/127\.0\.0\.1:\d+\/\?token=[\w-]+/.exec(fresh) ?? [null])[0];
    if (url === null && Date.now() < deadline) { setTimeout(tick, 2000); return; }
    const pids = settlePid();
    const port = url === null ? '' : (/127\.0\.0\.1:(\d+)/.exec(url) ?? [])[1];
    console.log('');
    say(`存活=${pids.filter((p) => lstatSafe(`/proc/${p}`)).length > 0 ? 'yes' : 'NO'}  `
      + `${url ?? 'URL 未就绪（看日志）'}`);
    say(`pidfile 里的 pid：${pids.join('、')}（${pidFile}）`);
    if (port !== undefined && port !== '') {
      // 用自己的眼睛再核一次监听：日志里的 URL 只能当线索，`ss` 才是事实。
      const listening = execFileSync('ss', ['-ltnH', `( sport = :${port} )`], { encoding: 'utf8' }).trim().length > 0;
      say(`日志给的端口 ${port} 实际在监听=${listening ? 'yes ✓' : 'NO ✗'}`);
    } else {
      say('本次启动没有新的 URL 行 —— 别拿日志里的旧 URL 当本次实例（实测踩过）');
    }
    say(`端口冲突 ${/EADDRINUSE/.test(fresh) ? '有 ✗' : '无 ✓'}；新增日志 ${fresh.split('\n').length} 行`);
    if (greps.length > 0) {
      console.log('');
      say('读法：');
      for (const g of greps) say(`    grep -F '${g}' ${log}`);
    }
    process.exit(0); // 子进程自持 fd，父进程退出不影响它
  };
  setTimeout(tick, 4000);

  function findBin() {
    const fromFlag = opt('bin', '');
    if (fromFlag !== '') return resolve(fromFlag);
    try {
      const found = execFileSync('sh', ['-c', 'command -v dsh || true'], { encoding: 'utf8' }).trim();
      if (found !== '') return found;
    } catch { /* 继续找 */ }
    const cache = join(homedir(), '.npm', '_npx');
    if (existsSync(cache)) {
      for (const dir of readdirSync(cache)) {
        const cand = join(cache, dir, 'node_modules', '.bin', 'dsh');
        if (existsSync(cand)) return cand;
      }
    }
    die('找不到 dsh 启动器：用 --bin <path> 指定');
  }
}
