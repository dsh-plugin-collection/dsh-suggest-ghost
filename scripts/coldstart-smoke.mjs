// 冷启动语义 smoke：建议回读的结构校验 + 语义校验（回合归属）+ 历史环的
// 按需物化/增量追加。纯函数断言，不需要 host 服务。
// 用法：node --experimental-strip-types scripts/coldstart-smoke.mjs
import assert from 'node:assert/strict';
import {
  appendToRing,
  decidePersistedPush,
  lastCompletedTurnInLog,
  nextTrackedSuggestion,
  parsePersistedPush,
  RING_CAPACITY,
  seedRingFromLog,
  suggestionFieldsFor,
  suggestionIsCurrent,
  userTextOfEvent,
} from '../src/coldstart.ts';

/** 造一条 user/message 事件（只带该层用到的字段）。 */
function userMessage(seq, text, sourceKind = 'user') {
  return {
    type: 'user/message',
    seq,
    time: 0,
    data: { content: [{ type: 'text', text }], source: { kind: sourceKind } },
  };
}

/** 造一条 turn/end 事件。 */
function turnEnd(seq, turn, kind = 'completed') {
  return { type: 'turn/end', seq, time: 0, data: { turn, reason: { kind } } };
}

/** 造一个最小 session 视图（只实现 sessionEvents 用到的读取面）。 */
function sessionOf(events) {
  return { snapshotEvents: () => events, id: 'session-x' };
}

const suggestion = (turn, text = '跑一下测试') => ({
  version: 1,
  turn,
  baseSeq: 3,
  text,
  truncated: false,
  acceptKey: 'Tab',
});

// —— 1. userTextOfEvent：只收 source.kind === 'user' 的文本块 ——
{
  assert.equal(userTextOfEvent(userMessage(1, '  部署服务  ')), '部署服务', '应 trim');
  assert.equal(userTextOfEvent(userMessage(2, '注入', 'system')), null, '非 user 来源应跳过');
  assert.equal(userTextOfEvent(userMessage(3, '   ')), null, '空白应跳过');
  assert.equal(userTextOfEvent(userMessage(4, '<system-reminder>x</system-reminder>')), null, '系统提醒包装应跳过');
  assert.equal(userTextOfEvent(turnEnd(5, 1)), null, '非 user/message 事件应跳过');
  assert.equal(userTextOfEvent(userMessage(6, 'x'.repeat(2001))), null, '超长文本应跳过');
}

// —— 2. seedRingFromLog：时间序 + 相邻重复只计一次 ——
{
  const events = [
    userMessage(1, '第一句'),
    userMessage(2, '第一句'), // 相邻重复：跳过
    turnEnd(3, 1),
    userMessage(4, '第二句'),
    userMessage(5, '第一句'), // 非相邻重复：保留
    userMessage(6, '  '), // 空白：跳过
  ];
  assert.deepEqual(seedRingFromLog(sessionOf(events)), ['第一句', '第二句', '第一句']);
}

// —— 3. lastCompletedTurnInLog：只认 completed ——
{
  assert.equal(lastCompletedTurnInLog(sessionOf([])), 0, '无回合 = 0');
  assert.equal(lastCompletedTurnInLog(sessionOf([
    turnEnd(1, 1),
    turnEnd(2, 2, 'cancelled'),
    turnEnd(3, 3),
  ])), 3, '取最大的 completed 回合');
  assert.equal(lastCompletedTurnInLog(sessionOf([
    turnEnd(1, 5),
    turnEnd(2, 4, 'cancelled'),
  ])), 5, '被取消的更晚回合不参与');
}

// —— 4. suggestionIsCurrent：语义判据（这是重启后「建议还在不在」的唯一依据）——
{
  const log = sessionOf([turnEnd(1, 1), turnEnd(2, 2)]);
  assert.equal(suggestionIsCurrent(suggestion(2), log), true, '回合仍是最后已完成回合 → 有效');
  assert.equal(suggestionIsCurrent(suggestion(1), log), false, '会话已推进到回合 2 → 回合 1 的建议陈旧');
  assert.equal(suggestionIsCurrent(null, log), false, '无建议');
  assert.equal(suggestionIsCurrent(suggestion(2), undefined), false, '会话不存在 → 作废');
}

