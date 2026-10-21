// 热度持久化端到端 smoke：真实 storage 栈（dsh-storage hub + json backend +
// storage-domain form）在临时目录跑通 记账 → flush 落盘 → 关闭 → 重新装配恢复。
// 注意：测的是编译产物（src 内部用 .js 推导导入，strip-types 无法直接加载），
// 先构建再跑（#49）：
//   ./node_modules/.bin/tsc -p tsconfig.json && node build.mjs
//
// ## 在 git worktree 里跑（本文件与另两条 e2e 同此口径）
//  - **别用 `pnpm build` / `pnpm test:e2e`**：worktree 里的 `node_modules` 是指向主仓的
//    **软链**，pnpm 的依赖状态检查（`runDepsStatusCheck`）会因此判依赖不一致直接失败，
//    跟代码没关系。`package.json` 的 `test:e2e` 已改成上面那两条本地命令，`&&` 串联，
//    所以在 worktree 与主仓里都能直接 `bash -c "$(node -p \"require('./package.json').scripts['test:e2e']\")"`。
//  - 类型检查同理：`./node_modules/.bin/tsc -p tsconfig.json --noEmit`，不要 `pnpm typecheck`。
//
// 用法：node scripts/hotness-persist-e2e.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { Storage } from '@deepseek-ai/dsh-storage';
import * as storageJson from '@deepseek-ai/dsh-storage-json';
import * as storageDomain from '@deepseek-ai/dsh-storage-domain';
import { setupHotnessPersistence } from '../lib/hotness-store.js';

const root = new Context();
if (root.logger === undefined) root.logger = console;
const mediumRoot = mkdtempSync(join(tmpdir(), 'dsh-hotness-e2e-'));

// —— 最小宿主组合：storage hub → json backend → domain form（与真实 host 同构）——
new Storage(root); // Service 构造时自动以 "storage" 注册到 context
storageJson.apply(root, { root: mediumRoot });
await storageDomain.apply(root, { backend: 'json' });
const mediumFile = join(mediumRoot, 'suggest_ghost_hotness.json');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// —— 第一轮「进程」：恢复（空表）→ 记账 → flush 落盘 ——
{
  const { hotness, persistence } = setupHotnessPersistence(root);
  for (let i = 0; !persistence.ready && i < 100; i += 1) await sleep(20);
  assert.equal(persistence.ready, true, 'storageDomain 未在预期时间内就绪');
  hotness.recordUserText('部署服务', 1, 's1');
  hotness.recordUserText('部署服务', 2, 's2'); // 同会话相邻重复不计
  hotness.recordUserText('部署服务', 3, 's2'); // 跨会话再出现 → count 2
  hotness.recordUserText('查日志', 3, 's1');
  await persistence.flush();
  const medium = JSON.parse(readFileSync(mediumFile, 'utf8'));
  assert.equal(medium.unit.name, 'suggest_ghost_hotness');
  assert.equal(medium.unit.version, 1);
  assert.deepEqual(medium.tables.entries, {
    部署服务: { text: '部署服务', count: 2 },
    查日志: { text: '查日志', count: 1 },
  });
  console.log('✅ e2e：第一轮落盘内容正确', JSON.stringify(medium.tables.entries));
  await persistence.close();
}

// —— 第二轮「进程」：重新装配 → 频次恢复 → 恢复条目再出现合并 → 再落盘 ——
{
  const { hotness, persistence } = setupHotnessPersistence(root);
  for (let i = 0; !persistence.ready && i < 100; i += 1) await sleep(20);
  assert.equal(persistence.ready, true);
  assert.deepEqual(hotness.snapshot(10).map(({ text, count }) => ({ text, count })), [
    { text: '部署服务', count: 2 },
    { text: '查日志', count: 1 },
  ]);
  // 恢复条目在新会话里再次出现 → live + 持久频次合并，lastSeq 推进到 live 轨道。
  hotness.recordUserText('部署服务', 5, 's3');
  assert.deepEqual(hotness.snapshot(10), [
    { text: '部署服务', count: 3 },
    { text: '查日志', count: 1 },
  ]);
  await persistence.flush();
  const medium = JSON.parse(readFileSync(mediumFile, 'utf8'));
  assert.equal(medium.tables.entries['部署服务'].count, 3);
  console.log('✅ e2e：重启后频次恢复 + 合并 + 再落盘全部正确');
  await persistence.close();
}

