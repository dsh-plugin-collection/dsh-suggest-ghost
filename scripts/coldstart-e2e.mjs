// 冷启动端到端：真实 cordis Context + 真实 dsh-session + **内存 settings 面**，
// 跑通「跑到某回合 → 停机 → 重启 → client 冷启动 pull」的完整对账链路。
// 测的是编译产物（src 内部用 .js 推导导入，strip-types 无法直接加载），
// 先构建再跑：`./node_modules/.bin/tsc -p tsconfig.json && node build.mjs`
// （**worktree 里别用 pnpm**：node_modules 是指向主仓的软链，pnpm 的
// runDepsStatusCheck 会因此报依赖错；详见本文件末尾「在 worktree 里跑」一节）。
//
// 用法：node scripts/coldstart-e2e.mjs
//
// ## 0.2.x 迁移（#49）：harness 换面，断言一字未动
//
// 这份脚本原来靠两件事起进程，而它们在 0.1.7+ 都没了：
//  1. `import SettingsProvider from '@deepseek-ai/dsh-settings'` 当基类，再
//     `root.plugin(class extends SettingsProvider { load/persist })` 造一份可写的
//     内存 settings。0.2.x 该包的默认导出换成了 **`SettingsForms`**（它本身就是
//     注册名 `settings` 的 Service，`@deepseek-ai/dsh-settings/lib/index.js:322`、
//     `:330`），`load()/persist()` 那套 provider 面不再存在——所以 `extends
//     SettingsForms` 起出来的东西不是插件要的那个服务，`root.settings` 也就一直是
//     undefined。
//  2. `root.settings.register(ns, schema, options)` 拦截来「捕获插件自己的 scope」。
//     `ctx.settings.register()` 在 **0.1.7 就被内核删除**了（本仓 `src/index.ts:76`
//     自己记着这条：命名空间不再由插件注册，而是内核把插件 Config 投影成表单，
//     ns = Loader 条目 id = `suggest-ghost`）。这就是 issue #49 那条
//     `TypeError: Cannot read properties of undefined (reading 'register')`。
//
// 现在按 0.2.x 的真实面装配：注册一个名为 `settings` 的内存 Service，提供插件实际
// 读取的那三个成员（`src/index.ts:472-480` 的 `ctx.inject(['settings'])` 取服务、
// `readOps()` 走 `describe()` 的行 `{ns, revision, value}`、写侧走
// `update(ns, patch)`），并在写入后 emit `settings/document-updated(ns, revision)`
// ——与真实 `SettingsForms` 的时序一致（内核也是在写盘路径里就地 emit，见
// `src/index.ts:1206-1214` 那段取证）。**载荷的读写面没有变**：`_push` / `_ops`
// 仍是同一个 ns 里的两个 JSON 字符串，所以下面五个小节的断言一个字都不用改。
import assert from 'node:assert/strict';
import { Context, Service } from '@deepseek-ai/cordis';
import { SessionStore } from '@deepseek-ai/dsh-session';
import { apply as applyHost, inject as hostInject, name as hostName } from '../lib/index.js';
// 留痕自 2026-10-26 起分级：默认只有 warn/error 到达用户侧（心跳类走 console.debug 静默）。
// 本脚本靠抓 `[ops-trace]` 文本断言行为，故在加载插件前把门槛放到 debug。
// 这是**测试自己开档**，不改生产默认。
process.env.DSH_SUGGEST_GHOST_TRACE ??= 'debug';

/** 插件的 settings 命名空间：0.1.7 起 = Loader 条目 id（内核把插件 Config 投影成表单）。 */
const NS = 'suggest-ghost';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 把插件自己的 ops-trace 留痕**旁路抄一份**（不吞原输出）。
 *
 * 为什么需要：#36 建议 2 之后，「第一次 pull 带上了盘上那条建议」这件事在写留痕里
 * 可能**一个字节都不出现**（内容与盘上一致 ⇒ 按格判重直接跳过写）。那行
 * `persisted push restored source=pull` 就成了「确实判过、且把结果并进了应答」的唯一
 * 证据。捕获走 globalThis，是为了让下面的 `tracedFromApply()` 在任何小节里都能读。
 */
globalThis.__ghostTrace = [];
{
  const real = console.log.bind(console);
  console.log = (...args) => {
    const line = args.map(String).join(' ');
    if (line.includes('[ops-trace]')) globalThis.__ghostTrace.push(line);
    real(...args);
  };
}

