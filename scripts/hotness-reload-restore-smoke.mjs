// #88：热重载路径不回灌热表 —— 判别冒烟（先证伪，改动前必须红）。
//
// **诚实说明这条为什么这么设计**（别把它当"已经复现了线上故障"读）：
//  1. 我在沙箱里真跑 `partialReload`（多文件 touch、一轮里两次 apply）时，新实例**每次都恢复
//     成功**（探针留痕：`inject FIRED → open() OK → records=30 → restored: tableSize=30`）。
//     ⇒ 线上那次「tableSize=0」的**确切触发条件没在沙箱里复现出来**。
//  2. 但代码里有一条**确定存在**的静默降级：`dsh-storage-domain/lib/index.js:356` 对同名域是
//     独占的（`already-open` 直接 reject），而本仓的 catch 会 `settleReady()` 之后当没事发生
//     ⇒ `ready=true` 且 `size=0`，与用户看到的「共 0 条」完全同形；更糟的是这份空表会被当权威
//     写进 `_hot`（lead 实测重载后那一格只剩 4~6 条 count=1）。
//  ⇒ 所以本文件验的是「**当恢复没能发生时，行为必须正确**」这条契约：用可控的假 facility 把
//     那条竞态**强制造出来**，而不是赌宿主真实时序。假 facility 只负责制造拒绝；被测的
//     重试 / 状态位 / 留痕 / 上限计数全是真代码。
//
// 用法：node --experimental-strip-types scripts/hotness-reload-restore-smoke.mjs
import assert from 'node:assert/strict';
import { Context, Service } from '@deepseek-ai/cordis';
import { setupHotnessPersistence } from '../lib/hotness-store.js';
import { HOT_TABLE_MAX_ENTRIES } from '../lib/hotness.js';