// —— 5. parsePersistedPush：结构校验（盘上内容不可信）——
{
  const good = JSON.stringify({ rev: 7, suggestion: suggestion(2), suggestionSessionId: 'session-a' });
  // 帧字段（#39）：这里的重建是逐字段白名单，**必须带上 frame/final**。
  // 期望值写成显式的 frame:1 / final:true 而不是 `...suggestion(2)`，因为这条断言
  // 的存在意义就是钉住「盘上没有帧语义时补什么」：补 1/true（本期一次生成只出一帧），
  // 而 0 是留给客户端识别「旧载荷」的哨兵值，宿主不主动伪造 0。
  assert.deepEqual(parsePersistedPush(good), {
    suggestion: { ...suggestion(2), frame: 1, final: true },
    sessionId: 'session-a',
    emptyText: null,
  });
  assert.equal(parsePersistedPush(good).suggestion.version, 1, '回读时补齐 version');
  // 盘上已有帧语义：原样带回，不能被重置成 1/true（否则「第 2 帧」在重启后变成「第 1 帧」，
  // 客户端的单调丢弃会把随后真正的第 2 帧误判成陈旧）。
  const carried = JSON.stringify({
    rev: 8,
    suggestion: { ...suggestion(2), frame: 2, final: false },
    suggestionSessionId: 'session-a',
  });
  assert.equal(parsePersistedPush(carried).suggestion.frame, 2, '盘上的 frame 原样带回');
  assert.equal(parsePersistedPush(carried).suggestion.final, false, 'final:false 不许被翻案成 true');

  assert.deepEqual(parsePersistedPush(undefined), { suggestion: null, sessionId: null, emptyText: null });
  assert.deepEqual(parsePersistedPush(''), { suggestion: null, sessionId: null, emptyText: null });
  assert.deepEqual(parsePersistedPush('null'), { suggestion: null, sessionId: null, emptyText: null }, 'EMPTY_PUSH');
  assert.deepEqual(parsePersistedPush('{ 坏 JSON'), { suggestion: null, sessionId: null, emptyText: null }, '解析失败');
  assert.deepEqual(parsePersistedPush('[]'), { suggestion: null, sessionId: null, emptyText: null }, '非对象');

  // 有建议无会话 id：保留 id 为 null，建议作废（无从判断归属）
  const noSession = JSON.stringify({ suggestion: suggestion(2) });
  assert.deepEqual(parsePersistedPush(noSession), { suggestion: null, sessionId: null, emptyText: null });

  // 字段级防御：逐项破坏都应降级为「无建议」而不是抛错
  for (const patch of [
    { turn: -1 }, { turn: 1.5 }, { turn: '2' },
    { baseSeq: -1 }, { text: '' }, { text: 42 },
    { truncated: 'no' }, { acceptKey: '' }, { acceptKey: null },
  ]) {
    const raw = JSON.stringify({
      suggestion: { ...suggestion(2), ...patch },
      suggestionSessionId: 'session-a',
    });
    const got = parsePersistedPush(raw);
    assert.equal(got.suggestion, null, `畸形字段应作废：${JSON.stringify(patch)}`);
    assert.equal(got.sessionId, 'session-a', '会话 id 仍应保留（供上层区分「无建议」与「会话未知」）');
    // 分类也必须在这一处就分开（#73）：只有 `{ text: '' }` 是「正文为空」，其余全是真损坏。
    // 期望从 patch 自己推，不手写清单——加一个新字段时这条断言会自动要求表态。
    const expectEmpty = Object.keys(patch).length === 1 && patch.text === '';
    assert.deepEqual(
      got.emptyText,
      expectEmpty ? { turn: 2, baseSeq: 3 } : null,
      `空正文档与真损坏档分错了：patch=${JSON.stringify(patch)} 实得 ${JSON.stringify(got.emptyText)}`,
    );
  }
}

