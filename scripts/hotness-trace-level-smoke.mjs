// #97 的两向判据：热表留痕的**级别**是否落在正确的通道上。
//
// 为什么两向都要测：
//  - 第一向（必须看得见）：`restore FAILED` / `domain unavailable` 按 #98 的定义就是告警，
//    却曾与状态迁移共用 `info`，而默认阈值是 `warn` ⇒ #88 的现场验证拿不到锚点。
//  - 第二向（不许变吵）：顺手把整组提到 `warn` 会让健康进程重新刷回 #98 清掉的那 9294 行，
//    把降噪成果废掉。⇒ 正常 boot **不得**出现 `hotness domain opened`。
//  - 第三向（不许删信息）：`=debug` 时四条状态行必须**照样在** ⇒ 证明第二向是「阈值静音」
//    而不是「留痕被删」。（拿"某字符串没出现"当证据之前，先证明它出现了就一定被打印。）
//
// 夹具口径：与 `hotness-reload-restore-smoke.mjs` 同源 —— 用**真存储栈**、只把 `open()`
// 包一层拒绝；**不新建**带 storageDomain 的假夹具，也不给"按设计没有 storageDomain"的
// 既有夹具补 storageDomain（#89 就是被那条教回默认值的）。
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { setupHotnessPersistence } from '../lib/hotness-store.js';
import { HOT_TABLE_MAX_ENTRIES } from '../lib/hotness.js';

// 本条测的就是**默认阈值** ⇒ 必须显式清掉外部注入的档位（否则从设过 debug 的 shell 里
// 跑会假绿：状态类行也会"必须出现"，而那时测的已经不是默认值）。
delete process.env.DSH_SUGGEST_GHOST_TRACE;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const realLog = console.log;
const results = [];
let failed = 0;

/** 捕获分通道：warn 与 info/debug 必须**分开**数，只看"有没有出现"就分不出级别。 */
let sinkWarn = [];
let sinkInfo = [];
let sinkDebug = [];
const realWarn = console.warn;
const realInfo = console.info;
const realDebug = console.debug;
const captureOn = () => {
  sinkWarn = []; sinkInfo = []; sinkDebug = [];
  console.warn = (...a) => { sinkWarn.push(a.map(String).join(' ')); };
  console.info = (...a) => { sinkInfo.push(a.map(String).join(' ')); };
  console.debug = (...a) => { sinkDebug.push(a.map(String).join(' ')); };
  console.log = (...a) => { sinkDebug.push(a.map(String).join(' ')); };
};
const captureOff = () => {
  console.warn = realWarn;
  console.info = realInfo;
  console.debug = realDebug;
  console.log = realLog;
};
/** 三个通道合起来看（用于"这行有没有被打出来"，与级别无关）。 */
const allLines = () => [...sinkWarn, ...sinkInfo, ...sinkDebug,];

const scenario = async (name, fn) => {
  captureOff();
  try {
    await fn();
    results.push(`  PASS  ${name}`);
  } catch (error) {
    failed += 1;
    results.push(`  FAIL  ${name}\n        ${String((error && error.message) ?? error)}`);
  } finally {
    captureOff();
  }
};

/** 本脚本建过的临时存储目录，结尾统一回收。 */
const tempDirs = [];

/**
 * 真栈 + 只把 `open()` 包一层拒绝（前 rejectTimes 次抛 already-open，之后放行真实实现）。
 * rejectTimes=0 ⇒ 「正常 boot」；rejectTimes 足够大 ⇒ 烧穿 40×150ms 重试预算 ⇒ FAILED。
 */
const realStack = async (rejectTimes, hist, withDomain = true) => {
  const { Storage } = await import('@deepseek-ai/dsh-storage');
  const storageJson = await import('@deepseek-ai/dsh-storage-json');
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'dsh-htlevel-'));
  tempDirs.push(dir); // 跑完自己收：别在 /tmp 里留垃圾（既有 hotness 冒烟已经留了 40 个 dsh-hreload-*）
  writeFileSync(join(dir, 'suggest_ghost_hotness.json'), JSON.stringify({
    unit: { name: 'suggest_ghost_hotness', version: 1 },
    tables: { entries: Object.fromEntries(hist.map((r) => [r.text, r])) },
  }), 'utf8');
  const root = new Context();
  if (root.logger === undefined) root.logger = console;
  new Storage(root);
  storageJson.apply(root, { root: dir });
  if (!withDomain) {
    // 「按设计没有 storageDomain」的环境：用来验 `domain unavailable` 在不在告警通道上。
    return { root, callsOf: () => 0 };
  }
  const storageDomain = await import('@deepseek-ai/dsh-storage-domain');
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
];

