#!/usr/bin/env node
/**
 * 跨内核代次 —— **类型面**（FACE A: host/client tsc）+ **客户端导入可用性**（FACE B）。
 *
 * 用法：
 *     node scripts/cross-kernel/type-surface.mjs            # 全 7 代
 *     node scripts/cross-kernel/type-surface.mjs --json     # 只打印 JSON 摘要
 *
 * 退出码（照 skill §2 约定）：0 全绿 / 1 有红 / 2 有未判定。
 *
 * ============================================================================
 * 先说三个**方法学**结论，它们决定了这份脚本为什么长这样
 * ============================================================================
 *
 * ## 1. `tsc -p tsconfig.json --noEmit` 是**只测 host** 的绿（本仓最大的一个 pyrite）
 *
 * 根 `tsconfig.json` 带 `"exclude": ["src/client"]`。用 `--listFiles` 实测：
 * 它编 **16** 个 `src/` 文件、`src/client` **0** 个。而客户端有**另一份**
 * `tsconfig.client.json`（`include: ["src/client/**\/*.ts"]`，显式 `exclude: []`）。
 * 所以任务书里那句"跑 `tsconfig.json` 就算验过类型面"只能证明 host 面，
 * **一辈子看不出客户端类型面漂移**。本脚本两份配置都跑，并分别记录。
 *
 * ## 2. 把代次的 peer 目录用**软链**挂进 overlay 会造出**假红**（本脚本的第一个假结论）
 *
 * 首版 overlay 用 `ln -s` 指向 `~/dsh-versions/<gen>/node_modules/@deepseek-ai/<pkg>`，
 * 0.2.0-rc.2 报了 **18 条**错（`Property 'llm' does not exist on type 'Context'`、
 * `Property 'sessions' does not exist on type 'Context'`、`'settings/document-updated'`
 * 不在 `keyof Events`…）。**这 18 条全是 overlay 自己的产物，不是被测代次的结论。**
 *
 * 归因（逐包二分 + A/B 对照钉死）：`preserveSymlinks` 默认 off，TS 按 **realpath**
 * 认模块身份。软链的 realpath 一旦落在 program root **之外**，cordis 的 `Context`
 * 服务增强（declaration merging）就不再与该 program 合并 ⇒ 服务属性全部"不存在"。
 * 对照实验（内容逐字节相同）：
 *   - peer 是指向 overlay **之外**的软链            → 18 条
 *   - peer 是落在 overlay **之内**的实体副本/内部软链 → **0 条**
 * 并且 `diff -rq` 证实本仓 pnpm 里的 9 个 peer 与内核树里的是**逐字节相同**的
 * ⇒ 18 条与"代次差异"无关，纯属挂载手法。
 *
 * **结论：peer 必须 materialize 成 overlay 内的实体目录（`cp -rL`），不能用外指软链。**
 * 任何用软链换 peer 类型的队友都在读同一个假象。
 *
 * ## 3. FACE B 不能用 node_modules 解析当判据
 *
 * `lib/client.js` 是**浏览器包**，由宿主 `window.__ModuleLoader__` 的 `require` 解析
 * （`build.mjs` 用 `packages:'external'`，故 `react`/`primitives` 不打包）。
 * 该 `require` 的解析顺序是（`dsh-client-modules/lib/client.js` 的 `makeRequire`）：
 *     seed 表 → 模块表 → 已注册 factory → 抛错
 * **第一顺位是 seed 表**（`staticModules`），由每代自己的 `dsh-web-frontend/dist` 里
 * `staticModules:<fn>()` 提供。所以「某包不在 tree 的 node_modules 里」**推不出**
 * 「运行时解析不了」——实测 0.1.1-rc.2 / 0.1.2-rc.1 / 0.1.5-rc.1 / 0.2.1-rc.2
 * 三个代次的 node_modules 里没有 `dsh-client-ui-primitives`，但它们的 seed 表**都注册了它**。
 *
 * 另一个坑：`import.meta.resolve(spec, parentURL)` **忽略第二个参数**，永远从
 * **调用方模块**解析（实测从 /tmp 探针调用时，任何 parentURL 都解析不出来）。
 * 要"以某棵树为根"只能用 `createRequire(<该树内的 anchor>)`。
 *
 * ============================================================================
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { KERNEL_GENERATIONS } from './generations.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const OUT_DIR = join(HERE, 'out');
const WORK_DIR = join(HERE, '.work', 'type');
const VERSIONS_ROOT = join(homedir(), 'dsh-versions');
const TSC = join(REPO, 'node_modules', '.bin', 'tsc');

/** 被测的 peer 集合：包的**类型面**在这里换血。storage/storage-json/client-* 是传递闭包。 */
const PEER_PACKAGES = [
  'dsh-llm',
  'dsh-session',
  'dsh-session-projection',
  'dsh-settings',
  'dsh-storage-domain',
  'dsh-timeout',
  'dsh-storage',
  'dsh-storage-json',
  'dsh-client-ui-settings',
  'dsh-client-ui-conversation',
  'dsh-client-ui-primitives',
  'dsh-client-store',
];

