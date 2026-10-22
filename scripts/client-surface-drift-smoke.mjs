#!/usr/bin/env node
/**
 * 客户端类型面**漂移闸**（Gitea #81 / #85，task-26 commit C）。
 *
 * ## 它防的是什么（与 `client-import-surface-smoke.mjs` 方向相反）
 * `src/client/index.ts` 里的 `ClientSessionsSurface` 等本地面是**断言**（`as unknown as`），
 * 不是推导。它当前是活的（乱写成员报 TS2339、拼错报 TS2551 带 "Did you mean"），但断言的
 * 代价是**漂移方向变了**：本地镜像一旦与宿主真实客户端面不一致（宿主升级、成员改名、语义
 * 变化），检查不会变瞎，而是**朝反方向骗人** —— 照样通过，却在一个不存在的面上下结论。
 * **假信心比报错贵。**
 *
 * ## 做法
 * **从本地声明里读出成员名**，再逐个回宿主的 `.d.ts` 核存在性 ⇒ 本地改名、或宿主删成员，
 * 都会在这里红。刻意**不抄一份硬编码名单**：抄来的名单自己就会漂，正是本闸要防的那种漂。
 *
 * ## ⚠️ 本闸的边界（读输出的人都会看到，不许把绿当「镜像与宿主一致」）
 * 它只做**存在性**核对（成员名出现在宿主声明位上），因此：
 *  - ✅ 抓得到：成员**改名**、**被删**、本地**新增未登记**成员；
 *  - ❌ 抓不到：成员**签名变了**（参数类型/返回类型/可选性）、**语义变了**（同名不同义）。
 * ⇒ 绿只等于「这些名字还在宿主面上」，**不等于**「这个镜像是对的」。真正的一致性只有
 * 宿主包进 devDeps、删掉镜像、让 tsc 直接对着真面查才能拿到（= #85 的用户决策）。
 *
 * ## 明确不核的部分（标推断，不假装验证过）
 * `SnapshotStore` / `ObservableSnapshot` 的**成员形状**（`getSnapshot` / `subscribe`）：
 * `@deepseek-ai/dsh-client-store` 在本机与主仓 node_modules 里都没有 ⇒ 无法回源。
 * 留作 #85「装 devDep 才能做」那一项；**本条不补它的成员**，也不把这条算成已验证。
 *
 * ## 三态（不许把没验到的写成通过）
 *  - **PASS**：宿主 d.ts 可达且每个镜像成员都核到（同时打出上面的边界声明）。
 *  - **FAIL**：某成员在宿主 d.ts 找不到 ⇒ 镜像在骗人，必须修。
 *  - **NOT-COVERED**：宿主 d.ts 本机不可达（这些包不在本仓 devDeps）⇒ 退出码 0，
 *    但**必须打出缺哪个前置**；与 `scripts/ghost-frame-e2e.mjs` 同口径。
 *    自测这条分支：`HOME=/tmp/空目录 node scripts/client-surface-drift-smoke.mjs`
 *    （不给任何 `DSH_HOST_NODE_MODULES` 时，仓库自身也解析不到那几个包）。
 *
 * 用法：node scripts/client-surface-drift-smoke.mjs
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(fileURLToPath(new URL('.', import.meta.url)));
const CLIENT_INDEX = join(repoRoot, 'src', 'client', 'index.ts');

/**
 * 本地面成员 → 宿主出处。锚点行号与 `src/client/index.ts` 注释里引用的是同一批：
 * 任一处漂了，这里先红，再顺着去对注释。
 */
const SURFACE = [
  { local: 'ClientSessionsSurface', member: 'list', hostPkg: 'dsh-api-session-controller', hostFile: 'lib/types/client/sessions/service.d.ts', cite: ':99' },
  { local: 'ClientSessionsSurface', member: 'scope', hostPkg: 'dsh-api-session-controller', hostFile: 'lib/types/client/sessions/service.d.ts', cite: ':213' },
  { local: 'ClientSessionsSurface', member: 'sessionOf', hostPkg: 'dsh-api-session-controller', hostFile: 'lib/types/client/sessions/service.d.ts', cite: ':238' },
  { local: 'ClientSessionFaceLike', member: 'projections', hostPkg: 'dsh-api-session-controller', hostFile: 'lib/types/client/sessions/session.d.ts', cite: ':34' },
  { local: 'ClientSessionFaceLike', member: 'faceOf', hostPkg: 'dsh-api-session-controller', hostFile: 'lib/types/client/sessions/projection-store.d.ts', cite: ':70' },
];

/** **刻意不核**（标推断）：`SnapshotStore` 的成员形状。见文件头与 #85。 */
const INFERRED = ['getSnapshot', 'subscribe'];

