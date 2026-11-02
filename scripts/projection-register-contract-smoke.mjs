#!/usr/bin/env node
/**
 * `sessionProjections.register()` 返回契约 · 跨代次运行时断言（issue #121）。
 *
 * ## 这条 smoke 存在的理由
 *
 * issue #121 说 0.2.2-alpha.2 把 `register()` 从「同步 disposer」改成
 * `Promise<ProjectionHandle<S>>`，并要求「await 注册落定后才发布消费方」。
 * 本仓的修法是一条 `await registry.register(...)`（`src/index.ts` 投影注册处）。
 * **光看 d.ts 不能证明这个写法在两种运行时形状下都对**，也不能证明"顺手 return 一下返回值"
 * 无害。下面 5 条断言全部对着**本仓 node_modules 里那份 cordis**（与插件运行时同一份字节）
 * 真实执行，跑的是 cordis 的 fiber 生命周期，不是 mock。
 *
 * ## 对照的发布产物事实（不重复实现，只作断言的输入）
 *
 * - ≤ `0.2.1-rc.5`：`register(def): () => void` —— 返回**同步 disposer**。
 *   （`@deepseek-ai/dsh-session-projection/lib/types/index.d.ts:150-159`，rc.5 实测）
 * - `0.2.2-alpha.2`：`register(def): Promise<ProjectionHandle<S>>`，文档写明
 *   「Callers must await registration before publishing consumers; registration may perform
 *   asynchronous work.」；实现返回的是**可调用 thenable**：函数体 = 老 disposer，
 *   `then/catch/finally` 转发到 `ready`（`lib/index.js:80-105`），
 *   而单元本身在 `await` **之前**就进了注册表（`ctx.effect(...)` 同步跑体，`:127-151`，
 *   之后才有 `await Promise.resolve()`）。⇒「不 await」并不会让 map 里查不到单元，
 *   它丢的是**拒绝的可见性**与 fiber 的就绪时序（断言 4/5）。
 *
 * ## 判据口径（skill §2）
 *
 * 只用事件/形状：typeof、调用次数、时序毫秒、fiber state、logger.error 文本。
 * 不搜业务正文。退出码：0 全绿 / 1 有红。
 *
 * @module dsh-suggest-ghost/projection-register-contract-smoke
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(ROOT, 'package.json'));
const { Context } = await import('file://' + require.resolve('@deepseek-ai/cordis'));

const failures = [];
const notes = [];
function assert(name, condition, detail) {
  (condition ? notes : failures).push(`${condition ? '✓' : '✗'} ${name}${detail ? ` —— ${detail}` : ''}`);
}

/** 造一个只带 `probe.register` 的 root context，并换掉 logger（错误必须可见地上报，不能静默）。 */
function harness(register) {
  const ctx = new Context();
  const errors = [];
  ctx.provide('probe', { register });
  // cordis 的 ctx.logger 可覆盖：断言要看的就是"错误落到哪"。
  Object.assign(ctx, {
    logger: { error: (e) => errors.push(String(e?.message ?? e)), warn: () => {}, info: () => {}, debug: () => {} },
  });
  return { ctx, errors };
}

const HANDLE = () => ({ dispose: async () => {}, __handleshape: true });

// ── 断言 1：cordis **会等** async inject 回调里的 await（新契约要求的"就绪前发布"由此成立）
{
  const delay = 60;
  const { ctx } = harness(() => new Promise((res) => setTimeout(() => res(HANDLE()), delay)));
  const order = [];
  const t0 = Date.now();
  const fiber = ctx.inject(['probe'], async (c) => {
    await c.probe.register({ key: 'suggestGhost' });
    order.push('registered');
  });
  await fiber;
  order.push('after-await');
  const elapsed = Date.now() - t0;
  assert(
    '1. await 注册 ⇒ fiber 在注册 promise 落定之后才就绪',
    order.join('>') === 'registered>after-await' && elapsed >= delay,
    `顺序 ${order.join(' > ')}，+${elapsed}ms（promise 延后 ${delay}ms）`,
  );
}