/** overlay 里保留本仓自己的三件套（cordis 的版本由本仓 devDeps 钉，不随代次换）。 */
const REPO_OWN = ['cordis', 'cosmokit', 'schemastery'];

/** 拷进 overlay 的 node_modules 白名单（本仓 devDeps 里 overlay 真正需要的部分）。 */
const REPO_MODULES = ['typescript', 'zod', 'esbuild', 'react', 'react-dom'];
const REPO_TYPES = ['node', 'react'];

/** FACE B 目标：随包发布的浏览器入口。 */
const CLIENT_ENTRY = join(REPO, 'lib', 'client.js');

/**
 * 宿主运行时**平台自带**的 specifier（不属于任何 DSH 代次发布线）。
 * 它们的"注册表里没有 <代次版本>"是**预期的**，不能当缺口：react 是宿主自己的 React。
 */
const CLIENT_PLATFORM_SPECIFIERS = new Set(['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client']);

const pkgVersion = (dir) => {
  const f = join(dir, 'package.json');
  if (!existsSync(f)) return null;
  try {
    return JSON.parse(readFileSync(f, 'utf8')).version ?? null;
  } catch {
    return null;
  }
};

/** 树的身份戳：mtime + @deepseek-ai 条目数（让"这次判的是哪棵树"可复核）。 */
function treeIdentity(generationId) {
  const root = join(VERSIONS_ROOT, generationId);
  const ds = join(root, 'node_modules', '@deepseek-ai');
  const stamped = { generationId, treeRoot: root, exists: existsSync(root) };
  if (!stamped.exists) return stamped;
  stamped.mtime = statSync(root).mtime.toISOString();
  stamped.entries = existsSync(ds) ? readdirSync(ds).length : 0;
  stamped.launcherVersion = pkgVersion(join(ds, 'dsh'));
  return stamped;
}

/**
 * 混树检测：dsh-* 服务里有多少个的版本 != 代次 id。
 * 0.1.5-rc.1 实测 230 个包是 0.1.5-rc.3（仅 `dsh` 自己是 rc.1）——
 * 所以那一代的类型面结论属于 **rc.3 的面**，必须如实标注而不是写成 rc.1。
 */
function versionMix(generationId) {
  const ds = join(VERSIONS_ROOT, generationId, 'node_modules', '@deepseek-ai');
  if (!existsSync(ds)) return { checked: 0, mismatched: 0, versions: {} };
  const versions = {};
  let checked = 0;
  let mismatched = 0;
  for (const entry of readdirSync(ds)) {
    if (entry !== 'dsh' && !entry.startsWith('dsh-')) continue;
    const v = pkgVersion(join(ds, entry));
    if (v === null) continue;
    checked += 1;
    versions[v] = (versions[v] ?? 0) + 1;
    if (v !== generationId) mismatched += 1;
  }
  return { checked, mismatched, versions };
}

/**
 * 造 FACE A 的隔离 overlay。
 *
 * **关键：peer 用 `cp -rL` 落成实体目录，绝不用外指软链**（见文件头 §2）。
 * 同时把本仓自己的依赖也 `-L` 去引用——本仓 node_modules 是 pnpm 布局，
 * 里面全是 `../.pnpm/...` 相对软链，直接 `cp -r` 会在新目录里当场断链。
 */