// —— 6. appendToRing：增量维护（相邻去重 + 容量截断）——
{
  const ring = ['a'];
  assert.equal(appendToRing(ring, 'a'), false, '相邻重复不入环');
  assert.deepEqual(ring, ['a']);
  assert.equal(appendToRing(ring, 'b'), true);
  assert.deepEqual(ring, ['a', 'b']);

  const big = [];
  for (let i = 0; i < RING_CAPACITY + 5; i += 1) appendToRing(big, `词-${i}`);
  assert.equal(big.length, RING_CAPACITY, '容量硬上限');
  assert.equal(big[big.length - 1], `词-${RING_CAPACITY + 4}`, '保留最新');
  assert.equal(big[0], '词-5', '从头部截断最旧');
}

// —— 7. 冷启动组合语义：重启后「历史立刻可用」且「建议按回合归属决定去留」——
{
  // 进程 A：会话跑到回合 2，建议为回合 2 生成并落盘（模拟 settings.yaml 的 _push）
  const events = [userMessage(1, '部署服务'), turnEnd(2, 1), userMessage(3, '查日志'), turnEnd(4, 2)];
  const persisted = JSON.stringify({ suggestion: suggestion(2), suggestionSessionId: 's' });

  // 进程 B（重启）：会话已进店 → 历史按需物化即可用，建议语义校验通过 → 保留
  const live = sessionOf(events);
  const restored = parsePersistedPush(persisted);
  assert.deepEqual(seedRingFromLog(live), ['部署服务', '查日志'], '历史无需任何播种时机');
  assert.equal(suggestionIsCurrent(restored.suggestion, live), true, '重启后建议仍在有效期');

  // 若磁盘上的建议属于更早的回合（会话在停机前又推进过）→ 判为陈旧
  const stale = parsePersistedPush(JSON.stringify({ suggestion: suggestion(1), suggestionSessionId: 's' }));
  assert.equal(suggestionIsCurrent(stale.suggestion, live), false, '旧回合建议应作废');
}

// —— 8. nextTrackedSuggestion：产出即取代；作废只作废自己的 ——
{
  const none = { suggestion: null, sessionId: null };
  // 产出：直接取代（跨会话也取代——它才是「最新」那条）
  const a = nextTrackedSuggestion(none, 's-a', suggestion(1, 'A 的建议'));
  assert.deepEqual(a, { suggestion: suggestion(1, 'A 的建议'), sessionId: 's-a' });
  const b = nextTrackedSuggestion(a, 's-b', suggestion(2, 'B 的建议'));
  assert.equal(b.sessionId, 's-b', 'B 的新建议取代 A');
  // 作废别人的建议：不影响被追踪者（这是「另一会话生成失败」的场景）
  assert.deepEqual(nextTrackedSuggestion(b, 's-a', null), b, '作废 A 不应抹掉 B 的追踪');
  // 作废自己的建议：清空
  assert.deepEqual(nextTrackedSuggestion(b, 's-b', null), none, '作废自己的建议应清空追踪');
  // 无追踪时的作废：无变化
  assert.deepEqual(nextTrackedSuggestion(none, 's-a', null), none);
}

