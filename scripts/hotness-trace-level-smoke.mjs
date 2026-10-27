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
  const calls = src.split('\n')
    .map((l, i) => [i + 1, l])
    .filter(([, l]) => /hotnessTrace\(/.test(l) && !/const hotnessTrace =/.test(l));
  const warned = calls.filter(([, l]) => /,\s*'warn'\s*\)/.test(l));
  const needles = ['hotness domain unavailable', 'hotness restore FAILED'];
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
// 未覆盖项，说清楚：`hotness domain unavailable` 这行**运行时不可达** —— 它在
// `ctx.inject(['storageDomain'], …)` 的回调里，而注入回调只在服务被提供时才跑；
// 没有该服务 ⇒ 回调不跑，`restoreStatus` 停在初始值 'unavailable'（不是 'pending'），
// 于是 5s 兜底那行 `restore grace elapsed` 也被 `if (restoreStatus === 'pending')` 挡掉。
// 实测（本机，默认阈值，等过 5s 窗口）：hotness 相关留痕 **0 行**、ready=false、
// status=unavailable、restored=false。⇒ 「这组宿主根本没持久层」这件事在默认阈值下
// **仍然看不见**。不在本任务两行范围内 ⇒ 只做现状断言 + 报 lead，不在此修。
await scenario('现状：无 storageDomain 服务 ⇒ 零留痕（把缺口钉成断言，将来偷偷变好/变坏都会红）', async () => {
  captureOn();
  const { root } = await realStack(0, HIST, false);
  const { persistence } = setupHotnessPersistence(root);
  await sleep(6200); // 盖过 HOTNESS_RESTORE_GRACE_MS=5000
  const hot = allLines().filter((l) => l.includes('hotness'));
  const state = { status: persistence.status, restored: persistence.restored, ready: persistence.ready };
  captureOff();
  assert.equal(state.status, 'unavailable', `无持久层时状态必须是 unavailable（实际=${state.status}）`);
  assert.equal(state.restored, false, '无持久层却报告已恢复');
  assert.equal(hot.length, 0,
    `本场景按现状应当零留痕（实际 ${JSON.stringify(hot.slice(0, 2))}）⇒ 若这行开始变红，`
    + '说明缺口被修好了，请把 #97 的评论一并更新，别让它停留在"看不见"');
  console.log(`  NOT-COVERED  \`hotness domain unavailable\` 的运行时路径（ctx.inject 门后，无该服务时不可达；已报 lead）`);
  console.log(`              实测状态：${JSON.stringify(state)}，留痕行数=${hot.length}`);
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
  const leaked = warns.filter((l) => /hotness domain opened|hotness restored|hotness ready|domain busy, retrying/.test(l));
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
console.log(failed === 0
  ? '✅ hotness-trace-level-smoke: 两向都钉住（失败告警默认可见；状态类默认仍静默，=debug 可取回）'
  : `❌ hotness-trace-level-smoke: ${failed} 条失败`);
process.exit(failed === 0 ? 0 : 1);