/**
 * 一个跨「进程」存活的内存 settings 文档：模拟 profile 文档里 `suggest-ghost` 那一节
 * 的持久性（真实宿主上就是 `~/.dsh/profiles/<name>/cordis.patch.yml` 里的两行
 * `_ops:` / `_push:`，见 `src/index.ts:509-510` 的实测记录）。
 * 重启 = 丢掉插件 fiber 与内存状态，但保留这份文档。
 */
function makeMedium(initial = {}) {
  let document = structuredClone(initial);
  /** 每次写的留痕（ns + patch）。断言「某一次写里带了什么」要用它——介质上的**当前**值
   *  会被后一次写覆盖，而「那一次写带了什么」才是被验的那件事。 */
  const writes = [];
  return {
    get document() {
      return structuredClone(document);
    },
    writes,
    /** 读某个 ns 的当前值（`describe()` 的行就报这份）。 */
    read(ns) {
      return structuredClone(document[ns] ?? {});
    },
    /** 写某个 ns 的一段补丁（对齐 `SettingsForms.update` 的 ns + patch 形状）。 */
    merge(ns, patch) {
      document = { ...document, [ns]: { ...document[ns], ...structuredClone(patch) } };
      // 每一笔写都附一份「写完之后的介质」：小节 6 要看的是**那一拍**客户端能读到什么，
      // 而不是等夹具自己的副作用（一次必然失败的生成把建议清掉）跑完之后的终值。
      writes.push({ ns, patch: structuredClone(patch), after: structuredClone(document[ns] ?? {}) });
    },
  };
}

/** 介质上历次写里带过的 `_push` 载荷（按写入顺序）。 */
/** 本小节开始之后插件打过的 ops-trace 行（捕获窗口由 section 自己管）。 */
function tracedFromApply() {
  return (globalThis.__ghostTrace ?? []).slice();
}

/**
 * 历次写里带过 `_push`（建议格）的那些载荷，按写入顺序。
 *
 * 拆格（#36 建议 2）之后仍然只看建议格：这些脚本验的都是「建议有没有被恢复/被清掉」，
 * 而那一格恰恰是唯一会携带建议的。`_hot` 那一格每次都会顺带变（历史环、热表），
 * 把它混进来会让断言变成在比一份永远不同的东西。
 */
function pushWrites(medium) {
  return medium.writes
    .filter((w) => typeof w.patch._push === 'string')
    .map((w) => JSON.parse(w.patch._push));
}

/**
 * 装一个 0.2.x 形状的最小 settings 服务（注册名必须是 `settings`，插件按名注入）。
 *
 * 只实现插件真读的成员：`describe()`（实时值与 `_ops` 载荷的唯一权威源，见
 * `src/index.ts:441-447` 那段「必须走 describe()」的注释）与 `update(ns, patch)`
 * （唯一的写面）。刻意**不做**成 `SettingsForms` 的替身类：真实那份要
 * `configEditor` + `profileContext` 两个服务才能起（`dsh-settings/lib/index.js:323`
 * 的 `static inject`），那是整条 profile 栈，不是这条脚本要验的东西。
 */
function installSettingsService(root, medium) {
  class MemorySettings extends Service {
    revision = 0;
    constructor(ctx) {
      super(ctx, 'settings');
    }
    /** 内核形态：按 ns 展开的行数组，`value` 里是 volatile 字段的裸值。 */
    describe() {
      return [{ ns: NS, revision: this.revision, value: medium.read(NS) }];
    }
    /** 写进介质，然后按内核时序 emit `settings/document-updated(ns, revision)`。 */
    update(ns, patch) {
      medium.merge(ns, patch);
      this.revision += 1;
      this.ctx.emit('settings/document-updated', ns, this.revision);
      return Promise.resolve();
    }
  }
  return new MemorySettings(root);
}

/** 造一个最小会话：给定已完成回合与用户消息。 */
function makeSession(store, id, { turns, userTexts }) {
  const session = store.create(id, { meta: { cwd: process.cwd() } });
  for (let turn = 1; turn <= turns; turn += 1) {
    session.append('turn/start', { turn });
    const text = userTexts[turn - 1];
    if (text !== undefined) {
      session.append('user/message', {
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      }, { surfaceOp: 'append' });
    }
    session.append('turn/end', { turn, reason: { kind: 'completed' } });
  }
  return session;
}