const LIMITS = '本闸只核「成员名是否存在」⇒ 抓得到改名/删除/未登记新增；'
  + '抓不到签名变化与语义变化。绿 ≠ 镜像正确，只 = 这些名字还在宿主面上。';

/** 宿主安装目录候选（机器相关，逐个试；全部不可达 ⇒ NOT-COVERED）。 */
function hostModuleRoots() {
  const roots = [];
  if (process.env.DSH_HOST_NODE_MODULES) roots.push(join(process.env.DSH_HOST_NODE_MODULES, '@deepseek-ai'));
  // 仓内（含 worktree 软链到主仓的那种）：解析不到那几个宿主客户端包，留着是为了
  // 「将来把它们加进 devDeps 后本闸自动升级为真检查」，而不是写死某台机器的绝对路径。
  roots.push(join(repoRoot, 'node_modules', '@deepseek-ai'));
  const npxBase = join(homedir(), '.npm', '_npx');
  try {
    for (const d of readdirSync(npxBase)) roots.push(join(npxBase, d, 'node_modules', '@deepseek-ai'));
  } catch { /* 无 _npx 目录：下面统一按不可达处理 */ }
  return roots;
}

/** 读出 `interface X { … }` 体里的成员名（用来反查本地是否新增了未登记的成员）。 */
function localMembers(name) {
  const src = readFileSync(CLIENT_INDEX, 'utf8');
  const head = `interface ${name} {`;
  const at = src.indexOf(head);
  if (at < 0) return null;
  const bodyStart = at + head.length;
  const body = src.slice(bodyStart, src.indexOf('\n}', bodyStart));
  return [...body.matchAll(/^\s*(?:readonly\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*[?]?[:(]/gm)]
    .map((m) => m[1]).filter((x) => typeof x === 'string');
}

const roots = hostModuleRoots();
const reachable = roots.filter((r) => existsSync(join(r, 'dsh-api-session-controller')));

if (reachable.length === 0) {
  console.log('⚪ [NOT-COVERED] 客户端类型面漂移闸：宿主 d.ts 本机不可达，未做任何核对。');
  console.log('     查过的位置：' + (roots.length ? roots.join(' , ') : '(无候选)'));
  console.log('     缺的前置：宿主客户端包不在本仓 devDeps（`dsh-api-session-controller` 等'
    + ' require.resolve 实测失败）⇒ 见 #85（装依赖与否是用户决策）。');
  console.log('     ⇒ 在 #85 落地前，这台机器上「镜像是否与宿主一致」**无人核对**；不要把它当已验证。');
  process.exit(0);
}

const readHost = (s) => {
  for (const r of reachable) {
    const p = join(r, s.hostPkg, s.hostFile);
    if (existsSync(p)) return readFileSync(p, 'utf8');
  }
  return null;
};

const misses = [];
let checked = 0;
for (const s of SURFACE) {
  const text = readHost(s);
  assert.ok(text !== null, `宿主文件不可达：${s.hostPkg}/${s.hostFile}（可达根目录里缺这个包？）`);
  // 词法边界 + 后跟 `(` 或 `:` ⇒ 声明位，而不是注释里的普通词。
  const re = new RegExp(`(^|[^A-Za-z0-9_])${s.member}\\s*\\??\\s*[(:]`, 'm');
  if (!re.test(text)) misses.push(`${s.local}.${s.member} —— 宿主 ${s.hostPkg}/${s.hostFile}${s.cite} 里找不到该声明`);
  checked += 1;
}

// 本地新增成员必须登记：否则「镜像里多出一个宿主没有的成员」这种最阴的形状会静默通过。
for (const iface of ['ClientSessionsSurface', 'ClientSessionFaceLike']) {
  const members = localMembers(iface);
  assert.ok(members !== null, `本地面里找不到 interface ${iface} —— 被改名或删了？本闸的映射需要同步更新`);
  const declared = SURFACE.filter((s) => s.local === iface).map((s) => s.member);
  for (const m of members) {
    if (!declared.includes(m) && !INFERRED.includes(m)) {
      misses.push(`${iface}.${m} —— 本地新增了未登记的成员，宿主出处未知（要么加进 SURFACE，要么确认它不该存在）`);
    }
  }
}

assert.equal(
  misses.length,
  0,
  `\n  本地镜像面与宿主 d.ts 出现漂移（= 假信心）：\n  ${misses.join('\n  ')}`
  + '\n  ⇒ 要么改本地面跟上宿主，要么按 #85 把宿主包装进 devDeps、让 tsc 直接对着真面查并删掉镜像。',
);

console.log(`✅ client-surface-drift: 镜像的 ${checked} 个成员逐个回宿主 d.ts 核到存在性；`
  + `未核（标推断，留给 #85）：${INFERRED.join(' / ')}`);
console.log(`   ⚠️ 边界：${LIMITS}`);