// —— 9. suggestionFieldsFor：pull 别的会话不能弄丢仍在有效期的建议 ——
{
  const trackedA = { suggestion: suggestion(1, 'A 的建议'), sessionId: 's-a' };
  // pull A：本会话校验通过 → 用本会话的
  assert.deepEqual(
    suggestionFieldsFor(trackedA, 's-a', trackedA.suggestion),
    { suggestion: trackedA.suggestion, sessionId: 's-a' },
  );
  // pull B（B 无建议）：保留 A 的建议 + A 的归属，client 守卫会隐藏它
  assert.deepEqual(
    suggestionFieldsFor(trackedA, 's-b', null),
    { suggestion: trackedA.suggestion, sessionId: 's-a' },
    'pull 无建议的会话不得抹掉别的会话的建议',
  );
  // pull A 但校验判定陈旧：A 自己的作废，且不误带别的会话
  assert.deepEqual(
    suggestionFieldsFor(trackedA, 's-a', null),
    { suggestion: null, sessionId: null },
    '本会话建议陈旧应作废',
  );
  // 无特定会话（仅刷新热度）：仍带上被追踪的建议，归属不变
  assert.deepEqual(
    suggestionFieldsFor(trackedA, null, null),
    { suggestion: trackedA.suggestion, sessionId: 's-a' },
  );
  // 完全没有建议：干净的空字段
  assert.deepEqual(
    suggestionFieldsFor({ suggestion: null, sessionId: null }, 's-a', null),
    { suggestion: null, sessionId: null },
  );
}

// —— 10. 端到端语义链：重启 → 对账 → pull 应答 ——
{
  // 停机前：会话跑到回合 2，建议为回合 2 生成，落盘在 settings 的 _push
  const events = [userMessage(1, '第一句'), turnEnd(2, 1), userMessage(3, '第二句'), turnEnd(4, 2)];
  const live = sessionOf(events);
  const persisted = parsePersistedPush(
    JSON.stringify({ suggestion: suggestion(2), suggestionSessionId: 's' }),
  );

  // 启动对账：会话已进店、语义有效 → 恢复追踪（不产生任何 LLM 调用）
  let tracked = { suggestion: null, sessionId: null };
  if (suggestionIsCurrent(persisted.suggestion, live)) {
    tracked = nextTrackedSuggestion(tracked, persisted.sessionId, persisted.suggestion);
  }
  assert.equal(tracked.sessionId, 's', '重启后建议被恢复而非清空');

  // 历史同样无需等待：按需物化即可
  assert.deepEqual(seedRingFromLog(live), ['第一句', '第二句']);

  // 于是「打开页面」这一拍就能给出完整的 pull 应答
  const fields = suggestionFieldsFor(tracked, 's', tracked.suggestion);
  // 期望值带上 frame/final：对账恢复出来的是**同一个对象**，帧语义一路透传到应答，
  // 中间任何一环把它摘掉都会在这里红（#39 的重启即失效场景）。
  assert.deepEqual(fields, { suggestion: { ...suggestion(2), frame: 1, final: true }, sessionId: 's' });
}