// ── 断言 2：不 await（issue 说的旧写法）时，"就绪"发生在注册落定**之前**
// ⚠️ 幅度要说清，别把这条读成"旧写法必然慢 60ms"：断言 2 用 60ms 是为了让缺口**可观测**。
// alpha.2 真实实现里 `acquire()` 在 `ctx.effect(...)`（同步把单元装进 registrations）之后
// 才 `await Promise.resolve()`（`lib/index.js:152`），所以**map 层面的缺口只有一个 microtask**
// ——「客户端读到 undefined」这条风险比 issue 写得小。真正丢的是断言 5a 那条：**拒绝不可见**。
{
  const delay = 60;
  const { ctx } = harness(() => new Promise((res) => setTimeout(() => res(HANDLE()), delay)));
  const order = [];
  const t0 = Date.now();
  const fiber = ctx.inject(['probe'], (c) => {
    // 旧写法：拿返回值当 void，直接丢掉。
    void c.probe.register({ key: 'suggestGhost' });
    order.push(`body-end@+${Date.now() - t0}ms`);
  });
  await fiber;
  order.push(`fiber-await-settled@+${Date.now() - t0}ms`);
  assert(
    '2. 不 await ⇒ 回调体与 fiber 就绪都早于注册落定（时序缺口是真的，不是假想）',
    Date.now() - t0 < delay + 5,
    order.join(' > ') + `（注册 promise 在 +${delay}ms 才落定）`,
  );
}

// ── 断言 3：**不能**把 await 的结果 return 出去（handle 对象会被 cordis 判成 Invalid effect）
{
  const { ctx, errors } = harness(() => Promise.resolve(HANDLE()));
  const fiber = ctx.inject(['probe'], async (c) => await c.probe.register({ key: 'suggestGhost' }));
  let thrown = null;
  try { await fiber; } catch (error) { thrown = String(error?.message ?? error); }
  assert(
    '3. return handle 对象 ⇒ cordis 抛 `Invalid effect` 并把本条 fiber 打成 error 态（插件掉线）',
    /Invalid effect/.test(thrown ?? '') && /Invalid effect/.test(errors.join('|')),
    `await 抛 ${JSON.stringify(thrown)}，logger.error ${JSON.stringify(errors)}，fiber.state=${fiber.state}`,
  );
}

// ── 断言 4：老代次形状（同步 disposer）下，同一条 `await` 成立且**不会误调用**它
{
  let calls = 0;
  const disposer = () => { calls += 1; };
  const { ctx } = harness(() => disposer);
  let typeofAwaited = null;
  const fiber = ctx.inject(['probe'], async (c) => {
    const settled = await c.probe.register({ key: 'suggestGhost' });
    typeofAwaited = typeof settled;
  });
  await fiber;
  assert(
    '4. await 一个函数（老 disposer）= 原样拿到它、不产生调用 ⇒ 新旧两代可用同一条 await',
    typeofAwaited === 'function' && calls === 0,
    `typeof(awaited)=${typeofAwaited}，disposer 调用次数=${calls}`,
  );
}

// ── 断言 5：拒绝必须**可见**——不 await 时它是游离的 rejection，await 时它进 fiber 错误面
{
  const boom = () => Promise.reject(new Error('registration-rejected(simulated)'));
  // 5a 不 await：cordis 不会替我们观察这个 promise（本进程里它会成为未处理拒绝）。
  const seen = [];
  const onUnhandled = (reason) => seen.push(String(reason?.message ?? reason));
  process.on('unhandledRejection', onUnhandled);
  {
    const { ctx, errors } = harness(boom);
    const fiber = ctx.inject(['probe'], (c) => { void c.probe.register({ key: 'suggestGhost' }); });
    await fiber;
    await new Promise((r) => setTimeout(r, 20));
    assert(
      '5a. 不 await ⇒ 拒绝只以"未处理拒绝"出现，插件侧 fiber 仍是就绪态（问题被藏住）',
      seen.length > 0 && errors.length === 0 && fiber.state !== 3,
      `未处理拒绝 ${JSON.stringify(seen)}，logger.error ${JSON.stringify(errors)}，fiber.state=${fiber.state}`,
    );
  }
  process.off('unhandledRejection', onUnhandled);
  // 5b await：拒绝沿 fiber 上浮，可被 await / 状态看到。
  {
    const { ctx, errors } = harness(boom);
    const fiber = ctx.inject(['probe'], async (c) => { await c.probe.register({ key: 'suggestGhost' }); });
    let thrown = null;
    try { await fiber; } catch (error) { thrown = String(error?.message ?? error); }
    assert(
      '5b. await ⇒ 同一条拒绝上浮到 fiber（await 会抛 / 状态转 error），不再静默',
      /registration-rejected/.test(thrown ?? '') || /registration-rejected/.test(errors.join('|')) || fiber.state === 3,
      `await 抛 ${JSON.stringify(thrown)}，logger.error ${JSON.stringify(errors)}，fiber.state=${fiber.state}`,
    );
  }
}

console.log('projection register 契约 · cordis 运行时断言（issue #121）');
for (const line of notes) console.log('  ' + line);
for (const line of failures) console.log('  ' + line);
console.log(`\n${failures.length === 0 ? '全部通过' : `${failures.length} 条不通过`}（共 5 组断言）`);
process.exit(failures.length === 0 ? 0 : 1);