/** 装配一个「进程」：真实 Context + sessions + 内存 settings 面 + 本插件 host 端。 */
async function bootProcess(medium, seed = {}) {
  const root = new Context();
  if (root.logger === undefined) root.logger = { info() {}, warn() {}, debug() {} };
  new SessionStore(root);
  // settings 服务必须在插件 apply 之前就位：`ctx.inject(['settings'])` 是把回调挂成
  // 一个 fiber，服务后建则回调不再触发（真实宿主里 loader 保证服务先于插件）。
  const settings = installSettingsService(root, medium);
  const sessions = root.sessions;
  const sessionId = seed.sessionId ?? 'session-a';
  const sessionSeed = { turns: seed.turns ?? 2, userTexts: seed.userTexts ?? ['第一句', '第二句'] };
  const createSession = () => makeSession(sessions, sessionId, sessionSeed);
  // `lateSession`：会话在插件 apply **之后**才进店 —— 模拟宿主的持久化懒恢复
  // （重启后会话常常还没被加载）。这时启动期的回读**判不了新旧** ⇒ 不得猜、不得清盘，
  // 留给该会话第一次 pull 时补判（小节 6）。
  const session = seed.lateSession === true ? null : createSession();
  // 0.1.7 起没有 register/scope 可拦截；client 读的就是这个 ns 在介质里的值，
  // 所以「插件推出去什么」= 「介质里现在是什么」。scope 这个形态留给下面
  // 第 4、5 小节沿用（`scope.get()._push` / `._ops`），语义与旧版一致。
  const captured = { scope: { get: () => medium.read(NS) } };
  applyHost(root, {
    maxInputBytes: 4096,
    maxOutputTokens: 512,
    timeoutMs: 1000,
    maxTranscriptChars: 12000,
    maxSuggestionChars: 240,
  });
  // 等插件完成 settings 注入 + 启动对账推送。旧判据 `settings.registrations.has(ns)`
  // 随 register 一起没了；改判「服务已经被插件用过一次」——即它的 revision 或
  // describe() 调用计数发生位移，等价于旧版等到注册完成再往下走。
  for (let i = 0; i < 40; i += 1) {
    if (settings.revision > 0) break;
    await sleep(10);
  }
  await sleep(30);
  return { root, session, sessions, captured, settings, createSession };
}

/**
 * 客户端实际拿到的那份状态 = **两格合并后的视图**（#36 建议 2：建议格 `_push` +
 * 热度格 `_hot`）。
 *
 * 断言本体一字不改：它们验的是「client 拿到什么」，变的只是来源——从前是一格，
 * 现在是两格。合并顺序是「建议格覆盖热度格」：两格都带 `rev`，而历史/热度那几个键
 * 只有热度格会有，所以谁覆盖谁不影响任何一条既有断言，只保证读到建议格的当前值。
 */
function pushed(captured) {
  const row = captured.scope?.get() ?? {};
  const cell = (raw) => {
    if (typeof raw !== 'string' || raw === '' || raw === 'null') return null;
    try {
      const v = JSON.parse(raw);
      return typeof v === 'object' && v !== null ? v : null;
    } catch {
      return null;
    }
  };
  const hot = cell(row._hot);
  const push = cell(row._push);
  // 两格都没有 = 「客户端还没有任何状态可读」，报 null（不是 undefined）：小节 1 的
  // 「启动阶段不该凭空写一份状态」就是拿 `=== null` 判的，返回 undefined 会让它红在
  // 一个与语义无关的地方。
  if (hot === null && push === null) return null;
  return { ...(hot ?? {}), ...(push ?? {}) };
}

/**
 * 冷启动对账的**入口**（0.1.7+）：客户端起来后写一条 `pull` 到 `_ops`，宿主应答并覆盖
 * `_push`。旧脚本不需要这一步——0.1.5 时代宿主在 `apply()` 里主动推一次状态，那次推送
 * 就是「client 拿到的第一份状态」。0.1.7 把对账改成 pull 驱动（判据见
 * `src/index.ts:1194-1198`「无论历史环可不可得都应答：静默丢弃会让 client 永远等不到
 * 这一轮对账」），所以每个小节都补这一步，**断言本体一字不改**：它们验的都是
 * 「client 拿到的那份状态长什么样」，只是拿的时机从「宿主自己推」变成「client 问了才答」。
 */