let failed = 0;
const scenario = async (name, fn) => {
  try {
    await fn();
    realLog(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    // 结果一律走 realLog：断言抛出时 fn 里的 captureOff() 来不及跑，
    // 再打印到被劫持的 console.log 就会「静默失败」（这条我自己踩过一次）。
    realLog(`  ✗ ${name}\n      ${String(error.message).split('\n')[0]}`);
  } finally {
    captureOff();
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// —— 留痕捕获：必须走 console（与 ops-trace 同通道），不能只靠 ctx.logger ————
// 理由见 src/hotness-store.ts 里 hotnessTrace 的注释：#88 的诊断中「日志里没有那行 warn」
// 被当过两次证据，两次都错（单一 exporter 丢 info/debug；错误消息里的子串还会造成假阳性）。
let captured = [];
const realLog = console.log;
const captureOn = () => { captured = []; console.log = (...a) => { captured.push(a.map(String).join(' ')); }; };
const captureOff = () => { console.log = realLog; };

/**
 * 真栈 + **只把 `open()` 包一层拒绝**：前 `rejectTimes` 次抛 `already-open`（与宿主同一种错误），
 * 之后放行真实实现。
 *
 * 为什么不自己搭假 Context/假服务：`ctx.inject(['storageDomain'])` 的兑现依赖真插件生命周期
 * （`storageDomain.apply(root, …)` 会启动 context）——手搓的 Service stub 注册得上、注入却不触发
 * （实测 `open` 被调用 0 次）。⇒ 造竞态要动的是**那一个方法**，不是整个宿主。
 */
const realStackWithRejections = async (rejectTimes, hist) => {
  const { Storage } = await import('@deepseek-ai/dsh-storage');
  const storageJson = await import('@deepseek-ai/dsh-storage-json');
  const storageDomain = await import('@deepseek-ai/dsh-storage-domain');
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'dsh-hreload-'));
  writeFileSync(join(dir, 'suggest_ghost_hotness.json'), JSON.stringify({
    unit: { name: 'suggest_ghost_hotness', version: 1 },
    tables: { entries: Object.fromEntries(hist.map((r) => [r.text, r])) },
  }), 'utf8');
  const root = new Context();
  if (root.logger === undefined) root.logger = console;
  new Storage(root);
  storageJson.apply(root, { root: dir });
  await storageDomain.apply(root, { backend: 'json' });
  const facility = root.storageDomain ?? root.get?.('storageDomain');
  if (facility === undefined) throw new Error('拿不到 storageDomain facility');
  const real = facility.open.bind(facility);
  let calls = 0;
  facility.open = (spec) => {
    calls += 1;
    if (calls <= rejectTimes) {
      return Promise.reject(new Error(`domain '${spec.name}' is already open`));
    }
    return real(spec);
  };
  return { root, callsOf: () => calls };
};

const HIST = [
  { text: '部署服务', count: 177, lastSeq: 10 },
  { text: '查日志', count: 141, lastSeq: 20, pinned: true },
  { text: '跑冒烟', count: 118, lastSeq: 30 },
];

// —— 1. 竞态可控版：域名被占 ⇒ 必须重试到释放，而不是静默降级成空表 ——
await scenario('域名被前一个句柄占着（重载竞态）：重试后恢复 n>0，且三行正面留痕都在', async () => {
  captureOn();
  const { root, callsOf } = await realStackWithRejections(3, HIST);
  const { hotness, persistence } = setupHotnessPersistence(root);
  for (let i = 0; !persistence.restored && i < 300; i += 1) await sleep(25);
  captureOff();
  assert.equal(persistence.restored, true,
    `重试没等到句柄释放（open 被调用 ${callsOf()} 次）⇒ 恢复没发生，卡片会显示「共 0 条」`);
  assert.equal(hotness.size, 3, `恢复条数应为 3；实际 ${hotness.size}`);
  const opened = captured.filter((l) => l.includes('hotness domain opened'));
  const restored = captured.filter((l) => l.includes('hotness restored'));
  const ready = captured.filter((l) => l.includes('hotness ready'));
  assert.ok(opened.length >= 1, `缺「hotness domain opened」（命中 ${opened.length}）⇒ 看不出 open 到底成没成`);
  assert.match(opened[0] ?? '', /attempt=[2-9]/,
    `重试过却把 attempt 记丢了：${JSON.stringify(opened[0] ?? null)}`);
  assert.ok(restored.length >= 1 && /n=3/.test(restored[0] ?? ''),
    `缺「hotness restored: n=…」（命中=${JSON.stringify(restored.slice(0, 2))}）`);
  assert.ok(ready.length >= 1 && /dirty=\d+/.test(ready[0] ?? ''),
    `缺「hotness ready」带 dirty.size（命中=${JSON.stringify(ready.slice(0, 2))}）`);
});

// —— 2. 未就绪必须**可区分**：不许把「还没恢复」当「真的空」交出去 ——
await scenario('恢复最终没发生：`restored=false` 且必须留痕（与「环境没有持久层」区分得开）', async () => {
  captureOn();
  const { root } = await realStackWithRejections(9999, [{ text: '历史条目', count: 50, lastSeq: 1 }]);
  const { persistence } = setupHotnessPersistence(root);
  // 重试预算是 40 次 × 150ms ≈ 6s ⇒ 等待必须盖过它，否则测的是"还没放弃"而不是"放弃了"。
  const t0 = Date.now();
  while (Date.now() - t0 < 12000 && !captured.some((l) => l.includes('hotness restore FAILED'))) {
    await sleep(100);
  }
  const failedTrace = captured.filter((l) => l.includes('hotness restore FAILED'));
  captureOff();
  assert.equal(persistence.restored, false, '没恢复成功却报告已恢复');
  assert.equal(persistence.status, 'unavailable',
    `放弃之后状态必须是 unavailable（实际=${persistence.status}）⇒ 消费方据此照常发内存态`);
  assert.ok(failedTrace.length >= 1,
    `放弃必须留痕（命中 ${failedTrace.length}）⇒ 否则与「根本没有 storageDomain」不可区分（#88 正是卡在这）`);
});

// —— 3. 那条把「长期不就绪」变成「静默丢弃累积」的护栏：清空要留痕 + 计数 ——
await scenario('未就绪期间撞脏上限被清空 ⇒ 必须留痕，带 n= 与 clears= 累计', async () => {
  captureOn();
  const { root } = await realStackWithRejections(9999, [{ text: 'x', count: 1, lastSeq: 1 }]);
  const { hotness, persistence } = setupHotnessPersistence(root);
  const over = HOT_TABLE_MAX_ENTRIES * 2 + 5;
  for (let i = 0; i < over; i += 1) hotness.recordUserText(`压${String(i)}`, i + 1, 'sx');
  await sleep(200);
  captureOff();
  const cleared = captured.filter((l) => l.includes('dirty cap'));
  assert.ok(cleared.length >= 1,
    `撞了 ${over} 条脏标记（上限 ${HOT_TABLE_MAX_ENTRIES * 2}），清空却零留痕 ⇒ 静默丢弃不可见`);
  assert.match(cleared[0] ?? '', /n=\d+/, `留痕要带被丢的条数 n=…：${cleared[0] ?? '无'}`);
  assert.match(cleared[0] ?? '', /clears=\d+/, `留痕要带累计次数 clears=…：${cleared[0] ?? '无'}`);
  assert.ok(persistence.dirtyCapCleared.dropped > 0, '脏上限计数没长 ⇒ 留痕与真实丢弃可能不同源');
});

// —— 4. 回归护栏：boot 路径不许被"修重载"弄坏 ——
await scenario('回归：真存储栈下 boot 恢复照常（改竞态处理不能改坏启动路径）', async () => {
  const { Storage } = await import('@deepseek-ai/dsh-storage');
  const storageJson = await import('@deepseek-ai/dsh-storage-json');
  const storageDomain = await import('@deepseek-ai/dsh-storage-domain');
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'dsh-hreload-boot-'));
  writeFileSync(join(dir, 'suggest_ghost_hotness.json'), JSON.stringify({
    unit: { name: 'suggest_ghost_hotness', version: 1 },
    tables: { entries: Object.fromEntries(HIST.map((r) => [r.text, r])) },
  }), 'utf8');
  const root = new Context();
  if (root.logger === undefined) root.logger = console;
  new Storage(root);
  storageJson.apply(root, { root: dir });
  await storageDomain.apply(root, { backend: 'json' });
  const { hotness, persistence } = setupHotnessPersistence(root);
  for (let i = 0; !persistence.restored && i < 300; i += 1) await sleep(25);
  assert.equal(persistence.restored, true, '真栈下恢复没发生');
  assert.equal(hotness.size, 3, `真栈 boot 应恢复 3 条；实际 ${hotness.size}`);
  await persistence.close();
});

