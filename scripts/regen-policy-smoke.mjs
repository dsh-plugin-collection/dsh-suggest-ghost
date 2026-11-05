/**
 * 「换一条」（regen）判据冒烟（Gitea #127）。
 *
 * 本模块是**零依赖纯函数**（不 import 任何东西，连 `crypto` 都不碰——摘要由
 * `src/text-match.ts` 提供、由调用方注入），所以本冒烟可以直接按 TS 源码直载，
 * 并把冷却/上限配成任意值来验边界，不需要起沙箱。
 *
 * ## 钉住的三类东西
 *
 * 1. **判据顺序是判据的一部分**：disabled → in-flight → quota → cooldown。
 *    配额排在冷却之前，否则「按到第 N+1 下」会在日志里显示成「再等 1.5s 就行」——
 *    那是假希望（`waitMs` 必须 `Infinity`）。
 * 2. **配额按会话×回合、冷却按会话**：换回合 `used` 归零但 `lastAt` 不归零。
 * 3. **留痕里没有正文**：喂一条真实正文进去，断言输出里不含它（隐私红线，
 *    口径同 `src/completion-gate.ts` 的 `draftChars=`）。
 */
import assert from 'node:assert/strict';
import {
  REGEN_AVOID_CAP,
  REGEN_COOLDOWN_MS,
  REGEN_MAX_PER_TURN,
  beginRegen,
  buildAvoidBlock,
  decideRegen,
  emptyRegenRecord,
  noteRejected,
  refundRegen,
  regenDuplicateTrace,
  regenRefusedTrace,
} from '../src/regen.ts';

let passed = 0;
const run = (name, fn) => {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.log(`  ✗ ${name}`);
    console.log(`      ${error?.message ?? error}`);
    process.exitCode = 1;
  }
};

const base = { enabled: true, now: 10_000, inflight: false, turn: 3 };

console.log('\n—— 判据顺序 ——');

run('空记录 ⇒ 放行', () => {
  assert.equal(decideRegen({ ...base, record: undefined }).reason, 'ok');
});

run('关掉 ⇒ disabled 且 waitMs 是 Infinity（等多久都没用）', () => {
  const d = decideRegen({ ...base, enabled: false, record: undefined });
  assert.equal(d.reason, 'disabled');
  assert.equal(d.waitMs, Number.POSITIVE_INFINITY);
});

run('在途 ⇒ in-flight，且不看 turn（换回合也不解除互斥）', () => {
  const d = decideRegen({ ...base, inflight: true, turn: 99, record: undefined });
  assert.equal(d.reason, 'in-flight');
});

run('配额与冷却同时不满足 ⇒ 报 quota（不能报成「再等 1.5s」）', () => {
  const record = { turn: 3, used: REGEN_MAX_PER_TURN, lastAt: 9_900, rejected: [] };
  const d = decideRegen({ ...base, record });
  assert.equal(d.reason, 'quota');
  assert.equal(d.waitMs, Number.POSITIVE_INFINITY);
});

run('配额未满但冷却未到 ⇒ 报 cooldown 且给出具体毫秒', () => {
  const record = { turn: 3, used: 1, lastAt: 9_900, rejected: [] };
  const d = decideRegen({ ...base, record });
  assert.equal(d.reason, 'cooldown');
  assert.equal(d.waitMs, REGEN_COOLDOWN_MS - 100);
});

console.log('\n—— 配额按会话×回合、冷却按会话 ——');

run('换回合 ⇒ used 归零（配额重新给满），但 lastAt 不归零', () => {
  const prev = { turn: 3, used: REGEN_MAX_PER_TURN, lastAt: 9_500, rejected: ['旧素材'] };
  const next = beginRegen(prev, 4, 20_000);
  assert.equal(next.turn, 4);
  assert.equal(next.used, 1);
  assert.deepEqual(next.rejected, []);
  assert.equal(next.lastAt, 20_000);
});