// —— 1. 默认阈值 + 恢复永久失败 ⇒ `restore FAILED` **必须**在 console.warn 上 ——
/** 只看 warn 通道（默认阈值下唯一会到用户侧的那条）。 */
const warnSinkHas = (needle) => sinkWarn.some((l) => l.includes(needle));

await scenario('默认阈值（不设环境变量）：open 永久被拒 ⇒ `restore FAILED` 必然到达用户侧（warn 通道）', async () => {
  captureOn();
  const { root } = await realStack(9999, HIST);
  const { persistence } = setupHotnessPersistence(root);
  const t0 = Date.now();
  while (Date.now() - t0 < 12000 && !sinkWarn.some((l) => l.includes('hotness restore FAILED'))) await sleep(100);
  const warns = [...sinkWarn];
  const others = [...allLines()];
  captureOff();
  const hit = warns.filter((l) => l.includes('hotness restore FAILED'));
  assert.equal(persistence.restored, false, 'open 一直被拒却报告已恢复');
  assert.ok(hit.length >= 1,
    `默认阈值下必须看得见 FAILED（warn 命中 ${hit.length}；全通道命中 ${others.filter((l) => l.includes('FAILED')).length}）`
    + ' ⇒ 命中全通道但不在 warn 上 = 还挂在 info，#88 现场仍然拿不到锚点');
  assert.match(hit[0] ?? '', /\[dsh-suggest-ghost\]\[ops-trace\]/, '前缀必须与 ops-trace 一致（现有 grep 口径不许漂）');
  assert.match(hit[0] ?? '', /fiber=\d+/, '恢复锚点必须带 fiber 序号（#88 的「谁卡住了」靠它配对）');
});

// —— 2. 级别切分本身钉死：只有那两条走 warn，其余一律不带级别参数（= info） ——
// 这一条是防"顺手把整组提级"的机器闸：场景 3 只能证明**当下**没变吵，证明不了将来。
await scenario('级别切分：产物里恰好两处 hotnessTrace(…, \'warn\')，且必须是那两条告警', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../lib/hotness-store.js', import.meta.url), 'utf8');
  // 整调用扫描（含续行）：单行匹配会被"换个行"绕过，这道闸量的是"哪些调用点是 warn"，
  // 不是"哪一行写着 warn"。
  const callSites = [];
  {
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      if (!/hotnessTrace\(/.test(lines[i]) || /const hotnessTrace =/.test(lines[i])) continue;
      let text = lines[i];
      for (let k = i + 1; k < lines.length && k < i + 8; k += 1) {
        text += ' ' + lines[k];
        if (/\);/.test(lines[k])) break;
      }
      callSites.push([i + 1, text]);
    }
  }
  const calls = callSites;
  const warned = calls.filter(([, t]) => /,\s*'warn'\s*\)/.test(t));
  // #88 续：warn 集合现在恰好是这五条 —— 两条原有失败 + 三条「不吭声就会静默丢数据」的
  const needles = ['hotness domain unavailable', 'hotness restore FAILED',
    'hotness persistence absent', 'hotness restore grace elapsed', 'hotness dirty cap cleared'];
  assert.ok(warned.length >= 1,
    `没有任何 hotnessTrace 走 warn ⇒ #97 的提级没落地（共 ${calls.length} 个调用点）`);
  for (const n of needles) {
    assert.ok(warned.some(([, l]) => l.includes(n)),
      `缺「${n}」的 warn 提级（warn 命中=${JSON.stringify(warned.map(([, l]) => l.trim().slice(0, 60)))}）`);
  }
  const wrong = warned.filter(([, l]) => !needles.some((n) => l.includes(n)));
  assert.equal(wrong.length, 0,
    `有多余的调用点被提到 warn（${JSON.stringify(wrong.map(([, l]) => l.trim().slice(0, 70)))}）`
    + ' ⇒ 状态类变吵会把 #98 的降噪成果废掉');
  // 默认值也要钉住：只数「显式传 warn 的调用点」抓不到**把默认翻成 warn**这种更糟的改法。
  // 实测变异（`level = 'info'` ⇒ `level = 'warn'`，2 处）：上面几条全绿，只有场景 4 能发现；
  // 把默认值也钉上，静态这道闸才算完整。
  assert.match(src, /const hotnessTrace = \(message, level = 'info'\)/,
    '本 fiber 通道的默认级别必须仍是 info（翻成 warn = 整组状态迁移变吵，#98 的降噪成果作废）');
  assert.match(src, /const hotnessTraceLine = \(message, level = 'info'\)/,
    'hotnessTraceLine 的默认级别必须仍是 info（同上）');
});

