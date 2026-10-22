#!/usr/bin/env node
/**
 * `_push` 载荷拆分（#36 建议 2）：一格一指纹、两格合并成一次写，并把「写次数 / 每格
 * 字节数」量成一张**前后同一把尺子**的表。
 *
 * ## 这条线真正要验的两件事
 *
 * 目标**不是**「载荷变小」。写实耗的主导成本是整档 profile 重写（本机 profile 文档
 * 26,639–34,274 字符、58 个命名空间），不是那 3.1KB 的载荷。被真正改掉的是：
 *  1. **纯热度变化不再连带重写建议格** —— 于是客户端也不会「被热度过期带着重算建议幽灵」。
 *     注意：拆了格子却仍按整体算指纹的话，这条收益**不会发生**，而 `bytes=` 照样会降 ⇒
 *     数据看着像成功。所以下面断言的是「哪一格被写了」，不是「字节小了」；
 *  2. **两格都脏时仍然一次 `settings.update` 带两个键**（piggyback）。口径要说准，
 *     别沿用本条最初的错判：合并**不是**为了「少一次整档重写」。probe-hmr 第二次复核
 *     （沙箱、#50 修复后的产物）量到补写泵**不排队**——泵在事务外，每 500ms 无脑调一次
 *     `update()`，前一笔在途时不 await、不延后，锁串行发生在内核 `withFileLock` 内部
 *     （事务外单写一笔 191~332ms）。所以各写各的**最坏是多等一个 500ms tick**，
 *     不是「一次整档重写变两次」。合并真正省下的是**客户端一次重解析**：一次
 *     `describe()` 回来就是两格的完整当前状态。写次数照旧报（每回合一次是后续
 *     「要不要给 `_hot` 加节流」的唯一输入，节流会带来客户端热度陈旧窗口）。
 *
 * ## 前后对比：同一份脚本，换的是产物
 *
 *   拆分前：GHOST_PAYLOAD_REPO=<origin/main 的检出> node scripts/payload-split-smoke.mjs
 *   拆分后：node scripts/payload-split-smoke.mjs
 *
 * 旧产物没有 `_hot` 这一格，所以对它的**判定**自动降级成「只打印不判定」并显式标注
 * （「没验到的不得写成通过」，与 `ghost-frame-e2e.mjs` 同一口径）。
 *
 * ## 场景怎么造（不起浏览器、不接真模型）
 *
 * 回合由 `session.append('turn/end')` 造（同 `coldstart-e2e.mjs:351` 的手法），建议由
 * **假 llm** 产出（流形状照 dsh-llm 原始协议：delta 字段名是 `text`、`finish.reason`
 * 是**对象** —— 写成字符串会抛 `unsupported finish reason`，现象与「模型没话说」同形），
 * 路由由配置里的显式 provider/model 提供（否则 `routeOf` 会去要 `session.requestHeader()`，
 * 那是与本条无关的前置）。
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context, Service } from '@deepseek-ai/cordis';
import { SessionStore } from '@deepseek-ai/dsh-session';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = process.env.GHOST_PAYLOAD_REPO ?? join(HERE, '..');
const libDir = join(REPO, 'lib');
if (!existsSync(join(libDir, 'index.js'))) {
  console.error(`❌ 找不到构建产物：${libDir}/index.js（先 tsc + node build.mjs）`);
  process.exit(1);
}
const { apply: applyHost } = await import(join(libDir, 'index.js'));

const NS = 'suggest-ghost';
const SESSION = 'session-a';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 产物里有没有 `_hot` 这一格 ⇒ 决定本次是「判定」还是「只打基线」。 */
const hostSource = readFileSync(join(REPO, 'src', 'index.ts'), 'utf8');
/** 产物里有没有 `_hot` 这一格 ⇒ 决定本次是「判定」还是「只打基线」。 */
const BASELINE = !hostSource.includes('_hot:');