function buildOverlay(generationId) {
  const work = join(WORK_DIR, generationId);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(join(work, 'node_modules', '@types'), { recursive: true });
  mkdirSync(join(work, 'node_modules', '@deepseek-ai'), { recursive: true });

  for (const f of ['src', 'tsconfig.json', 'tsconfig.client.json', 'package.json', 'build.mjs']) {
    cpSync(join(REPO, f), join(work, f), { recursive: true });
  }
  for (const m of REPO_MODULES) {
    const from = join(REPO, 'node_modules', m);
    if (existsSync(from)) cpSync(from, join(work, 'node_modules', m), { recursive: true, dereference: true });
  }
  for (const t of REPO_TYPES) {
    const from = join(REPO, 'node_modules', '@types', t);
    if (existsSync(from)) cpSync(from, join(work, 'node_modules', '@types', t), { recursive: true, dereference: true });
  }
  for (const p of REPO_OWN) {
    const from = join(REPO, 'node_modules', '@deepseek-ai', p);
    if (existsSync(from)) {
      cpSync(from, join(work, 'node_modules', '@deepseek-ai', p), { recursive: true, dereference: true });
    }
  }

  const tree = join(VERSIONS_ROOT, generationId, 'node_modules', '@deepseek-ai');
  const mounted = {};
  const missing = [];
  for (const p of PEER_PACKAGES) {
    const from = join(tree, p);
    if (existsSync(from)) {
      cpSync(from, join(work, 'node_modules', '@deepseek-ai', p), { recursive: true, dereference: true });
      mounted[p] = pkgVersion(from);
    } else {
      missing.push(p);
    }
  }
  // overlay 实际被 tsc 读到的 @deepseek-ai 版本戳（比树 mtime 更接近"判的是什么字节"）。
  const overlayVersions = {};
  const ods = join(work, 'node_modules', '@deepseek-ai');
  for (const entry of readdirSync(ods)) {
    const v = pkgVersion(join(ods, entry));
    if (v !== null) overlayVersions[entry] = v;
  }
  return { work, mounted, missing, overlayVersions };
}