// —— 3. 现状钉住（**含已知缺口**）：完全没有 storageDomain 服务的宿主 ⇒ 恢复流程零留痕 ——
// —— 3. #88 未闭合那半（已修）：完全没有 storageDomain 的宿主，默认阈值下必须开口 ————
// 原来的缺口：那句 `domain unavailable` 写在 `ctx.inject(['storageDomain'])` 回调里，
// 无该服务时回调不跑；而 `restoreStatus` 初始就是 'unavailable'（非 'pending'）⇒ 5s 兜底
// 也被 `if (restoreStatus === 'pending')` 挡掉 ⇒ 「这组宿主根本没有持久层」在默认阈值下看不见。
// 现在判定挪到回调外：宽限期到点且**回调一次没跑过** ⇒ warn 一行，并把 ready 兑现。
await scenario('无 storageDomain 服务：默认阈值下必须出现 warn 级「persistence absent」，且 whenReady 不许被兑现（不凭空多一次写）', async () => {
  delete process.env.DSH_SUGGEST_GHOST_TRACE; // **默认阈值**：这条判据的全部意义就是不开档也要看得见
  captureOn();
  const { root } = await realStack(0, HIST, false);
  const { persistence } = setupHotnessPersistence(root);
  const t0 = Date.now();
  while (Date.now() - t0 < 9000 && !warnSinkHas('hotness persistence absent')) await sleep(100);
  const waitedMs = Date.now() - t0;
  const hot = allLines().filter((l) => l.includes('hotness'));
  const onWarn = sinkWarn.filter((l) => l.includes('hotness persistence absent'));
  const state = { status: persistence.status, restored: persistence.restored, ready: persistence.ready };
  captureOff();
  assert.ok(onWarn.length === 1,
    `「没有持久层」必须且只能出现一行 warn（实际 warn 命中 ${onWarn.length}；全部 hotness 行=${hot.length}）`
    + ' ⇒ 回到 info 就等于又看不见（#88 的原始症状）');
  assert.match(onWarn[0] ?? '', /fiber=\d+/, '要带 fiber 序号，否则多 fiber 下分不清是谁');
  assert.match(onWarn[0] ?? '', /仅内存|in-memory/, '要说清楚后果：本 fiber 的累积不会落盘');
  assert.equal(state.status, 'unavailable', `状态仍是 unavailable（实际=${state.status}）`);
  assert.equal(state.restored, false, '没有持久层却报告已恢复');
  // ⚠️ 断的是 **whenReady 兑现**，不是 `ready` 布尔。两者不是一回事，我第一版断错了：
  //  - `ready` 的语义是「持久层可用且恢复已跑完」⇒ 没有服务时它**就该**是 false；
  //    而且 `flush()` 的第一道门是 `table === null`（压根没有介质可写），
  //    所以「!ready 直接 return」在无服务时并不造成额外损失。
  //  - 真正会「一直等」的是 **whenReady**（消费方据此补推完整快照）⇒ 这条才是 #88 说的兑现。
  // `whenReady` 在这一支**不该**兑现（接口的既定语义），而且这条有实测代价撑着：
  // 兑现版会在宽限期到点时触发一次 `hotNow` 补推 ⇒ 凭空多一次热度格写，
  // 把 `hot-throttle-smoke` 场景 5（"窗口未到期的 pull 立刻写一次热度格"）直接打红。
  // 所以判据是「开口但不改时序」：warn 必须到，whenReady 必须**不**兑现。
  const settled = await Promise.race([
    persistence.whenReady.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 800)),
  ]);
  assert.equal(settled, false,
    '无持久层时 whenReady 被兑现 ⇒ 会凭空触发一次 hotNow 补推（#102 的 throttle 冒烟实测会红）');
  console.log(`  ✓ 判据在默认阈值下满足；等待 ${waitedMs}ms（= 宽限期 ${'5'}s，兜底语义）`);
});