async function coldStartPull(settings, sessionId) {
  await settings.update(NS, {
    _ops: JSON.stringify({ rev: 1, ops: [{ op: 'pull', sessionId }] }),
  });
  // **应答的即时快照**：`_ops` 的消费、按格判重、可能的补写全部排在这次 await 之前
  // （`settings/document-updated` 是同步 emit）。而下面这 60ms 里会插进一件**只属于
  // 夹具**的事——本脚本刻意把会话造成「插件 apply 之后才进店」，插件会把它重放的
  // turn/end 当新回合跑一次生成，那次生成必然失败（没有 LLM 路由），失败路径会把建议清成
  // null。所以「应答里带没带上那条建议」必须在这 60ms 之前取证，否则量到的是夹具的副作用。
  const snapshot = pushed({ scope: { get: () => settings.describe()[0].value } });
  await sleep(60);
  return snapshot;
}

const SESSION = 'session-a';

/**
 * 小节跑一遍：失败**不中断后面的小节**（旧写法第一条崩就什么都看不见，正是 #49 被误读的
 * 原因），但最后仍以退出码 1 收尾。红的小节会打归类，让下一个人一眼分清「已知产品缺陷」
 * 与「harness 没搭对」。
 */
const failures = [];
async function section(no, name, fn, { knownIssue } = {}) {
  try {
    await fn();
    console.log(`\u2705 小节 ${no}\uff1a${name}`);
  } catch (error) {
    const first = String(error instanceof Error ? error.message : error).split('\n')[0];
    failures.push({ no, name, knownIssue });
    console.log(`\u274c 小节 ${no}\uff1a${name}`);
    console.log(`     断言：${first.slice(0, 220)}`);
    console.log(knownIssue
      ? `     归类：**已知产品缺陷 #${knownIssue}** —— 不是 harness 问题，也不是断言写坏`
      : '     归类：未预期，按新缺陷查（先排除上面那两处 0.2.x 迁移没接对）');
    if (knownIssue) {
      console.log(`     这条红是**正确信号**：恢复语义在 #${knownIssue} 跟踪，别用放宽断言换绿。`);
    }
  }
}

// —— 1. 首次启动：无建议、无已知会话 → 只推热度；历史由 pull 按需取 ——
await section(1, '首次启动：应答里无建议，历史归属于被 pull 的会话', async () => {
  const medium = makeMedium();
  const { root, captured, settings } = await bootProcess(medium, { sessionId: SESSION, turns: 2, userTexts: ['第一句', '第二句'] });
  // 0.2.x 的「首次启动不猜当前会话」= 没有 client 来问，宿主就不写 `_push`。
  assert.ok(pushed(captured) === null, '盘上没有残留时，宿主不该在启动阶段凭空写一份状态');
  await coldStartPull(settings, SESSION);
  const p = pushed(captured);
  assert.ok(p !== null, 'client 首次 pull 后应拿到一份状态（应答是冷启动唯一入口，缺它等于冷启动什么都没有）');
  assert.equal(p.suggestion, null, '首次启动无建议');
  // 首次启动 host 不知道「当前会话」（盘上没有建议可归属），历史留给 client 的
  // pull 应答——这正是 pull 存在且必须被应答的意义，见第 5 节。
  assert.equal(p.historySessionId, SESSION, '应答的历史归属于被 pull 的那个会话（不是猜的当前会话）');
  await root[Symbol.asyncDispose]?.();
});

