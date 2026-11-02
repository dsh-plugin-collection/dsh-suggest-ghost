#!/usr/bin/env node
/**
 * `sessionProjections.register()` 的**返回形状探针**（issue #121）。
 *
 * ## 它量什么
 *
 * 直接对**已发布的 alpha.2 产物**（`<tree>/node_modules/@deepseek-ai/dsh-session-projection/lib/index.js`）
 * 实例化真 `SessionProjectionRegistry`，量四件事：
 *
 *  1. 返回值的 `typeof` 与 `then` 是不是同时存在 ⇒ 证实它是「**可调用 thenable**」，
 *     不是裸 promise（老代次是纯函数，新代次**两者都是**）；
 *  2. `registrations.has(key)` 在**调用之后、await 之前**是否已经为真 ⇒ 这一条直接决定
 *     「不 await 会不会让消费方读到 undefined」这句结论的大小（issue 把它写得比实测严重）；
 *  3. `await` 之后拿到的是不是 handle（`stateOf` / `readerFor` / `dispose`）；
 *  4. 注册生命周期是否由内核自己挂到 `ctx.effect` 上（label = `sessionProjections.register()`）
 *     ⇒ 决定了「我们该不该把返回值当 disposer 交回 cordis」。
 *
 * ## 为什么 ctx 是手工 stub
 *
 * 真 `Service` 构造要走 `ctx.reflect.provide`、`register()` 要走 `ctx.effect`，
 * 而这里**只关心注册表自己那几行字节的形状**，不想为它组一整个 cordis 根上下文
 * （那属于 `verify-across-kernels.mjs` 的真装配面，两条路各管各的）。
 * stub 里 `effect()` 是**立刻执行回调并记下 label 与返回类型** —— 这正是 cordis 对
 * 非生成器 effect 的行为，所以第 2/4 条量的仍然是被测包的字节，不是 stub 的行为。
 *
 * 用法：node scripts/cross-kernel/projection-register-shape.mjs [--tree ~/dsh-versions/0.2.2-alpha.2]
 * 退出码：0 = 量到并符合预期 / 2 = 未判定（树或包不在，**不静默算过**）/ 1 = 量到但与预期不符。
 *
 * @module dsh-suggest-ghost/cross-kernel/projection-register-shape
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt;
};
const tree = opt('tree', join(homedir(), 'dsh-versions', '0.2.2-alpha.2')).replace(/^~/, homedir());
const pkgDir = join(tree, 'node_modules', '@deepseek-ai', 'dsh-session-projection');

const undetermined = (why) => {
  console.log(`UNDETERMINED：${why}`);
  process.exit(2);
};
if (!existsSync(join(pkgDir, 'lib', 'index.js'))) undetermined(`该树没有 ${pkgDir}/lib/index.js`);

const requireFromPkg = createRequire(join(pkgDir, 'package.json'));
const pkgVersion = requireFromPkg('./package.json').version;

let SessionProjectionRegistry;
try {
  const mod = await import(requireFromPkg.resolve('@deepseek-ai/dsh-session-projection'));
  SessionProjectionRegistry = mod.SessionProjectionRegistry
    ?? Object.values(mod).find((v) => typeof v === 'function' && /Registry/.test(v.name));
} catch (error) {
  undetermined(`导入被测包失败：${String(error?.message ?? error).slice(0, 140)}`);
}
if (!SessionProjectionRegistry) undetermined('该产物没有导出 SessionProjectionRegistry');

// 该包把 zod 钉在自己的 node_modules 里（4.4.3），必须从**它自己**解析，别拿仓里那份。
const zodRequire = createRequire(join(pkgDir, 'package.json'));
const zod = zodRequire('zod');
const z = zod.z ?? zod;

const effects = [];
const noop = () => {};
/**
 * 与 cordis `_execute()` 同构的 effect 驱动（照 `lib/index.js:1134-1165` 的四条分支）。
 *
 * ⚠️ **必须认得生成器**：`0.2.1-rc.2` 的 `register()` 走的是
 * `this.ctx.effect(function* () { this.registrations.set(...) … })` —— 生成器函数**调用只得到
 * 迭代器对象、函数体一行没跑**。第一版 stub 只 `fn()` 就记账，于是 rc.2 那一代被我量成
 * "await 之前 registrations 里没有这个 key"：**那是在量我的 stub，不是量被测包**（技能 §13
 * 同一类错）。照 cordis 补上 `Symbol.iterator` 那条分支（同步 drain 到底、把 yield 出来的
 * disposer 收进 disposables）之后，rc.2 与 alpha.2 一样是**同步可见**。
 */