// —— 第三轮「进程」：管理面板 ops（固定/删除/新增/清空）经 applyOps → 持久层往返 ——
{
  const { hotness, persistence } = setupHotnessPersistence(root);
  for (let i = 0; !persistence.ready && i < 100; i += 1) await sleep(20);
  // 固定「查日志」+ 删除「部署服务」+ 新增手工候选（默认固定）。
  assert.equal(persistence.applyOps([
    { op: 'pin', text: '查日志', pinned: true },
    { op: 'delete', text: '部署服务' },
    { op: 'add', text: '手工候选', pinned: true },
  ]), 3);
  // 两条都固定（组内次序属实现细节，不判定）；pinned 恒置顶于未固定者。
  assert.deepEqual(
    hotness.snapshot(10).map((e) => ({ t: e.text, c: e.count, p: e.pinned === true })).sort((a, b) => a.t.localeCompare(b.t)),
    [
      { t: '手工候选', c: 1, p: true },
      { t: '查日志', c: 1, p: true },
    ],
  );
  await persistence.flush();
  let medium = JSON.parse(readFileSync(mediumFile, 'utf8'));
  assert.equal(medium.tables.entries['查日志'].pinned, true, '固定标记应落盘');
  assert.equal(medium.tables.entries['手工候选'].pinned, true);
  assert.equal(medium.tables.entries['部署服务'], undefined, '删除应同步到持久层');
  await persistence.close();

  // 重启后恢复：固定条目回到置顶位（组内次序属实现细节，只判集合与标记）。
  const second = setupHotnessPersistence(root);
  for (let i = 0; !second.persistence.ready && i < 100; i += 1) await sleep(20);
  assert.deepEqual(second.hotness.snapshot(10).map((e) => e.text).sort(), ['手工候选', '查日志']);
  assert.deepEqual(second.hotness.snapshot(10).map((e) => e.pinned === true), [true, true]);
  // 非法 ops 载荷解析：畸形 JSON / 未知 op / 空载荷都**不产生任何 op、不抛**。
  //
  // 断言口径更新（#49）：`parseHotnessOps` 的返回值在 v0.5.0（fcc3a05）从「ops 数组」
  // 换成了信封 `{ ops, rejected? }`——丢弃原因当**数据**返回、由调用方落留痕
  // （理由见 src/hotness-store.ts:243-254 那段：纯函数要同时被 host 事件回调与 smoke
  // 驱动，走两条完全不同的留痕通道）。这是本仓 API 形状漂移，**不是**宿主接口迁移，
  // 也不是持久化逻辑错：要验的语义（坏载荷不产生 op）一字未动。
  // 所以这里改的是「从信封里取哪一格」，并且顺手**加严**：旧断言只能证明「没放行」，
  // 现在连「为什么没放行、有没有留痕」一起判（`rejected` 的分级口径与
  // scripts/ops-schema-coverage-smoke.mjs 第 5/6/7 段一致，两处同一份契约）。
  const { parseHotnessOps } = await import('../lib/hotness-store.js');
  const malformed = parseHotnessOps('not-json');
  assert.deepEqual(malformed.ops, [], '畸形 JSON 不该放行任何 op');
  assert.equal(malformed.rejected?.kind, 'json', `畸形 JSON 必须留痕且标成 json 失败：${JSON.stringify(malformed.rejected)}`);
  assert.ok(malformed.rejected.bytes > 0, 'rejected.bytes 要带上载荷长度');
  // 空载荷是**正常态**（host 每次消费后都写回空值）：不产生 op，也不算丢弃、不留痕。
  const empty = parseHotnessOps('null');
  assert.deepEqual(empty.ops, [], '空载荷不该放行任何 op');
  assert.equal(empty.rejected, undefined, '空载荷被当成丢弃并留痕 = 每次消费后都白 warn 一行');
  // 未知 op：整批拒绝 + 必须留痕，且与 json 失败分级区分得开。
  const unknownOp = parseHotnessOps(JSON.stringify({ rev: 1, ops: [{ op: 'deploy' }] }));
  assert.deepEqual(unknownOp.ops, [], '未知 op 不该被放行');
  assert.equal(unknownOp.rejected?.kind, 'schema', `未知 op 该标成 schema 失败：${JSON.stringify(unknownOp.rejected)}`);
  assert.equal(second.persistence.applyOps([{ op: 'pin', text: '不存在的条目', pinned: true }]), 0);
  // 清空全部 → 持久层同步删除。
  assert.equal(second.persistence.applyOps([{ op: 'clear' }]), 2);
  await second.persistence.flush();
  medium = JSON.parse(readFileSync(mediumFile, 'utf8'));
  assert.deepEqual(medium.tables.entries, {});
  await second.persistence.close();
  console.log('✅ e2e：管理 ops（固定/删除/新增/清空）+ 重启恢复 + 载荷防御全部正确');
}

console.log('✅ hotness persist e2e：真实 storage 栈端到端通过，介质在', mediumFile);