// —— 2. 模拟「停机前的进程」：磁盘上留有一条属于回合 2 的建议 ——
await section(2, '重启对账：盘上残留的上一条建议应被恢复', async () => {
  const persistedPush = JSON.stringify({
    rev: 9,
    suggestion: { turn: 2, baseSeq: 3, text: '跑一下测试', truncated: false, acceptKey: 'Tab', frame: 1, final: true },
    suggestionSessionId: SESSION,
    hot: null,
    total: 0,
    history: ['第一句', '第二句'],
    historySessionId: SESSION,
  });
  const medium = makeMedium({ 'suggest-ghost': { _push: persistedPush, _ops: 'null' } });
  const { root, captured, settings } = await bootProcess(medium, { sessionId: SESSION, turns: 2, userTexts: ['第一句', '第二句'] });

  // 重启对账的核心断言：会话已进店且回合归属正确 → 建议被**恢复**而非清空。
  //
  // **第一次 pull 必须零写**：回读恢复之后，内存里的状态与盘上那份**是同一件事**
  // （同一份建议、同一份历史、热度同为 0），指纹一致 ⇒ pull 应答被判重跳过 ⇒ 盘上
  // `_push` 的**内容与 rev 都不变**。否则就是「内容一样、rev 不同」的多余写：既白写
  // 一次盘，又把 rev 顶上去一格（rev 是单调序号，client 侧的「旧载荷丢弃」看它）。
  const before = medium.read(NS)._push;
  await coldStartPull(settings, SESSION);
  const after = medium.read(NS)._push;
  assert.equal(after, before, '恢复之后第一次 pull 不该再写 _push（指纹判重应跳过）');
  const p = pushed(captured);
  assert.ok(p !== null, '重启后应推送对账状态');
  assert.ok(p.suggestion !== null, '重启后上一轮建议应被恢复（这是本次修复的核心）');
  assert.equal(p.suggestion.text, '跑一下测试');
  assert.equal(p.suggestion.turn, 2);
  assert.equal(p.suggestion.baseSeq, 3, 'baseSeq 也要对上：恢复的是盘上那一条，不是新生成的');
  assert.equal(p.suggestionSessionId, SESSION);
  assert.deepEqual(p.history, ['第一句', '第二句'], '历史同样立即可用，无需等新回合');
  await root[Symbol.asyncDispose]?.();
}, { knownIssue: 50 });

// —— 3. 建议陈旧（会话在停机期间又推进了回合）→ 应作废 ——
await section(3, '陈旧作废：会话在停机期间推进了回合 → 建议必须作废', async () => {
  const persistedPush = JSON.stringify({
    rev: 9,
    suggestion: { turn: 1, baseSeq: 1, text: '这条已经过期', truncated: false, acceptKey: 'Tab', frame: 1, final: true },
    suggestionSessionId: SESSION,
    hot: null,
    total: 0,
  });
  const medium = makeMedium({ 'suggest-ghost': { _push: persistedPush, _ops: 'null' } });
  const { root, captured, settings } = await bootProcess(medium, { sessionId: SESSION, turns: 3, userTexts: ['一', '二', '三'] });
  await coldStartPull(settings, SESSION);
  const p = pushed(captured);
  assert.equal(p.suggestion, null, '回合已推进到 3，回合 1 的建议必须作废');
  assert.equal(p.historySessionId, SESSION, '历史不受建议作废影响');
  await root[Symbol.asyncDispose]?.();
});

// —— 4. 会话尚未进店（持久化懒恢复未发生）→ 不猜测、不覆盖盘上值 ——
await section(4, '懒恢复：会话未进店时不得清盘', async () => {
  const persistedPush = JSON.stringify({
    rev: 9,
    suggestion: { turn: 2, baseSeq: 3, text: '等会话进店后再判', truncated: false, acceptKey: 'Tab', frame: 1, final: true },
    suggestionSessionId: 'session-not-restored-yet',
    hot: null,
    total: 0,
  });
  const medium = makeMedium({ 'suggest-ghost': { _push: persistedPush, _ops: 'null' } });
  // 注意：本进程只创建了 SESSION，**没有**创建 session-not-restored-yet。
  const { root, captured } = await bootProcess(medium, { sessionId: SESSION, turns: 1, userTexts: ['一'] });
  const raw = captured.scope?.get()?._push;
  // 盘上残留值不得被抹掉：仍应保留那条建议，等该会话进店后由 pull 对账。
  assert.ok(typeof raw === 'string' && raw !== 'null', '会话未进店时不得清盘');
  const kept = JSON.parse(raw);
  assert.equal(kept.suggestion?.text, '等会话进店后再判', '盘上建议原样保留，留给首次 pull 对账');
  await root[Symbol.asyncDispose]?.();
});

// —— 5. pull 应答：客户端请求某会话权威状态（含会话不存在时的兜底）——
await section(5, 'pull 应答：历史可得、消费后清空、未知会话不谎报', async () => {
  const medium = makeMedium();
  const { root, captured } = await bootProcess(medium, { sessionId: SESSION, turns: 2, userTexts: ['甲', '乙'] });
  const scope = captured.scope;

  // 模拟 client 写入 pull 请求
  await root.settings.update('suggest-ghost', {
    _ops: JSON.stringify({ rev: 1, ops: [{ op: 'pull', sessionId: SESSION }] }),
  });
  await sleep(30);
  const p = pushed(captured);
  assert.equal(p.historySessionId, SESSION, 'pull 应应答该会话历史');
  assert.deepEqual(p.history, ['甲', '乙']);
  assert.equal(JSON.parse(scope.get()._ops ?? 'null'), null, 'pull 消费后应清空 _ops');

  // 会话不存在：仍应答应（不能静默丢弃），只是省略 history
  await root.settings.update('suggest-ghost', {
    _ops: JSON.stringify({ rev: 2, ops: [{ op: 'pull', sessionId: 'no-such-session' }] }),
  });
  await sleep(30);
  const after = pushed(captured);
  assert.notEqual(after.historySessionId, 'no-such-session', '未知会话不应谎报历史归属');
  await root[Symbol.asyncDispose]?.();
});

