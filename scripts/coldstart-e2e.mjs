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

/** 插件的 settings 命名空间：0.1.7 起 = Loader 条目 id（内核把插件 Config 投影成表单）。 */
const NS = 'suggest-ghost';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
      writes.push({ ns, patch: structuredClone(patch) });
    },
  };
}

/** 介质上历次写里带过的 `_push` 载荷（按写入顺序）。 */
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

/** 读 host 推给 client 的 `_push`（client 侧读的是同一份 settings 值）。 */
function pushed(captured) {
  const raw = captured.scope?.get()?._push;
  return raw === undefined ? null : JSON.parse(raw);
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
  await sleep(60);
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
  const written = pushWrites(medium);
  assert.ok(
    written.some((p) => p.suggestion?.text === '等会话进店再判' && p.suggestion.turn === 2),
    '会话进店后第一次 pull 的应答必须带上那条建议',
  );
  await root[Symbol.asyncDispose]?.();
});

console.log('');
if (failures.length > 0) {
  const labeled = failures.map((f) => `小节 ${f.no}${f.knownIssue ? `（已知缺陷 #${f.knownIssue}）` : '（未预期）'}`);
  console.error(`❌ coldstart e2e：${failures.length} / 6 小节红 —— ${labeled.join('、')}`);
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