// —— 4. 反向：正常 boot 在默认阈值下**不得**把状态类刷出来（#98 的降噪成果） ——
await scenario('反向（不许变吵）：默认阈值 + 正常 boot ⇒ 四条状态迁移一律静默', async () => {
  captureOn();
  const { root } = await realStack(0, HIST);
  const { persistence } = setupHotnessPersistence(root);
  const t0 = Date.now();
  while (Date.now() - t0 < 8000 && !persistence.restored) await sleep(80);
  // 再多等一会儿：状态行若被误提级，它们会在这段里出现
  await sleep(600);
  const warns = [...sinkWarn];
  const infos = [...sinkInfo];
  const debugs = [...sinkDebug];
  captureOff();
  assert.equal(persistence.restored, true, '正常 boot 没恢复成功 ⇒ 这一组样本无效（不是"静默"，是"没跑到"）');
  const leaked = warns.filter((l) => /hotness domain opened|hotness restored|hotness ready|domain busy, retrying|hotness persistence absent|hotness restore grace|dirty cap cleared/.test(l));
  assert.equal(leaked.length, 0,
    `状态类被提级了（warn 命中 ${JSON.stringify(leaked.slice(0, 2))}）⇒ 健康进程会重新刷回 #98 清掉的噪声`);
  const alsoSilent = [...infos, ...debugs].filter((l) => /hotness domain opened|hotness restored|hotness ready/.test(l));
  assert.equal(alsoSilent.length, 0,
    `默认阈值下 info/debug 通道也不该有状态行（命中 ${JSON.stringify(alsoSilent.slice(0, 2))}）`);
});

// —— 5. 第三向：`=debug` 时四条状态行必须照样在 ⇒ 第 4 条是"静音"不是"删除" ——
await scenario('`=debug`：四条状态迁移全部可见（证明第 4 条是阈值静音，不是留痕被删）', async () => {
  process.env.DSH_SUGGEST_GHOST_TRACE = 'debug';
  try {
    captureOn();
    const { root } = await realStack(0, HIST);
    const { persistence } = setupHotnessPersistence(root);
    const t0 = Date.now();
    while (Date.now() - t0 < 8000 && !persistence.restored) await sleep(80);
    const lines = [...allLines()];
    captureOff();
    for (const needle of ['hotness domain opened', 'hotness restored', 'hotness ready']) {
      assert.ok(lines.some((l) => l.includes(needle)),
        `=debug 下缺「${needle}」（全通道 ${lines.length} 行）⇒ 状态类留痕被删了，不只是静音`);
    }
    assert.ok(lines.some((l) => /hotness restored n=\d+ tableSize=\d+/.test(l)), 'restored 行要带 n= 与 tableSize=');
    assert.ok(lines.some((l) => /hotness ready dirty=\d+ restored=\w+/.test(l)), 'ready 行要带 dirty= 与 restored=');
  } finally {
    delete process.env.DSH_SUGGEST_GHOST_TRACE;
  }
});

// 自收临时目录（失败也要收）
for (const d of tempDirs) {
  try { (await import('node:fs')).rmSync(d, { recursive: true, force: true }); } catch { /* 忽略 */ }
}
console.log(`· 已回收 ${tempDirs.length} 个临时存储目录`);
console.log(results.join('\n'));
// —— 6. #88 续：那条护栏丢的是真实累积 ⇒ 默认阈值下必须看得见，且三个计数都在 ——
await scenario('dirty cap cleared：默认阈值下走 warn，带 n= / clears= / droppedTotal=', async () => {
  delete process.env.DSH_SUGGEST_GHOST_TRACE;
  captureOn();
  const { root } = await realStack(0, HIST, false);
  const { hotness, persistence } = setupHotnessPersistence(root);
  const over = HOT_TABLE_MAX_ENTRIES * 2 + 3;
  for (let i = 0; i < over; i += 1) hotness.recordUserText(`帽${i}`, i + 1, 'sx');
  await sleep(300);
  const capWarn = sinkWarn.filter((l) => l.includes('dirty cap cleared'));
  const counters = persistence.dirtyCapCleared;
  captureOff();
  assert.ok(capWarn.length >= 1,
    `撞了 ${over} 条脏标记（上限 ${HOT_TABLE_MAX_ENTRIES * 2}）却零 warn ⇒ 静默丢累积又回来了`);
  assert.match(capWarn[0] ?? '', /n=\d+/, `缺 n=（实际=${capWarn[0] ?? '无'}）`);
  assert.match(capWarn[0] ?? '', /clears=\d+/, '缺 clears= 累计次数');
  assert.match(capWarn[0] ?? '', /droppedTotal=\d+/, '缺 droppedTotal= 累计条数');
  assert.ok(counters.dropped >= HOT_TABLE_MAX_ENTRIES * 2,
    `取数口没长（${JSON.stringify(counters)}）⇒ 留痕与真实丢弃可能不同源`);
  console.log(`  ✓ warn ${capWarn.length} 行，累计=${JSON.stringify(counters)}`);
});

console.log(failed === 0
  ? '✅ hotness-trace-level-smoke: 三向都钉住（真失败默认可见 / 无持久层默认可见 / 状态类默认仍静默、=debug 可取回）'
  : `❌ hotness-trace-level-smoke: ${failed} 条失败`);
process.exit(failed === 0 ? 0 : 1);