// —— 6. 会话在插件启动**之后**才进店（宿主的持久化懒恢复）→ pull 时补判 ——
await section(6, '懒恢复补判：会话启动后才进店 → 第一次 pull 才判、应答仍带上它', async () => {
  const persistedPush = JSON.stringify({
    rev: 9,
    suggestion: { turn: 2, baseSeq: 3, text: '等会话进店再判', truncated: false, acceptKey: 'Tab', frame: 1, final: true },
    suggestionSessionId: SESSION,
    hot: null,
    total: 0,
  });
  const medium = makeMedium({ 'suggest-ghost': { _push: persistedPush, _ops: 'null' } });
  // `lateSession`：这个进程里会话是在插件 apply **之后**才创建的 ⇒ 启动期回读判不了
  // 新旧（「会话未进店」），按安全约束既不恢复、也不清盘、更不推残留。
  const { root, captured, settings, createSession } = await bootProcess(medium, {
    sessionId: SESSION,
    turns: 2,
    userTexts: ['第一句', '第二句'],
    lateSession: true,
  });
  const rawAfterBoot = captured.scope?.get()?._push;
  assert.ok(typeof rawAfterBoot === 'string' && rawAfterBoot !== 'null', '会话未进店时不得清盘');
  assert.equal(JSON.parse(rawAfterBoot).suggestion?.text, '等会话进店再判', '盘上建议原样保留，等它进店后由 pull 对账');
  assert.equal(pushWrites(medium).length, 0, '启动期不得写 _push（回读只读不写）');

  // 会话进店 → 第一次 pull 补判（此刻会话一定在店 ⇒ 判得了）→ 应答带上它。
  //
  // ⚠️ 断言落在**那一次写**上，而不是介质上的当前值：本小节刻意把会话建成「插件
  // apply 之后才进店」，于是插件会把这个会话的 turn/end 当成新回合走一遍生成路径
  // （真宿主上不会：重启后会话的事件是**重放**的，插件的
  // `lastSuggestedTurnInLog` 守卫会直接跳过，见 src/index.ts 的 handleTurnEnd），
  // 那次生成在本 harness 里必然失败（没有 LLM 路由），随后的一次写会把建议清掉。
  // 验的是「pull 应答那一刻**带上了**它」，所以看写留痕，不看最终值。
  createSession();
  await coldStartPull(settings, SESSION);
  // **观察点从「写留痕」挪到「客户端能读到的那份」**，这不是放宽，是拆格之后唯一正确的位置：
  // 盘上那格的内容就是被恢复出来的那条，而按格判重（#50「第一次 pull 零写」的性质）意味着
  // 内容与盘上一致时**不该**再写一遍。旧断言之所以能靠「有一次写带上它」成立，是因为那时
  // 指纹算的是整份载荷、热度格每次都变 ⇒ 必然有一次写。拿那个当判据，等于把「多写一次」
  // 这个缺陷当成正确性的证据。
  const pullWritesBefore = medium.writes.length;
  await coldStartPull(settings, SESSION);
  // **取证点是宿主自己那行 `persisted push restored source=pull`，不是介质终值。**
  //
  // 介质在这一小节读不到「应答里那条建议」，有两个各自独立的原因，两个都不是宿主的错：
  //  1. 按格判重（#50「第一次 pull 零写」）——恢复出来的内容与盘上那格**逐字相同**，
  //     所以正确行为就是不重写；旧断言拿「有一次写带上它」当证据，验的其实是整体指纹
  //     时代「热度一变就必然多写一次」这个副作用。
  //  2. 本夹具会把「apply 之后才进店」的会话重放成一次新回合，那次生成必然失败（没有
  //     LLM 路由），失败路径把建议清成 null —— 而它发生在 pull **之前/之中**，介质上
  //     留下的就是被清掉的那一份。真宿主上不会发生：重启后会话事件是重放的，
  //     `lastSuggestedTurnInLog` 守卫会直接跳过（见 `src/index.ts` 的 handleTurnEnd）。
  // 所以这里断言「宿主确实补判并把那条建议并进了应答」（restored 行 + turn 号），
  // 而「应答那一拍客户端能读到什么」由 `scripts/payload-split-smoke.mjs` 的场景 ⑤
  // 在受控夹具里量（那边不制造假回合）。两半合起来才是这条性质的完整覆盖。
  const restored = tracedFromApply().filter((l) => /persisted push restored source=pull/.test(l));
  assert.ok(
    restored.some((l) => /turn=2/.test(l)),
    `第一次 pull 必须补判该会话的残留建议并留一行 restored（缺它就无法区分「判过且带上」与「没判所以没动」）：${JSON.stringify(restored)}`,
  );
  const windowWrites = medium.writes.slice(pullWritesBefore);
  console.log('     ℹ 介质侧那一拍没重写建议格（按格判重的预期结果）；本次 pull 窗口的写：'
    + JSON.stringify(windowWrites.map((w) => Object.keys(w.patch))));
  await root[Symbol.asyncDispose]?.();
});