run('同回合连发 ⇒ used 累加到上限后拒绝', () => {
  let record;
  for (let i = 0; i < REGEN_MAX_PER_TURN; i += 1) record = beginRegen(record, 3, 10_000 + i * REGEN_COOLDOWN_MS);
  assert.equal(record.used, REGEN_MAX_PER_TURN);
  assert.equal(decideRegen({ ...base, now: 10_000 + 10 * REGEN_COOLDOWN_MS, record }).reason, 'quota');
});

run('跨回合的冷却仍然生效（lastAt 不清零）', () => {
  const record = { turn: 3, used: 1, lastAt: 9_990, rejected: [] };
  const d = decideRegen({ ...base, turn: 4, record });
  assert.equal(d.reason, 'cooldown');
});

console.log('\n—— 判同退款 ——');

run('退款只退额度、不退冷却起点', () => {
  const record = { turn: 3, used: 2, lastAt: 9_900, rejected: [] };
  const refunded = refundRegen(record);
  assert.equal(refunded.used, 1);
  assert.equal(refunded.lastAt, 9_900);
});

run('退款不会把额度退成负数', () => {
  assert.equal(refundRegen({ turn: 3, used: 0, lastAt: 0, rejected: [] }).used, 0);
});

run('退款后确实还能再发一次（判同不扣配额）', () => {
  const exhausted = { turn: 3, used: REGEN_MAX_PER_TURN, lastAt: 0, rejected: [] };
  assert.equal(decideRegen({ ...base, record: exhausted }).reason, 'quota');
  assert.equal(decideRegen({ ...base, record: refundRegen(exhausted) }).reason, 'ok');
});

console.log('\n—— 负向约束素材 ——');

const sameText = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();

run('去重（同一句两种大小写）且只留最后 N 条', () => {
  let record = emptyRegenRecord(3);
  record = noteRejected(record, 'Fix the build', sameText);
  record = noteRejected(record, 'fix the BUILD', sameText);
  assert.equal(record.rejected.length, 1);
  for (let i = 0; i < REGEN_AVOID_CAP + 3; i += 1) record = noteRejected(record, `第 ${i} 条`, sameText);
  assert.equal(record.rejected.length, REGEN_AVOID_CAP);
  assert.ok(record.rejected.at(-1).startsWith(`第 ${REGEN_AVOID_CAP + 2} 条`), '最新那条必须留下');
});

run('空清单 ⇒ 空串（调用方据此不拼接，整次调用的 system 与今天逐字相同）', () => {
  assert.equal(buildAvoidBlock([], sameText), '');
});

run('有清单 ⇒ 非空且列出每条', () => {
  const block = buildAvoidBlock(['甲', '乙'], sameText);
  assert.ok(block.includes('甲') && block.includes('乙'));
});

console.log('\n—— 留痕（隐私 + 分级） ——');

run('拒绝留痕里没有正文（喂真实正文，断言输出不含它）', () => {
  const secret = 'SECRET_DRAFT_不该进日志';
  const line = regenRefusedTrace({
    sessionId: 's',
    turn: 3,
    reason: 'quota',
    waitMs: Number.POSITIVE_INFINITY,
    record: { turn: 3, used: 2, lastAt: 0, rejected: [secret] },
  });
  assert.ok(!line.includes(secret));
  assert.match(line, /regen-refused/);
  assert.match(line, /used=2\/\d+/);
});

run('判同留痕同样不含正文，且带摘要长度而不是摘要值以外的内容', () => {
  const secret = 'SECRET_SHOWN_正文';
  const line = regenDuplicateTrace({ sessionId: 's', turn: 3, shownChars: secret.length, attempts: 1 });
  assert.ok(!line.includes(secret));
  assert.match(line, /regen-duplicate/);
});

console.log(`\n${process.exitCode === 1 ? '❌' : '✅'} regen-policy: ${passed} 组断言${process.exitCode === 1 ? '有失败' : '全部通过'}`);