function driveEffect(fn, label) {
  const value = fn();
  const disposables = [];
  const collect = (d) => { if (typeof d === 'function') disposables.push(d); };
  if (typeof value === 'function') collect(value);
  else if (value !== null && typeof value === 'object' && Symbol.iterator in value) {
    for (const yielded of value) collect(yielded);
  } else if (value !== null && typeof value === 'object' && 'then' in value) {
    // 本探针不需要等它；记录下来即可。
    void Promise.resolve(value).then(collect);
  }
  effects.push([label, typeof value]);
  return () => disposables.reverse().forEach((d) => d());
}
const ctx = {
  on: () => noop,
  logger: { error: noop, warn: noop, info: noop, debug: noop },
  fiber: { state: 2, assertActive: noop, effect: driveEffect },
  reflect: { provide: noop, notify: noop, store: Object.create(null), _getImpl: () => null },
  provide: noop, mixin: noop, usage: noop, dispose: noop,
  // cordis 的 Service 构造会 `ctx.reflect.provide(...)`；effect 走 ctx.effect —— 与 fiber 同义。
  effect: driveEffect,
};

const KEY = 'suggestGhost';
const schema = z.object({ suggestion: z.any().nullable(), hot: z.any().nullable() });
const registry = new SessionProjectionRegistry(ctx);
const returned = registry.register({
  key: KEY,
  stateVersion: 2,
  stateSchema: schema,
  init: () => ({ suggestion: null, hot: null }),
  apply: (state) => state,
  wire: { viewSchema: schema, view: (state) => state },
});

const regs = registry.registrations;
const syncVisible = regs?.has?.(KEY) === true;
const callable = typeof returned === 'function';
const thenable = typeof returned?.then === 'function';
const handle = await returned;
const stillVisible = regs?.has?.(KEY) === true;
const handleShape = !!handle && typeof handle === 'object'
  && typeof handle.stateOf === 'function'
  && typeof handle.readerFor === 'function'
  && typeof handle.dispose === 'function';
const ownedByKernel = effects.some(([label]) => label === 'sessionProjections.register()');

const rows = [
  ['被测产物', `${pkgDir}  @ ${pkgVersion}`],
  ['1. 返回值 typeof / 是否 thenable', `${typeof returned} / thenable=${thenable}` + (callable && thenable ? '  ⇒ 可调用 thenable（老 disposer 形态仍在，且被标 deprecated）' : '')],
  ['2. await **之前** registrations.has(key)', String(syncVisible)],
  ['3. await 之后拿到 handle（stateOf/readerFor/dispose）', `${handleShape}（typeof=${typeof handle}）`],
  ['4. 注册生命周期由内核挂在 ctx.effect 上', `${ownedByKernel}（effects=${JSON.stringify(effects)}）`],
];
for (const [k, v] of rows) console.log(`  ${k.padEnd(44)} ${v}`);

// 期望（按 0.2.2-alpha.2 实测写死，改动即红）：可调用 thenable + 同步可见 + handle 形状 + 内核自持生命周期。
const expectCallableThenable = callable && thenable;
const expect = [
  ['可调用 thenable', expectCallableThenable],
  ['await 前就已在 registrations 里', syncVisible],
  ['await 给回 ProjectionHandle 形状', handleShape],
  ['注册由内核自己的 ctx.effect 承载', ownedByKernel],
];
const broken = expect.filter(([, ok]) => !ok);
console.log('');
if (pkgVersion.startsWith('0.2.2')) {
  if (broken.length === 0) {
    console.log('预期四条全部成立 ⇒ 退出 0。');
    console.log('其中「await 前就已在 registrations 里」这一条限定了 issue #121 的影响评估：');
    console.log('  不 await 丢的是**注册失败的可见性**与新契约要求的 fiber 就绪时序，不是"消费方一定读到 undefined"。');
    process.exit(0);
  }
  console.log(`与预期不符：${broken.map(([n]) => n).join(' / ')} ⇒ 退出 1`);
  process.exit(1);
}
// 非 0.2.2 线：老代次本来就是"纯函数、无 thenable"，拿 alpha 的预期去量它只会得到假红。
// 所以这里报**未判定**（技能 §2：没测到 ≠ 通过），但把观测到的形状原样打出来 ——
// 第 2/4 条在老代次同样成立（同步可见 + 内核自持生命周期），这是"同一条 await 两代都安全"的依据。
console.log(`被测的是 ${pkgVersion}（非 0.2.2 线）⇒ 对 alpha 契约判**未判定**（退出 2），不是判红。`);
console.log(`  可复用的两条观测：同步可见=${syncVisible}，内核自持生命周期=${ownedByKernel}`);
process.exit(2);