// —— 5. 释放钩子必须在「拿到句柄」那一刻就挂上（2026-10-23 live 泄漏的回归） ——
/**
 * 现场：live 进程 42 行 `apply called`、`hotness domain opened` **0 行**、
 * `close requested` / `closed` 也 **0 行** ⇒ 占着域名的那个 fiber 从来没注册过释放钩子，
 * 宿主怎么重载都不会跑它。沙箱对照证明 disposer 本身是好的（干净重载：
 * `ready → closed released=1 → apply(新 mtime) → opened attempt=1`）。
 * 根因是顺序：旧实现 `open()` 成功后还要读表、解析、合并，**最后**才 `ctx.effect(...)`，
 * 而那中间任何一步抛都会被外层 catch 接住、降级成「staying in-memory」⇒ 域名永久无人认领。
 *
 * 判据两半（**变异自证**：把 `domain = opened` 与 `ctx.effect(...)` 挪回恢复之后 ⇒ 本条
 * 第一句就报红，其余四组全绿；停在原地的旧写法根本走不到注册）：
 *  1. 「open 成功 → 恢复那一步抛」之后，释放钩子必须**已经**在 root 上注册；
 *  2. 跑完那个钩子，域名必须真的腾出来——第二次挂载要能 open 且恢复出 3 条。
 *     只断言 1 不够：钩子注册了却没释放名字（宿主的 `onClosed` 挂钩坏了）同样是永久占用。
 */