// —— 7. 「正文为空」与「载荷损坏」分归因（#73）——
//
// 沙箱实测（docs/real-session-harness.md §10）：手写一份 `text:""` 的终帧进 profile，
// 留痕打的是 `reason=corrupt-payload` —— 那是「盘上载荷坏了」的意思，读的人会去怀疑写盘
// 路径，而那笔写根本没坏：载荷结构完全合法，只是**没有正文**。这一小节钉三件事：
//  ① 空正文走自己的档（`empty-text`），且**行为不变**（不恢复、不动盘）；
//  ② 真损坏保持 `corrupt-payload`（不改名，旧留痕的检索习惯要保住）；
//  ③ `_residual` 那一格同形 ⇒ 判成**同一档**，不许出现两套口径。
await section(7, '空正文与真损坏分归因：留痕可区分、行为不变、两格同口径', async () => {
  /** 结构完全合法、只有正文为空的终帧（属于本会话，回合 2 = 最后已完成回合）。 */
  const emptyTextPush = JSON.stringify({
    rev: 9,
    suggestion: { version: 1, turn: 2, baseSeq: 3, text: '', truncated: false, acceptKey: 'Tab', frame: 1, final: true },
    suggestionSessionId: SESSION,
  });
  /** 真损坏：同一条建议，只把 text 换成数字。 */
  const damagedPush = JSON.stringify({
    rev: 9,
    suggestion: { version: 1, turn: 2, baseSeq: 3, text: 42, truncated: false, acceptKey: 'Tab', frame: 1, final: true },
    suggestionSessionId: SESSION,
  });

  /**
   * 按窗口取留痕。`globalThis.__ghostTrace` 是**跨小节累积**的全局缓冲，直接 filter 会把
   * 前六小节打的 `persisted push skipped` 一起捞进来（第一版就这么红过一次：红在夹具上
   * 而不是红在判据上，那种红没有价值）。所以每次 boot 前记起点，只断言这之后的行。
   */
  const traceWindow = () => {
    const from = tracedFromApply().length;
    return (marker) => {
      const hit = tracedFromApply().slice(from).filter((l) => l.includes(marker));
      assert.equal(hit.length, 1, `${marker} 在本次窗口内应当恰好一行，实得 ${JSON.stringify(hit)}`);
      return hit[0];
    };
  };

  // ① 空正文 ⇒ empty-text，且定位信息齐（会话 / turn / baseSeq / 字符数），**不打正文**。
  const win1 = traceWindow();
  const m1 = makeMedium({ 'suggest-ghost': { _push: emptyTextPush, _ops: 'null' } });
  const p1 = await bootProcess(m1, { sessionId: SESSION, turns: 2, userTexts: ['第一句', '第二句'] });
  const line1 = win1('persisted push skipped source=startup');
  console.log(`     空正文留痕：${line1.slice(line1.indexOf('persisted'))}`);
  assert.match(line1, /reason=empty-text/, `空正文必须走自己的档：${line1}`);
  assert.ok(!/corrupt-payload/.test(line1), '不许再借道「载荷损坏」');
  assert.match(line1, /turn=2/, '定位：turn');
  assert.match(line1, /baseSeq=3/, '定位：baseSeq');
  assert.match(line1, /chars=0/, '定位：字符数（空正文 = 0，旧写法这里全是 n/a）');
  assert.match(line1, new RegExp(`session=${SESSION}`), '定位：会话');
  assert.ok(!line1.includes('Tab'), '留痕不得把 acceptKey 之类的正文内容抄进去');
  // 行为不变：不恢复、**不动盘**（既不重写也不清空）。
  assert.equal(pushWrites(m1).length, 0, '空正文那一档不得动建议格');
  assert.equal(p1.captured.scope.get()._push, emptyTextPush, '盘上载荷原样留着（归因改了，处置没改）');
  await p1.root[Symbol.asyncDispose]?.();

  // ② 真损坏 ⇒ 仍然 corrupt-payload，且两行留痕**逐字不同**（这才是检索得开的依据）。
  const win2 = traceWindow();
  const m2 = makeMedium({ 'suggest-ghost': { _push: damagedPush, _ops: 'null' } });
  const p2 = await bootProcess(m2, { sessionId: SESSION, turns: 2, userTexts: ['第一句', '第二句'] });
  const line2 = win2('persisted push skipped source=startup');
  console.log(`     真损坏留痕：${line2.slice(line2.indexOf('persisted'))}`);
  assert.match(line2, /reason=corrupt-payload/, `真损坏必须保持旧词（改名会废掉既有检索习惯）：${line2}`);
  assert.notEqual(line1, line2, '两类留痕必须逐字不同');
  assert.equal(pushWrites(m2).length, 0, '真损坏同样不动盘（本次只改归因，不改处置）');
  await p2.root[Symbol.asyncDispose]?.();

  // ③ 同一个空正文载荷搬到 `_residual` 那一格 ⇒ 必须判成**同一档**（不许两套口径）。
  //    `_push` 置空，确保被判的就是残留格自己（两格都空时才是「无残留」）。
  const residualCell = JSON.stringify({
    suggestion: { version: 1, turn: 2, baseSeq: 3, text: '', truncated: false, acceptKey: 'Tab', frame: 1, final: true },
    suggestionSessionId: SESSION,
  });
  const win3 = traceWindow();
  const m3 = makeMedium({ 'suggest-ghost': { _push: 'null', _residual: residualCell, _ops: 'null' } });
  const p3 = await bootProcess(m3, { sessionId: SESSION, turns: 2, userTexts: ['第一句', '第二句'] });
  const line3 = win3('persisted push skipped source=startup');
  console.log(`     残留格同档留痕：${line3.slice(line3.indexOf('persisted'))}`);
  assert.match(line3, /reason=empty-text/, `_residual 里的空正文必须与建议格同一档：${line3}`);
  await p3.root[Symbol.asyncDispose]?.();
});