// —— 11. decidePersistedPush：启动回读的三态判定（#50 的核心语义）——
//
// 这条语义是 `e853d1e` 加的、`c3b6a80`（0.1.7 volatile 适配）删掉后一直没接回来的：
// 「宿主重启后把盘上残留的建议恢复出来」。判定分两步：结构（parsePersistedPush）
// 与语义（会话在不在店 + 回合是否仍是最后一个已完成回合）。
{
  const events = [userMessage(1, '第一句'), turnEnd(2, 1), userMessage(3, '第二句'), turnEnd(4, 2)];
  const live = sessionOf(events);
  /** 语义判据的注入点：会话在店 + 回合语义。 */
  const ctx = {
    sessionExists: (id) => id === 's',
    isCurrent: (sug, id) => suggestionIsCurrent(sug, id === 's' ? live : undefined),
  };
  const persisted = JSON.stringify({
    rev: 9,
    suggestion: suggestion(2),
    suggestionSessionId: 's',
  });

  // ① 回读 → 判回合有效性 → **恢复**：盘上那条（回合 2 = 最后已完成回合）被恢复，
  //    且恢复出来的就是**盘上那一条**（turn/baseSeq/text 逐项对上，不是重新生成的）。
  const restored = decidePersistedPush(persisted, ctx);
  assert.equal(restored.action, 'restore');
  assert.equal(restored.reason, null);
  assert.equal(restored.sessionId, 's');
  assert.equal(restored.suggestion.turn, 2);
  assert.equal(restored.suggestion.baseSeq, 3);
  assert.equal(restored.suggestion.text, '跑一下测试');
  // 帧语义一起恢复（#39：重启即失效的老坑）
  assert.equal(restored.suggestion.frame, 1);
  assert.equal(restored.suggestion.final, true);

  // ② **负向：回合已过时则不恢复**（会话在停机期间又推进了回合）
  const stale = decidePersistedPush(
    JSON.stringify({ rev: 9, suggestion: suggestion(1), suggestionSessionId: 's' }),
    ctx,
  );
  assert.equal(stale.action, 'skip');
  assert.equal(stale.reason, 'stale-turn');
  assert.equal(stale.suggestion.turn, 1, '判废也要说清是哪一条（留痕带 turn/baseSeq）');

  // ③ **会话未进店**（宿主的持久化懒恢复未发生）→ 无从判新旧 ⇒ 不猜、不清盘，
  //    留给该会话第一次 pull 时再判（不许当成「陈旧」）。
  const notInStore = decidePersistedPush(persisted, {
    sessionExists: () => false,
    isCurrent: () => false,
  });
  assert.equal(notInStore.action, 'skip');
  assert.equal(notInStore.reason, 'session-unavailable');
  assert.equal(notInStore.suggestion.turn, 2, '判不了也要带着那条建议（等它进店后能直接接回）');

  // ④ 载荷损坏（结构不合法）→ 不恢复，且原因要说清是「载荷坏了」而不是「陈旧」。
  assert.equal(decidePersistedPush('{ 坏 JSON', ctx).reason, 'corrupt-payload');
  assert.equal(
    decidePersistedPush(JSON.stringify({ suggestion: { turn: 'x' }, suggestionSessionId: 's' }), ctx).reason,
    'corrupt-payload',
  );
  assert.equal(decidePersistedPush('null', ctx).reason, 'no-persisted-payload');
  assert.equal(decidePersistedPush(undefined, ctx).reason, 'no-persisted-payload');

  // ⑤ 有建议但**无会话 id** → 无法归属 ⇒ 「会话不匹配」（不是「载荷损坏」）。
  const noSession = decidePersistedPush(JSON.stringify({ suggestion: suggestion(2) }), ctx);
  assert.equal(noSession.action, 'skip');
  assert.equal(noSession.reason, 'session-mismatch');

  // ⑥ 恢复之后，**第一次 pull 的应答仍带上它**（这正是 #50 缺的那半截：应答里原来
  //    是 `suggestion: null`，把盘上那条盖掉了）。
  let tracked = { suggestion: null, sessionId: null };
  if (restored.action === 'restore') {
    tracked = nextTrackedSuggestion(tracked, restored.sessionId, restored.suggestion);
  }
  const fields = suggestionFieldsFor(tracked, 's', tracked.suggestion);
  assert.equal(fields.suggestion?.text, '跑一下测试', 'pull 应答必须带上恢复出来的那条');
  assert.equal(fields.sessionId, 's');
  // 反面：判废的那条**不得**出现在应答里（否则就是「陈旧建议复活」）。
  assert.equal(
    suggestionFieldsFor({ suggestion: null, sessionId: null }, 's', null).suggestion,
    null,
    '没有恢复时应答里不该凭空长出建议',
  );
}