await scenario('open 成功之后、恢复之前抛：钩子必须已注册，且跑完能把域名腾给下一个 fiber', async () => {
  const { root } = await realStackWithRejections(0, HIST);
  const facility = root.storageDomain ?? root.get?.('storageDomain');
  const realOpen = facility.open.bind(facility);
  /**
   * 只弄炸**恢复要读的那一次**调用。第一版这里写成 `d.table = () => { throw }` 永久替换，
   * 当场把本条测成了假红——宿主的 `runClose()` 内部也会取表，于是连 `close()` 都被夹具弄坏，
   * 测的就不是「钩子有没有注册」而是「夹具能不能跑」。**夹具不许弄坏被测对象**，
   * 所以这里只炸第一口、把真实实现留给后面（包括 close 那次）。
   */
  let poison = true;
  facility.open = async (spec) => {
    const d = await realOpen(spec);
    const realTable = d.table.bind(d);
    d.table = (name) => {
      if (poison) {
        poison = false;
        throw new Error('fixture: table read blew up');
      }
      return realTable(name);
    };
    return d;
  };
  // ⚠️ cordis 的 `ctx.effect(factory)` 是**注册当场调用 factory**、拿它的**返回值**当 disposer。
  // 第一版这里收的是 factory 本身，于是"跑钩子"只是又跑了一次工厂、close 一次都没被调用，
  // 本条假红成「注册了钩子却腾不出名字」——被测代码是对的，错的是夹具。
  const disposers = [];
  const realEffect = root.effect.bind(root);
  root.effect = (fn, name) => realEffect((...args) => {
    const disposer = fn(...args);
    // 只收本插件那一个：同 root 上别人家的 disposer 一起跑会把 fiber 也拆掉，
    // 第二次挂载就测不成「同一个 facility 里名字是否腾出来了」。
    if (typeof disposer === 'function' && name === 'hotness domain close') disposers.push(disposer);
    return disposer;
  }, name);
  captureOn();
  setupHotnessPersistence(root);
  for (let i = 0; disposers.length === 0 && i < 200; i += 1) await sleep(25);
  await sleep(60);
  captureOff();
  assert.ok(disposers.length >= 1,
    '拿到句柄后、恢复前抛 ⇒ 一个释放钩子都没注册 ⇒ 域名被无人认领的句柄永久占住（就是 live 的形状）');
  // 钩子必须真的把名字腾出来。⚠️ 注册的是 `() => void close()`，**返回 undefined**，
  // 所以 `await Promise.all(...)` 等于没等 ⇒ 这里改成直接问宿主「这个名字还开着吗」
  // （`facility.get(name)` 是 dsh-storage-domain 的公开诊断面），有界轮询而不是猜一个 sleep。
  await Promise.all(disposers.map((d) => d()));
  const stillOpen = async () => (facility.get ? facility.get('suggest_ghost_hotness') !== undefined : true);
  let waited = 0;
  while (await stillOpen() && waited < 3000) { await sleep(50); waited += 50; }
  assert.equal(await stillOpen(), false,
    `钩子跑了 ${waited}ms 之后域名还开着 ⇒ 「注册了钩子」不等于「名字腾得出来」，第二个 fiber 依旧打不开`);
  facility.open = realOpen;
  captureOn();
  const second = setupHotnessPersistence(root);
  for (let i = 0; !second.persistence.restored && i < 400; i += 1) await sleep(25);
  const busy = captured.filter((l) => l.includes('already open'));
  captureOff();
  assert.equal(second.persistence.restored, true,
    `钩子跑完域名没腾出来：第二次挂载仍打不开（busy 留痕 ${busy.length} 行）`);
  assert.equal(second.hotness.size, 3, `域名腾出来了却没恢复对：${second.hotness.size} 条`);
});

realLog(`\n${failed === 0 ? '✅' : '❌'} hotness-reload-restore-smoke: ${failed === 0 ? '全部通过（恢复竞态可重试、状态可区分、丢弃可见、句柄必被认领）' : `${failed} 项失败`}`);
process.exit(failed === 0 ? 0 : 1);