/** 跑一次 tsc；返回 { code, errors[], raw }。 */
function runTsc(work, config) {
  const args = ['-p', join(work, config), '--noEmit'];
  let out = '';
  let code = 0;
  try {
    out = execFileSync(TSC, args, { cwd: work, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    code = error.status ?? 1;
    out = `${error.stdout ?? ''}${error.stderr ?? ''}`;
  }
  const errors = out
    .split('\n')
    .filter((line) => line.includes('error TS'))
    // 路径前缀随 overlay 临时目录变化，剥掉以便跨代次逐字对比；
    // `settings-card.tsx` 那条会把**绝对路径写进正文**，所以正文里的路径也要剥。
    .map((line) =>
      line
        .replaceAll(`${work}/`, '')
        .replaceAll(`${work}\\`, '')
        .replaceAll(`${REPO}/`, '')
        .replaceAll(`${REPO}\\`, ''),
    )
    .map((line) => line.trim())
    .sort();
  return { code, errors, raw: out.trim() };
}

/**
 * 基线（本仓 checkout，== 本仓 devDeps 钉的 0.2.0-rc.2 那一版内核）的客户端错误集。
 *
 * **为什么必须做基线差集**：这 6~7 条是 `tsconfig.client.json` **有意保留**的存量
 * （其文件头注释逐条归因过：TS5097 accept-guard 是刻意留的、2×TS2532 是
 * `noUncheckedIndexedAccess` 口径产物、TS6142 是"这份 noEmit 诊断配置没设 jsx"、
 * TS2341/TS18047 是刻意不掩盖的哨兵）。它们是**工具的固有噪声**，不是代次的结论。
 * 直接拿绝对条数判红会把 7 代全判红——那正是"把基线噪声当成本次发现的缺陷"。
 * 所以：**代次红 = 出现了基线里没有的错误种类。**
 */
function baselineErrors(config) {
  const args = ['-p', join(REPO, config), '--noEmit'];
  let out = '';
  try {
    out = execFileSync(TSC, args, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    out = `${error.stdout ?? ''}${error.stderr ?? ''}`;
  }
  return out
    .split('\n')
    .filter((line) => line.includes('error TS'))
    .map((line) => line.replaceAll(`${REPO}/`, '').replaceAll(`${REPO}\\`, '').trim())
    .sort();
}

/** 把错误归一成"种类"签名：去路径与行列号，只留 code + 消息 + 文件基名。 */
function errorSignature(line) {
  const m = line.match(/^(.*?)\((\d+),(\d+)\): (error TS\d+: .*)$/);
  if (m === null) return line;
  const file = m[1].split('/').pop();
  return `${file}: ${m[4]}`;
}

/**
 * FACE B —— 三条**互相独立**的判据，必须分开报（混起来就会得出"缺包即硬下界"的错论）。
 *
 *  (a) `treeResolves`：用 `createRequire(<该树内 anchor>)` 做真 ESM 解析，
 *      列出**解析不了**的 bare specifier。注意这**不等于**运行时失败（见 (c)）。
 *  (b) `published`：逐个 specifier 打 npm registry，判断该代次版本**是否发布过**。
 *      "树里没有" ≠ "从没发布" —— 这两件事必须分开说。
 *  (c) `hostSeed`：宿主 GUI 的 `staticModules` seed 表里有没有这个 specifier。
 *      这才是**决定运行时能不能解析**的那一条（`makeRequire` 第一顺位）。
 */
function bareSpecifiersInClientEntry() {
  const src = readFileSync(CLIENT_ENTRY, 'utf8');
  const found = new Set();
  // 包里是 CJS 包装（`factory:(require)=>{...}`），真实调用形态是 require("x")。
  for (const m of src.matchAll(/\brequire\(\s*"([^"]+)"\s*\)/g)) found.add(m[1]);
  for (const m of src.matchAll(/\bfrom\s*"([^"]+)"\s*\)/g)) found.add(m[1]);
  // 只看 bare specifier（相对路径由 esbuild 打包，不经宿主解析）。
  return [...found].filter((s) => !s.startsWith('.') && !s.startsWith('node:')).sort();
}

/** 从该代次自己的 web-frontend 产物里抽 seed 表键（即宿主 require 第一顺位提供的模块）。 */
function hostSeedKeys(generationId) {
  const dir = join(VERSIONS_ROOT, generationId, 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist');
  if (!existsSync(dir)) return { available: false, keys: [], source: null };
  const assets = join(dir, 'assets');
  if (!existsSync(assets)) return { available: false, keys: [], source: null };
  const bundle = readdirSync(assets).find((f) => f.startsWith('index-') && f.endsWith('.js'));
  if (bundle === undefined) return { available: false, keys: [], source: null };
  const text = readFileSync(join(assets, bundle), 'utf8');
  const m = text.match(/staticModules:([A-Za-z0-9_$]+)\(\)/);
  if (m === null) return { available: false, keys: [], source: bundle };
  const fn = m[1];
  const body = text.match(new RegExp(`function ${fn}\\([^)]*\\)\\{return\\{([^}]*)\\}`));
  if (body === null) return { available: false, keys: [], source: bundle, seedFn: fn };
  // 键**有带引号和不带引号两种**（实测 `react:Ef,"react/jsx-runtime":If,...`）。
  // 只匹配带引号的键会漏掉 `react`，进而把它误判成"seed 不提供"⇒ 假红。
  const keys = [...body[1].matchAll(/(?:"([^"]+)"|([A-Za-z_$][\w$.-]*))\s*:/g)].map(
    (x) => x[1] ?? x[2],
  );
  return { available: true, keys, source: bundle, seedFn: fn };
}

/** (b) npm registry 发布性。离线时如实报 undetermined，不猜。 */
const registryCache = new Map();
function registryPublished(name, version) {
  const cacheKey = name;
  if (!registryCache.has(cacheKey)) {
    try {
      const body = execFileSync(
        'curl',
        ['-sS', '--max-time', '30', `https://registry.npmjs.org/${name.replace('/', '%2f')}`],
        // 注册表文档很大（primitives 有 38 个版本），默认 1MB 缓冲会 ENOBUFS。
        { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
      );
      const doc = JSON.parse(body);
      if (doc.error) {
        registryCache.set(cacheKey, { ok: false, reason: `registry error: ${doc.error}` });
      } else {
        const versions = Object.keys(doc.versions ?? {});
        registryCache.set(cacheKey, { ok: true, versions, versionCount: versions.length });
      }
    } catch (error) {
      registryCache.set(cacheKey, { ok: false, reason: `registry unreachable: ${error.message}` });
    }
  }
  const hit = registryCache.get(cacheKey);
  if (!hit.ok) return hit;
  return {
    ok: true,
    published: hit.versions.includes(version),
    versionCount: hit.versionCount,
    versions: hit.versions,
  };
}

/** 该代次的 release line 上，primitives 这类包应存在的确切版本 = 代次 id 本身。 */
function declaredClientInjects() {
  const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
  return pkg.dsh?.client?.inject ?? [];
}

function declaredDevDeps() {
  const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
  return pkg.devDependencies ?? {};
}

function declaredPeerDeps() {
  const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
  return pkg.peerDependencies ?? {};
}

// ---------------------------------------------------------------------------

function main() {
  const jsonOnly = process.argv.includes('--json');
  mkdirSync(OUT_DIR, { recursive: true });
  mkdirSync(WORK_DIR, { recursive: true });

  const clientSpecs = bareSpecifiersInClientEntry();
  const injects = declaredClientInjects();
  const devDeps = declaredDevDeps();
  const peerDeps = declaredPeerDeps();

  // 基线必须先于循环算出来：代次红是"相对基线的**新增种类**"，不是绝对条数。
  const baselineHost = baselineErrors('tsconfig.json');
  const baselineClient = baselineErrors('tsconfig.client.json');

  const generations = [];
  let anyRed = false;
  let anyUndetermined = false;

  for (const generation of KERNEL_GENERATIONS) {
    const id = generation.id;
    const identity = treeIdentity(id);
    const entriesBefore = identity.entries;

    const record = {
      id,
      bootModel: generation.bootModel,
      tree: identity,
      mixedTree: null,
      faceA: null,
      faceB: null,
      verdict: 'UNDETERMINED',
      reasons: [],
    };

    if (!identity.exists) {
      record.reasons.push('generation tree not provisioned on disk');
      record.verdict = 'UNDETERMINED';
      anyUndetermined = true;
      generations.push(record);
      continue;
    }

    const mix = versionMix(id);
    record.mixedTree = mix;
    if (mix.mismatched > 0) {
      const detail = Object.entries(mix.versions)
        .sort((a, b) => b[1] - a[1])
        .map(([v, n]) => `${v}x${n}`)
        .join(', ');
      record.reasons.push(
        `tree is mixed: ${mix.mismatched}/${mix.checked} dsh-* packages are not ${id} (${detail}); ` +
          `type surface judged is that of the majority version, not ${id}`,
      );
    }
    if (generation.appBootVersion !== undefined && generation.appBootVersion !== id) {
      record.reasons.push(
        `declared appBootVersion ${generation.appBootVersion} differs from generation id ${id} (mixed tree)`,
      );
    }

    // ---- FACE A ----
    const overlay = buildOverlay(id);
    const host = runTsc(overlay.work, 'tsconfig.json');
    const client = runTsc(overlay.work, 'tsconfig.client.json');

    // 与基线做**种类差集**：只有基线里没有的错误种类才是本代次的新增红。
    const baseHostSigs = new Set(baselineHost.map(errorSignature));
    const baseClientSigs = new Set(baselineClient.map(errorSignature));
    const novelHost = host.errors.filter((e) => !baseHostSigs.has(errorSignature(e)));
    const novelClient = client.errors.filter((e) => !baseClientSigs.has(errorSignature(e)));

    record.faceA = {
      overlayDir: overlay.work,
      method:
        'isolated temp copy; peers materialized as REAL dirs via cp -rL (never outside-pointing symlinks — that produces a false red, see header §2)',
      mountedPeers: overlay.mounted,
      missingPeers: overlay.missing,
      overlayVersions: overlay.overlayVersions,
      host: {
        config: 'tsconfig.json',
        scope: 'host only (excludes src/client)',
        errors: host.errors.length,
        errorList: host.errors,
        novelVsBaseline: novelHost,
        raw: host.raw,
      },
      client: {
        config: 'tsconfig.client.json',
        scope: 'src/client only (exclude: [] override)',
        errors: client.errors.length,
        errorList: client.errors,
        novelVsBaseline: novelClient,
        baselineErrors: baselineClient.length,
        raw: client.raw,
      },
    };

    // ---- FACE B ----
    // 注意：`injects` 里是**完整 specifier**（`@deepseek-ai/xxx`），而 treePath 已经
    // 落在 `.../@deepseek-ai` 上了。用 treePath 拼 specifier 会拼成
    // `@deepseek-ai/@deepseek-ai/xxx` 这种永不存在的路径——必须从 node_modules 根拼。
    const nodeModulesPath = join(VERSIONS_ROOT, id, 'node_modules');
    const treePath = join(nodeModulesPath, '@deepseek-ai');
    const anchorCandidates = [
      join(VERSIONS_ROOT, id, 'node_modules', '@deepseek-ai', 'dsh-client-ui-settings', 'lib', 'index.js'),
      join(VERSIONS_ROOT, id, 'node_modules', '@deepseek-ai', 'dsh-settings', 'lib', 'index.js'),
      join(VERSIONS_ROOT, id, 'package.json'),
    ];
    const anchor = anchorCandidates.find((p) => existsSync(p)) ?? null;
    const treeUnresolved = [];
    if (anchor !== null) {
      const req = createRequire(anchor);
      for (const spec of clientSpecs) {
        try {
          req.resolve(spec);
        } catch {
          treeUnresolved.push(spec);
        }
      }
    }

    const seed = hostSeedKeys(id);
    const perSpecifier = clientSpecs.map((spec) => {
      const isPlatform = CLIENT_PLATFORM_SPECIFIERS.has(spec);
      const reg = isPlatform
        ? { ok: true, published: null, versionCount: null, platformProvided: true }
        : registryPublished(spec, id);
      return {
        specifier: spec,
        resolvesAgainstTree: !treeUnresolved.includes(spec),
        resolvesViaHostSeed: seed.keys.includes(spec),
        // "该代次版本号下是否发布过" —— 平台自带项不适用（它不随代次发版）。
        publishedAtGenerationVersion: isPlatform ? null : reg.ok ? reg.published : null,
        registry: reg.ok
          ? isPlatform
            ? { note: 'platform-provided by the host runtime; not part of any DSH generation release line' }
            : { checkedVersion: id, published: reg.published, versionCount: reg.versionCount }
          : { error: reg.reason },
        declaredAsPeerDependency: Object.hasOwn(peerDeps, spec),
        declaredAsDevDependency: Object.hasOwn(devDeps, spec),
        declaredInClientInject: injects.includes(spec),
      };
    });

    record.faceB = {
      entry: CLIENT_ENTRY,
      bareSpecifiers: clientSpecs,
      anchor,
      resolutionMethod:
        'createRequire(anchor inside the generation tree).resolve() — real ESM/CJS resolution, not a text scan. NOTE: import.meta.resolve(spec, parentURL) ignores parentURL and cannot be used for rooted resolution.',
      treeUnresolved,
      hostSeed: { available: seed.available, seedFn: seed.seedFn ?? null, source: seed.source, keyCount: seed.keys.length, keys: seed.keys, has: Object.fromEntries(clientSpecs.map((s) => [s, seed.keys.includes(s)])) },
      declaredInjectPresence: Object.fromEntries(
        injects.map((s) => [s, existsSync(join(nodeModulesPath, s)) ? pkgVersion(join(nodeModulesPath, s)) : null]),
      ),
      perSpecifier,
      runtimeResolutionOracle:
        'host __ModuleLoader__ makeRequire: seed table -> module table -> registered factories. The seed table is FIRST, so tree node_modules absence does NOT imply runtime failure.',
    };

    // ---- verdict ----
    // 声明的 client inject 是**启动图里的插件行**，不是 `staticModules` 的 seed word
    // ——实测两代的 seed 表里都没有 settings/conversation（它们是图行，经
    // `graphRows`/`arriveGraphRow` 解析）。所以对它们正确的判据是"该代次树里有没有这个包"，
    // 不是"在不在 seed 表里"。拿 seed 表判会把 7 代全判红（我自己先踩了一次）。
    const declaredInjectsMissing = injects.filter((s) => !existsSync(join(nodeModulesPath, s)));
    // A specifier the shipped bundle needs is a HARD failure only when it resolves
    // by NEITHER route (not the host seed table, not the tree's node_modules).
    // `react`/`react/jsx-runtime` are the host's own React runtime, not DSH packages —
    // they are always seeded, and their registry absence under the dsh version is expected.
    const clientHardFail = clientSpecs.filter(
      (s) =>
        seed.available && !seed.keys.includes(s) && !treeUnresolved.includes(s) && !CLIENT_PLATFORM_SPECIFIERS.has(s),
    );

    // ---- 判定 ----
    // 红 = **基线之外的新增错误种类**。基线那 6~7 条是这份诊断配置的固有噪声
    // （见 baselineErrors 注释），拿绝对条数判会把 7 代全判红。
    if (novelHost.length > 0 || novelClient.length > 0) {
      record.verdict = 'RED';
      anyRed = true;
      if (novelHost.length > 0) {
        record.reasons.push(`FACE A host: ${novelHost.length} error kind(s) not present in baseline`);
      }
      if (novelClient.length > 0) {
        record.reasons.push(`FACE A client: ${novelClient.length} error kind(s) not present in baseline`);
      }
    } else if (!seed.available) {
      record.reasons.push('host web-frontend bundle unavailable — FACE B runtime oracle cannot be established');
      record.verdict = 'UNDETERMINED';
      anyUndetermined = true;
    } else if (declaredInjectsMissing.length > 0 || clientHardFail.length > 0) {
      record.verdict = 'RED';
      anyRed = true;
      if (declaredInjectsMissing.length > 0) {
        record.reasons.push(
          `declared dsh.client.inject package absent from the generation tree: ${declaredInjectsMissing.join(', ')}`,
        );
      }
      if (clientHardFail.length > 0) {
        record.reasons.push(
          `client specifier resolves by neither host seed nor tree node_modules: ${clientHardFail.join(', ')}`,
        );
      }
    } else {
      // 类型面 = 基线（无新增种类）+ 运行时所需的 specifier 都能由 seed 表解析。
      record.verdict = 'GREEN';
    }

    // 声明卫生（**不进红绿判定**，单列）：一个只因为宿主 bundle seed 了它才解析得到的
    // 导入，是"靠宿主恩典解析、但未声明"——既不是功能红，也不是干净的绿，
    // 而且任何基于 peerDependencies 的准入检查**永远看不到它**。
    record.declarationHygiene = {
      undeclaredRuntimeImports: clientSpecs.filter(
        (s) => !Object.hasOwn(peerDeps, s) && !injects.includes(s) && !CLIENT_PLATFORM_SPECIFIERS.has(s),
      ),
      declaredInClientInject: injects,
      note:
        'an import that only resolves because the host bundle seeds it is "resolves by host grace, undeclared" — ' +
        'it is neither a functional red nor a clean green, and no peer-based admission check can ever see it.',
    };

    // 混树标注：结论属于**多数版本**的类型面，不属于代次 id 那一版。
    if (mix.mismatched > 0) {
      const majority = Object.entries(mix.versions).sort((a, b) => b[1] - a[1])[0];
      record.mixedTreeAnnotation =
        `tree is mixed: launcher ${identity.launcherVersion} / services ${majority[0]} ` +
        `(${majority[1]}/${mix.checked} dsh-* packages). The FACE A verdict below describes the ` +
        `${majority[0]} type surface, NOT ${id}.`;
    }

    const after = treeIdentity(id);
    record.treeMutatedDuringRun = after.entries !== entriesBefore;
    if (record.treeMutatedDuringRun) {
      record.reasons.push(
        `tree mutated during run: @deepseek-ai entries ${entriesBefore} -> ${after.entries}`,
      );
      record.verdict = 'UNDETERMINED';
      anyUndetermined = true;
    }

    generations.push(record);
  }

  const exitCode = anyRed ? 1 : anyUndetermined ? 2 : 0;
  const result = {
    task: 'T-TYPE (task-3)',
    generatedAt: new Date().toISOString(),
    repo: REPO,
    tsc: TSC,
    commands: {
      faceA: './node_modules/.bin/tsc -p <overlay>/tsconfig.json --noEmit',
      faceAClient: './node_modules/.bin/tsc -p <overlay>/tsconfig.client.json --noEmit',
      faceB: 'createRequire(<generation tree anchor>).resolve(<bare specifier from lib/client.js>)',
    },
    pitfallsRecorded: [
      'tsconfig.json excludes src/client => the literal Face A command is a host-only green (verified via --listFiles: 16 src files, 0 client files).',
      'outside-pointing symlinks for peers produce a FALSE RED (18 phantom errors on 0.2.0-rc.2) via TS realpath/module-identity; peers must be materialized as real dirs.',
      'import.meta.resolve(spec, parentURL) ignores parentURL — unusable for rooted resolution.',
      'tree node_modules absence != runtime failure: the host __ModuleLoader__ seed table is consulted first.',
      'tree node_modules absence != never published: must check the npm registry separately.',
    ],
    baseline: {
      note:
        'errors from the repo checkout (== the devDeps-pinned 0.2.0-rc.2 kernel). These are the knowingly-retained ' +
        'residuals of this diagnostic config, NOT generation findings. A generation is only RED for error KINDS ' +
        'absent from this set.',
      host: { config: 'tsconfig.json', errors: baselineHost.length, errorList: baselineHost },
      client: { config: 'tsconfig.client.json', errors: baselineClient.length, errorList: baselineClient },
    },
    declared: {
      clientInject: injects,
      peerDependencies: peerDeps,
      primitivesDeclaredAs: Object.hasOwn(peerDeps, '@deepseek-ai/dsh-client-ui-primitives')
        ? 'peerDependency'
        : Object.hasOwn(devDeps, '@deepseek-ai/dsh-client-ui-primitives')
          ? 'devDependency only'
          : 'undeclared',
    },
    generations,
    summary: {
      exitCode,
      red: generations.filter((g) => g.verdict === 'RED').map((g) => g.id),
      green: generations.filter((g) => g.verdict === 'GREEN').map((g) => g.id),
      undetermined: generations.filter((g) => g.verdict === 'UNDETERMINED').map((g) => g.id),
    },
  };

  writeFileSync(join(OUT_DIR, 'type.json'), `${JSON.stringify(result, null, 2)}\n`);

  if (!jsonOnly) {
    printTable(result);
  }
  process.exit(exitCode);
}

function printTable(result) {
  const pad = (s, n) => String(s).padEnd(n);
  console.log('');
  console.log('=== T-TYPE: type surface (FACE A) + client import availability (FACE B) ===');
  console.log('');
  console.log(
    `baseline = repo checkout (devDeps-pinned 0.2.0-rc.2): host ${result.baseline.host.errors} err, client ${result.baseline.client.errors} err.`,
  );
  console.log('A generation is RED only for error KINDS absent from that baseline.');
  console.log('');
  console.log(
    `${pad('generation', 14)} ${pad('host', 5)} ${pad('+new', 5)} ${pad('client', 7)} ${pad('+new', 5)} ${pad('unsolved-in-tree', 26)} ${pad('seed', 5)} verdict`,
  );
  console.log('-'.repeat(104));
  for (const g of result.generations) {
    if (g.faceA === null) {
      console.log(`${pad(g.id, 14)} ${pad('-', 5)} ${pad('-', 5)} ${pad('-', 7)} ${pad('-', 5)} ${pad('-', 26)} ${pad('-', 5)} ${g.verdict}`);
      continue;
    }
    const un = g.faceB.treeUnresolved.length > 0 ? g.faceB.treeUnresolved.join(',') : '(none)';
    console.log(
      `${pad(g.id, 14)} ${pad(g.faceA.host.errors, 5)} ${pad(g.faceA.host.novelVsBaseline.length, 5)} ` +
        `${pad(g.faceA.client.errors, 7)} ${pad(g.faceA.client.novelVsBaseline.length, 5)} ${pad(un, 26)} ` +
        `${pad(g.faceB.hostSeed.available ? 'yes' : 'NO', 5)} ${g.verdict}`,
    );
  }
  console.log('');
  for (const g of result.generations) {
    if (g.faceA === null) continue;
    if (g.mixedTree.mismatched > 0) {
      console.log(`!! ${g.id}: MIXED TREE — ${g.mixedTree.mismatched}/${g.mixedTree.checked} dsh-* not ${g.id}`);
    }
    if (g.faceA.host.novelVsBaseline.length > 0) {
      console.log(`   ${g.id} NEW host errors (verbatim):`);
      for (const e of g.faceA.host.novelVsBaseline.slice(0, 5)) console.log(`     ${e}`);
    }
    if (g.faceA.client.novelVsBaseline.length > 0) {
      console.log(`   ${g.id} NEW client errors (verbatim):`);
      for (const e of g.faceA.client.novelVsBaseline.slice(0, 5)) console.log(`     ${e}`);
    }
    for (const s of g.faceB.perSpecifier) {
      if (!s.resolvesAgainstTree) {
        const reg = s.registry.error ? `registry ERR (${s.registry.error})` : `published@${g.id}=${s.publishedAtGenerationVersion}`;
        console.log(
          `   ${g.id} unresolved-in-tree: ${s.specifier}  [hostSeed=${s.resolvesViaHostSeed} ${reg} declaredPeer=${s.declaredAsPeerDependency}]`,
        );
      }
    }
    const undecl = g.declarationHygiene.undeclaredRuntimeImports;
    if (undecl.length > 0) {
      console.log(`   ${g.id} declaration hygiene: undeclared runtime import(s): ${undecl.join(', ')}`);
    }
  }
  console.log('');
  console.log(`exit=${result.summary.exitCode}  red=[${result.summary.red}]  undetermined=[${result.summary.undetermined}]`);
  console.log(`wrote ${join(OUT_DIR, 'type.json')}`);
}

main();