let failed = 0;
const run = (name, fn) => {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}\n      ${String(error.message).split('\n')[0]}`);
  }
};

// ── 内存 settings 介质 + 假服务（形状依据同 coldstart-e2e.mjs 的同名实现）────────
function makeMedium(initial = {}) {
  let document = structuredClone(initial);
  const writes = [];
  return {
    writes,
    read: (ns) => structuredClone(document[ns] ?? {}),
    merge(ns, patch) {
      document = { ...document, [ns]: { ...document[ns], ...structuredClone(patch) } };
      writes.push({ ns, patch: structuredClone(patch) });
    },
  };
}

function installSettingsService(root, medium) {
  class MemorySettings extends Service {
    revision = 0;
    constructor(ctx) { super(ctx, 'settings'); }
    describe() {
      return [{ ns: NS, revision: this.revision, value: medium.read(NS) }];
    }
    /** 写介质后按内核时序 emit —— 插件的 `_ops` 消费与实时值都靠这个事件。 */
    update(ns, patch) {
      medium.merge(ns, patch);
      this.revision += 1;
      this.ctx.emit('settings/document-updated', ns, this.revision);
      return Promise.resolve();
    }
  }
  return new MemorySettings(root);
}

/** 假 llm：流形状由本脚本决定，所以「建议变了 / 没变」是可精确制造的。 */
function installFakeLlm(root, holder) {
  class FakeLlm extends Service {
    constructor(ctx) { super(ctx, 'llm'); }
    stream(options) {
      holder.requests.push(options);
      const chunks = holder.chunks;
      return (async function* emit() {
        for (const chunk of chunks) {
          await sleep(2);
          yield chunk;
        }
      })();
    }
  }
  return new FakeLlm(root);
}

const textStream = (text) => [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text },
  { type: 'block-end', index: 0, block: { type: 'text', text } },
  { type: 'finish', reason: { kind: 'stop' } },
];

function makeSession(store, id) {
  const session = store.create(id, { meta: { cwd: process.cwd() } });
  /** 造一个已完成回合：用户消息进热表与历史环，turn/end 触发插件的生成路径。 */
  session.nextTurn = (turn, text) => {
    session.append('turn/start', { turn });
    session.append('user/message', {
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    }, { surfaceOp: 'append' });
    session.append('turn/end', { turn, reason: { kind: 'completed' } });
  };
  return session;
}

// ── 留痕捕获（`bytes=` / `hotBytes=` / `cells=` 都从这来）──────────────────────
const traced = [];
const realLog = console.log;
console.log = (...args) => {
  const line = args.map(String).join(' ');
  if (line.includes('[ops-trace]')) traced.push(line);
  else realLog(...args);
};

/** 一次写携带了哪几格、各多少字节。 */
const cellsOf = (w) => ({
  push: typeof w.patch._push === 'string' ? w.patch._push.length : null,
  hot: typeof w.patch._hot === 'string' ? w.patch._hot.length : null,
});
/** 推送写（排除只动 `_ops` 的那种清空写）。 */
const pushWrites = (ws) => ws.map(cellsOf).filter((c) => c.push !== null || c.hot !== null);

/** 全程写留痕（`medium.writes` 会被 bootProcess 清空，跨「重启」的核对项必须自己攒）。 */
const allWrites = [];
const table = [];
const record = (scenario, writes) => {
  allWrites.push(...writes);
  const cells = pushWrites(writes);
  table.push({
    场景: scenario,
    写次数: cells.length,
    建议格被重写: cells.filter((c) => c.push !== null).length,
    热度格被重写: cells.filter((c) => c.hot !== null).length,
    建议格字节: cells.map((c) => c.push ?? '-').join('/'),
    热度格字节: cells.map((c) => c.hot ?? '-').join('/'),
    // 兼容旧列名（前面对比表用过）：删掉，避免同一件事两张表头。
  });
  return cells;
};

const holder = { chunks: textStream('跑一下冒烟'), requests: [] };
const medium = makeMedium();

/**
 * 装一个「进程」；介质复用 = 重启后盘上还是那份。
 * @param turns - 会话日志里的回合（重启的那个进程**必须**给同一份，否则盘上建议所属
 *   的回合号在新进程里根本对不上，测出来的「又写一遍」是夹具的错而不是宿主的错）。
 */
async function bootProcess(turns = []) {
  const root = new Context();
  if (root.logger === undefined) root.logger = { info() {}, warn() {}, debug() {} };
  new SessionStore(root);
  const settings = installSettingsService(root, medium);
  installFakeLlm(root, holder);
  const session = makeSession(root.sessions, SESSION);
  // 回合在 apply **之前**补完：与真实重启一致（日志已在盘上，进程起来先回读）。
  turns.forEach((text, i) => session.nextTurn(i + 1, text));
  medium.writes.length = 0; // 上一个进程留下的写不算进本场景
  applyHost(root, {
    maxInputBytes: 4096,
    maxOutputTokens: 512,
    timeoutMs: 2000,
    maxTranscriptChars: 12000,
    maxSuggestionChars: 240,
    provider: 'p-smoke',
    model: 'm-smoke',
  });
  await sleep(60); // settings 注入 + 启动回读
  return { root, session, settings };
}

/** 客户端写 `_ops`（宿主消费并应答）。 */
async function clientOp(settings, ops, tag) {
  const before = medium.writes.length;
  await settings.update(NS, { _ops: JSON.stringify({ rev: tag, ops, locale: 'zh' }) });
  await sleep(80);
  return medium.writes.slice(before);
}

// ── 进程一 ────────────────────────────────────────────────────────────────────
const seenTurns = [];
let p2Ref = [];
const proc = await bootProcess();

/** 跑一个回合（记录到 seenTurns，供重启那个「进程」复放同一份日志）。 */
async function turn(n, text) {
  const before = medium.writes.length;
  seenTurns.push(text);
  proc.session.nextTurn(n, text);
  await sleep(500);
  return medium.writes.slice(before);
}

// ① 首个回合：建议 + 热度 + 历史**同时**变 ⇒ 一次写带两格（piggyback）
const p1 = record('① 首个回合（建议与热度同时变）', await turn(1, '第一句'));

// ② **纯热度变化**：不跑回合，只往热表加一条短语，然后 pull 一次。
//    这是拆分收益的唯一判据场景 —— 建议格必须**一字不动**（连 rev 都不该顶一格）。
//    早先我拿「新回合但建议文本没变」当这个场景，那是错的：新回合本身就换 turn 号，
//    建议格必然变，于是测出「两格都写」会被误读成拆分白做。
{
  const before = medium.writes.length;
  await clientOp(proc.settings, [{ op: 'add', text: '顺手加一条高频短语' }], 20);
  await sleep(60);
  const opWrites = medium.writes.slice(before);
  const beforePull = medium.writes.length;
  await clientOp(proc.settings, [{ op: 'pull', sessionId: SESSION }], 21);
  const p2all = [...pushWrites(opWrites), ...pushWrites(medium.writes.slice(beforePull))];
  // 走与其余场景同一个 record()：列名/口径一份定义，避免这张表自己长出第二种表头。
  record('② 纯热度变化 + pull（建议格未变）', [...opWrites, ...medium.writes.slice(beforePull)]);
  p2Ref = p2all;
}

// ③ 什么都没变：同一会话再 pull 一次 ⇒ 一次写都不发
const p3 = record('③ 重复 pull（状态未变）', await (async () => {
  const before = medium.writes.length;
  await clientOp(proc.settings, [{ op: 'pull', sessionId: SESSION }], 30);
  return medium.writes.slice(before);
})());

// ④ 建议变了（假流换一句）**且**热度也变 ⇒ 一次写带两格
const before4 = medium.writes.length;
holder.chunks = textStream('先把 diff 看一遍');
await turn(2, '第二句');
const p4 = record('④ 建议变了（顺带热度也变）', medium.writes.slice(before4));

// ⑤ 重启：新进程看到同一份会话日志与同一份盘上载荷 ⇒ 第一次 pull 不重写建议格
const proc2 = await bootProcess([...seenTurns]);
const before5 = medium.writes.length;
await clientOp(proc2.settings, [{ op: 'pull', sessionId: SESSION }], 50);
const p5 = record('⑤ 重启 + 第一次 pull', medium.writes.slice(before5));

/**
 * 无信息量的重复写（#56 与节流的共同基线项）。
 *
 * 口径必须是「**去掉 rev 之后**逐字相同」：rev 每写一次就 +1，它是给客户端的排序/诊断标识，
 * 不是信息。拿原始字节比原始字节 ⇒ 任何两次写都「不一样」，这个数会恒等于 0%，然后被读成
 * 「没有浪费」—— 那正是要避免的假阴性。反过来，按格判重成立时它**必须是 0**，所以这条
 * 断言式的计数是判重的自证，不是收益上界。
 */
const stripRev = (raw) => {
  if (typeof raw !== 'string' || raw === '' || raw === 'null') return null;
  try {
    const box = JSON.parse(raw);
    delete box.rev;
    return JSON.stringify(box);
  } catch {
    return raw;
  }
};
const audit = (() => {
  let redundant = 0;
  let cellWrites = 0;
  let hotOnlyWrites = 0;
  let pushWritesTotal = 0;
  const lastByCell = {};
  for (const w of allWrites) {
    for (const cell of ['_push', '_hot']) {
      const info = stripRev(w.patch[cell]);
      if (info === null) continue;
      cellWrites += 1;
      if (lastByCell[cell] === info) redundant += 1;
      lastByCell[cell] = info;
    }
    const cells = pushWrites([w])[0];
    if (cells === undefined) continue;
    pushWritesTotal += 1;
    if (cells.push === null && cells.hot !== null) hotOnlyWrites += 1;
  }
  return { redundant, cellWrites, hotOnlyWrites, pushWritesTotal };
})();

restoreAndReport();

function restoreAndReport() {
  console.log = realLog;
  console.log(`\n产物来源：${REPO}${BASELINE ? '（基线：无 `_hot` 这一格 ⇒ 只打印不判定）' : '（拆分后）'}`);
  console.table(table);
  const suggestionBytes = [...p1, ...p2Ref, ...p3, ...p4, ...p5]
    .filter((c) => c.push !== null).map((c) => c.push);
  // 主指标：**建议格被重写的次数**。拆分前它是「每次推送都被顺带重写」，拆分后只有
  // 建议本身真的变了才写 —— 这才是收益 1 的可量面。写次数一并报（持平即持平，不硬凑）。
  console.log(`主指标 · 建议格被重写次数：${[...p1, ...p2Ref, ...p3, ...p4, ...p5].filter((c) => c.push !== null).length} / ${table.length} 个场景`
    + ` · 建议格字节：${suggestionBytes.length ? `${Math.min(...suggestionBytes)}–${Math.max(...suggestionBytes)} B` : 'n/a'}`);
  console.log(`热度格字节随回合增长：${[...p1, ...p2Ref, ...p3, ...p4, ...p5].filter((c) => c.hot !== null).map((c) => c.hot).join(' → ') || 'n/a'}`);
  // 两个数分开看：左边（lead 的原始口径）按格判重成立时必须是 0；真正决定节流上界的是
  // 右边 —— 只有「只由热度格驱动的写」能被窗口吃掉，携带建议格的写必须落。
  console.log(`无信息量重复写（去 rev 后与上次落盘逐字相同）：${audit.redundant} / ${audit.cellWrites} 格次`);
  console.log(`只由热度格驱动的写：${audit.hotOnlyWrites} / ${audit.pushWritesTotal} 次 ⇒ 节流的上界`);
  console.log('留痕样本（最后 6 条 landed / refused）：');
  for (const l of traced.filter((x) => /landed|refused/.test(x)).slice(-6)) console.log(`  ${l}`);
}

if (!BASELINE) {
  run('① 两格同时脏 ⇒ **一次**写带两个键（piggyback：拆分不加写次数）', () => {
    assert.equal(p1.length, 1, `首个回合应当一次写带两格，实得 ${JSON.stringify(p1)}`);
    assert.ok(p1[0].push !== null && p1[0].hot !== null, `那一笔写必须同时带两格：${JSON.stringify(p1[0])}`);
  });
  run('② 纯热度变化：写里**不带建议格**（拆分的全部意义）', () => {
    assert.ok(p2Ref.length >= 1, '热度变了却没写出去 ⇒ 客户端会停更');
    assert.equal(p2Ref.filter((c) => c.push !== null).length, 0,
      `一次纯热度变化重写建议格 = 白拆：${JSON.stringify(p2Ref)}`);
  });
  run('② 热度格用自己的留痕前缀（不蹭 `push landed` 的 bytes= 语义）', () => {
    assert.ok(traced.some((l) => /hot push landed .*hotBytes=\d+ .*cells=hot/.test(l)),
      '缺 "hot push landed" 行：' + traced.filter((l) => /landed/.test(l)).join(' | '));
  });
  run('③ 什么都没变 ⇒ 一次写都不发（一格未变就不写那一格）', () => {
    assert.equal(p3.length, 0, `同内容被重复写：${JSON.stringify(p3)}`);
  });
  run('④ 建议变化仍然落得出去（拆分没把建议格写丢）', () => {
    assert.ok(p4.some((c) => c.push !== null), `建议变了却没写建议格：${JSON.stringify(p4)}`);
  });
  // #50 的「重启后第一次 pull 零写」这条性质，拆成两格之后**按格**判：
  //  - 建议格：必须零写（盘上那条就是当前状态，重写一遍只是把 rev 顶一格）；
  //  - 热度格：本夹具里会写一次，因为进程内的热表是空的（没有 storageDomain 可恢复），
  //    与盘上那份**必然不等**。真机上那份是恢复出来的、相等 ⇒ 那一次也不发生。
  //    这一条**明写为夹具覆盖不到**，不许算成通过，也不许反过来判宿主失败。
  run('⑤ 重启 + 第一次 pull：建议格零写（#50 的性质在新格子上成立）', () => {
    assert.equal(p5.filter((c) => c.push !== null).length, 0,
      `重启后第一次 pull 重写了建议格（盘上那份就是当前状态）：${JSON.stringify(p5)}`);
  });
  console.log('  ⚪ ⑤b 热度格在重启后写了一次 —— 夹具里没有 storageDomain 可恢复热表，'
    + `与盘上那份必然不等：${JSON.stringify(p5.filter((c) => c.hot !== null))}（NOT-COVERED，不计通过）`);
  run('补写泵的那一笔永远**不带热度格**（多键补丁无法原子回滚，不塞给它）', () => {
    // `drainDeferred` 的 push 分支里，判重/CAS（`decidePushDrain`）只认 `_push` 那一份
    // 字节。若让它顺手带上 `_hot`，「push 判定跳过」这条分支就会把同一笔里的热度格
    // 一起静默丢掉，而内核没有「回滚半笔写」的概念。所以即时写合并、补写不合并。
    //
    // 判据范围在 #56 之后收窄成「不带 `_hot`」而不是「只带一格」：`_residual` 是**必须**
    // 跟着 `_push` 一起走的（不变式：任何一次 `_push` 写之后残留仍在盘上），漏了它
    // 「第一次写被拒 → 入队 → 泵 flush」这一串会把 `_push` 与 `_residual` 同时丢没。
    // 两者性质不同：`_hot` 每帧都被下一帧覆盖（丢了自愈），残留**丢了不可再生**。
    const from = hostSource.indexOf('function drainDeferred(): void {');
    const to = hostSource.indexOf('/** 补写被拒后的统一处置', from);
    const body = hostSource.slice(from, to > from ? to : from + 6000);
    const updates = [...body.matchAll(/\.update\(SUGGEST_GHOST_NAMESPACE, (?:\{([^}]*)\}|(\w+))/g)]
      .map((m) => (m[1] !== undefined ? m[1] : m[2]).trim());
    assert.ok(updates.length >= 2, `泵里应当能看到补写的 update 调用，实得 ${JSON.stringify(updates)}`);
    for (const u of updates) {
      assert.ok(!u.includes('_hot'), `补写带上了热度格（无法原子回滚）：{ ${u} }`);
    }
    // #56 那条「泵写 `_push` 必须同批带上 `_residual`」**不在这里钉**：源码形状断言太脆
    // （实现换个写法就红，而行为没变）。它由 scripts/residual-carry-smoke.mjs 的场景 6 用
    // 行为钉：让第一笔写真的被拒、让泵真的补写，再断言残留仍在盘上。
    // 实测把 `attachResidualCell(drainedPatch)` 删掉 ⇒ 场景 6 当场红，且红的就是那条路径
    // （盘上 `_push` 变成 B 视角而哪一格都没有残留）。
  });
  run('客户端读侧守卫在场：建议格原文未变 ⇒ 不重解析、不重跑帧判据', () => {
    // **代码断言，不是行为断言**：拆格之后收益 1 的可量面是「客户端不必为一次纯热度
    // 变化重判建议帧/换建议对象引用」，但那要真实浏览器 + 一次真实渲染才量得到
    // （#54 那条口径）。这里先钉住守卫确实存在，行为侧留待接线层 e2e 补。
    const client = readFileSync(join(REPO, 'src', 'client', 'index.ts'), 'utf8');
    assert.ok(client.includes('pushCellChanged'), '客户端没有「建议格变没变」这道判据');
    assert.ok(/lastPushRaw = pushRaw/.test(client), '没有按 `_push` 原文判重（那等于每来一次事件都重解析）');
    assert.ok(/if \(pushCellChanged \|\| lastFrames === null\)/.test(client),
      '帧判据没有在建议格未变时跳过 —— 陈旧帧判据会被纯热度变化反复重跑');
    console.log('     ↑ 代码断言（行为侧需浏览器，见 #54）：未把它算作「收益 1 已实测」');
  });
  run('建议格里不再夹带热度字段（载荷形状本身就是判据）', () => {
    // 「字节数不随 hot 数组增长」是这条的**结果**，所以直接验形状而不是验数字：
    // 数字会随会话内容浮动，而「建议格里没有 hot/total/history 这三个键」不会。
    const raw = medium.read(NS)._push;
    assert.ok(typeof raw === 'string' && raw !== 'null', '盘上没有建议格载荷');
    const box = JSON.parse(raw);
    for (const key of ['hot', 'total', 'history', 'historySessionId']) {
      assert.ok(!(key in box), `建议格里还带着 ${key} ⇒ 两格没拆干净：${Object.keys(box).join(',')}`);
    }
    for (const key of ['suggestion', 'suggestionSessionId', 'rev']) {
      assert.ok(key in box, `建议格缺了本该由它带的 ${key}`);
    }
    const hot = JSON.parse(medium.read(NS)._hot);
    assert.ok('hot' in hot && 'total' in hot, `热度格形状不对：${Object.keys(hot).join(',')}`);
    assert.ok(!('suggestion' in hot), '热度格不该反向携带建议');
  });
}

if (failed > 0) {
  console.error(`❌ payload-split-smoke: ${failed} 组失败`);
  process.exit(1);
}
// **必须显式退出**：`apply()` 期建的补写泵（`setInterval(drainDeferred, 500)`）设计上跨
// apply 存活、只在真卸载时 clear，夹具里没有卸载这一步 ⇒ 事件循环永远排不空，
// `test:smoke` 那条 `&&` 链会被本脚本挂住（实测：打印完 ✅ 之后链不再往下走）。
// 同一个坑 `coldstart-e2e.mjs` 尾部有记录，这里照它的做法收口，不指望 asyncDispose。
console.log(BASELINE
  ? '✅ payload-split-smoke（基线）：前后对比表已打印，判定按设计跳过（产物里没有 `_hot`）'
  : '✅ payload-split-smoke: 两格各自判重、合并成一次写、热度不连带重写建议格、重启零写 —— 全部通过');
process.exit(0);