// —— 12. 正文为空与载荷损坏**分归因**（#73）——
//
// `corrupt-payload` 以前同时描述两种性质不同的情况：
//  ① 真的损坏：JSON 解析不了 / 字段类型不对 ⇒ 盘上载荷确实不可信；
//  ② 结构合法、只是**正文为空**（`text === ''`）⇒ 载荷没坏，是「没有内容」。
// 读到 `corrupt-payload` 的人只会想到 ① ⇒ 去怀疑写盘路径。这不是假想：沙箱里手写一份
// `text:""` 的终帧，留痕就是 `persisted push skipped source=startup reason=corrupt-payload`
// （见 docs/real-session-harness.md §10），排障方向当场被带偏。
//
// 分档而不是改名：①保持 `corrupt-payload`（这个词已在沙箱日志与文档里被检索过，改名会把
// 旧的检索习惯一起废掉），②给它自己的 reason `empty-text`。
{
  const events = [userMessage(1, '第一句'), turnEnd(2, 1)];
  const live = sessionOf(events);
  const ctx = {
    sessionExists: (id) => id === 's',
    isCurrent: (sug, id) => suggestionIsCurrent(sug, id === 's' ? live : undefined),
  };

  /** ② 结构全都合法、只有正文为空（宿主自己永远不会发这种载荷，但手改/旧版本会）。 */
  const emptyText = JSON.stringify({
    rev: 9,
    suggestion: { ...suggestion(2), text: '' },
    suggestionSessionId: 's',
  });
  const emptyVerdict = decidePersistedPush(emptyText, ctx);
  assert.equal(emptyVerdict.action, 'skip', '正文为空仍然不恢复（行为不许变，只改归因）');
  assert.equal(
    emptyVerdict.reason,
    'empty-text',
    `正文为空必须有自己的 reason，不许再借道「载荷损坏」：实得 ${JSON.stringify(emptyVerdict.reason)}`,
  );

  /** ① 字段类型不对 = 真损坏 ⇒ **保持** corrupt-payload（同一条建议只把 text 换成数字）。 */
  const damaged = JSON.stringify({
    rev: 9,
    suggestion: { ...suggestion(2), text: 42 },
    suggestionSessionId: 's',
  });
  assert.equal(decidePersistedPush(damaged, ctx).reason, 'corrupt-payload', '真损坏不许被顺手改成新词');
  // 逐字不同是这条修复的全部价值：留痕检索能一眼分开两类。
  assert.notEqual(emptyVerdict.reason, decidePersistedPush(damaged, ctx).reason);

  // 留痕要带够定位信息（会话、turn、baseSeq、字符数），且**不打正文**。
  assert.equal(emptyVerdict.sessionId, 's', '空正文也要说清是哪会话的');
  assert.deepEqual(
    emptyVerdict.location,
    { turn: 2, baseSeq: 3, chars: 0 },
    `正文为空必须带 turn/baseSeq/字符数（旧写法 suggestion=null ⇒ 三个全 n/a，等于没定位）：${JSON.stringify(emptyVerdict.location)}`,
  );

  /** `_residual` 与 `_push` **同一口径**（要求 2）：残留格字节形状与 `_push` 的建议部分
   * 同形，喂进同一条判定链就必须判成同一档——「两套口径」是第二种漂法。 */
  const residualCell = JSON.stringify({
    suggestion: { ...suggestion(2), text: '' },
    suggestionSessionId: 'session-b',
  });
  const residualVerdict = decidePersistedPush(residualCell, { sessionExists: () => true, isCurrent: () => true });
  assert.equal(residualVerdict.reason, emptyVerdict.reason, '残留格与建议格必须判成同一档');
  assert.equal(residualVerdict.sessionId, 'session-b');

  // 结构校验层也必须把这个事实**当数据报出来**，否则上层只能自己再抄一遍判据（两份真相）。
  const parsedEmpty = parsePersistedPush(emptyText);
  assert.equal(parsedEmpty.suggestion, null, '行为不变：空正文依然不构成建议');
  assert.deepEqual(
    parsedEmpty.emptyText,
    { turn: 2, baseSeq: 3 },
    `parsePersistedPush 必须把「只有正文为空」与「字段类型不对」区分开上报：${JSON.stringify(parsedEmpty.emptyText)}`,
  );
  assert.equal(parsePersistedPush(damaged).emptyText, null, 'text 类型不对是真损坏，不算空正文档');
}

console.log('✅ coldstart 冒烟测试通过（结构校验/语义校验/按需物化/增量维护/跨会话追踪/启动回读判定/空正文与损坏分归因）');