console.log('');
if (failures.length > 0) {
  const labeled = failures.map((f) => `小节 ${f.no}${f.knownIssue ? `（已知缺陷 #${f.knownIssue}）` : '（未预期）'}`);
  console.error(`❌ coldstart e2e：${failures.length} / 7 小节红 —— ${labeled.join('、')}`);
  console.error('   红的小节不要用放宽断言换绿：小节 2 验的是「重启恢复盘上残留建议」这条产品语义，'
    + '它在 c3b6a80（0.1.7 volatile 适配）里随 `parsePersistedPush(scope.get()._push)` 一起被删掉、之后没接回来（#50）。');
  console.error('   另注：小节 3 现在是绿的，但它绿的原因是「压根没恢复」而不是「恢复后被回合语义判废」——'
    + '#50 修好后这条必须仍然是绿的，那才是它真正的含义。');
  process.exit(1);
}
console.log('✅ coldstart e2e：重启对账 / 陈旧作废 / 懒恢复不覆盖 / pull 应答 全部通过');
// **成功路径必须显式退出**（失败路径早就有 `process.exit(1)`，所以这条以前从没被走到）：
// cordis 4.0.1 的 `Context` **没有** dispose/stop/`Symbol.asyncDispose` 面，本脚本里
// `root[Symbol.asyncDispose]?.()` 那个可选调用是**空操作** ⇒ 插件的排水定时器
// （`src/index.ts` 里 `setInterval(drainDeferred, 500)`，设计上是跨 apply 存活的，只在
// 真正的 ctx 卸载时才 clear）就一直 ref 着，事件循环排不空、进程退不出去。
// 证据：#50 修好前这条脚本只因「小节 2 红 → process.exit(1)」而退出，看起来一切正常。
process.exit(0);
