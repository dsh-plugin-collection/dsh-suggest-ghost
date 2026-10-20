// dsh-suggest-ghost 语言证据窗口冒烟测试（语言证据窗口与输入预算解耦）。
//
// 钉住的两件事：
//   ① buildTranscript 必须额外给出**未经输入预算裁剪**的 evidencePairs，且语言判定用它；
//   ② 判定回退到助手文本时，拉丁证据不得推翻 UI 先验（由 suggestion-language-smoke 的
//      用例 11/12 覆盖；这里第 5 条断言从端到端再兜一次）。
//
// 从构建产物 lib/ 导入：generate.ts 里有 `using` 声明，--experimental-strip-types 解析不了
// （与 scripts/inline-smoke.mjs 同一取舍）。
import assert from 'node:assert/strict';
import { buildTranscript } from '../lib/generate.js';
import { suggestionLanguage } from '../lib/transcript.js';

/** 摘自真实会话 session-47dc0add… 回合 22 的助手回复（中文 Markdown 调试报告，含大量标识符）。 */
const REPORT = "根因不在 CI，也不在广播脚本——**3081 只绑在 `127.0.0.1`**，而 runner 是 k3s pod。\n\n## 证据链\n\n| 证据 | 含义 |\n|---|---|\n| `ss -ltnp`：`LISTEN 127.0.0.1:3081` | 监听只在回环接口 |\n| job 日志：`Failed to connect to 10.42.0.1 port 3081 … refused` | **refused 而不是 timeout** 说明 SYN 已经到达主机、只是没有监听 → pod→主机这条路是通的 |\n| profile [:98](/home/wujue/.dsh/profiles/web/cordis.patch.yml#L98)：`host: 127.0.0.1` | 配置漂了；本插件文档里写的拓扑是 **0.0.0.0:3081** |\n| action 内置候选：`172.26.211.49:3081`、`10.42.0.1:3081` | 第二个正是本机在 k3s 网桥上的地址，绑定对了就能通 |\n\n另一个坑：`172.26.211.49` 是 WSL 的 NAT IP，**每次重启都会变**，而它排在候选第一位——所以每次广播都要先白等一次 refuse 才试第二个。\n\n## 修法（一行 + 重启）\n\nprofile `~/.dsh/profiles/web/cordis.patch.yml`：\n\n```diff\n     - id: webhook-webserver\n       config:\n-        host: 127.0.0.1\n+        host: 0.0.0.0\n         port: 3081\n```\n\n重启后从本机自检（应当返回 405，表示 POST-only 路由已挂上）：\n\n```bash\ncurl -s -o /dev/null -w '%{http_code}\\n' http://10.42.0.1:3081/github   # 期望 405\n```\n\n**这样不设 `BROADCAST_URL` 也能通**（内置候选第二个就命中了）。\n\n## 两件附带说明\n\n1. **`BROADCAST_URL` 我设不了**：我对 `whq/apbot` 只有 `push`、没有 `admin`，仓库变量返回 `403 user should be the owner`。要设得找 owner。收益是省掉对内置候选（含会变的 WSL IP）的依赖；可选，不是必需。\n2. **绑定范围**：`0.0.0.0` 会把 3081 暴露到这台机器所有接口（k3s 网桥 + WSL NAT）；想更窄可以只写 `10.42.0.1`，但 WSL/网络重启后要是网桥换了地址就得再改一次。我建议 `0.0.0.0`（webhook 本身有 HMAC 验签）。\n\n要我改这一行吗？我会先存一份带时间戳的 `.bak` 再改，重启你来做；重启完我立刻验 `/github` 的 405 和 `/review-status` 的 200。";

const userMsg = (seq, text) => ({
  type: 'user/message', seq, time: 0,
  data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] },
});
const asstMsg = (seq, text) => ({
  type: 'assistant/message', seq, time: 0,
  data: { turn: 1, message: { role: 'assistant', content: [{ type: 'text', text }] } },
});
const turnStart = (seq, turn) => ({ type: 'turn/start', seq, time: 0, data: { turn } });
const turnEnd = (seq, turn) => ({ type: 'turn/end', seq, time: 0, data: { turn, reason: { kind: 'completed' } } });
const sessionOf = (events) => ({ snapshotEvents: () => events, id: 'session-x' });
const userCount = (pairs) => pairs.filter(p => p.role === 'user').length;
const framedBytes = (pairs) => Buffer.byteLength(
  pairs.map(p => (p.role === 'user' ? `[User Message]\n${p.text}` : `[Assistant Response]\n${p.text}`)).join('\n\n'),
  'utf8',
);

const URL_MSG = 'http://192.168.4.77:3000/whq/apbot/actions/runs/8714/jobs/8730';

// —— 1. 现场复现前提：字节预算会把短用户消息整批挤掉 ——
{
  const events = [
    turnStart(1, 1), userMsg(2, '我合并了'), asstMsg(3, REPORT), turnEnd(4, 1),
    turnStart(5, 2), userMsg(6, '我重启DSH了'), asstMsg(7, REPORT), turnEnd(8, 2),
    turnStart(9, 3), userMsg(10, URL_MSG), asstMsg(11, REPORT), turnEnd(12, 3),
  ];
  const t = buildTranscript(sessionOf(events), 3, 12000, 4096, true, 1500);
  assert.ok(t !== undefined, '应有转录');
  // 送模型的那份被裁到只剩 1 条 user（那条纯 URL）：这正是 bug 的触发前提。
  assert.equal(userCount(t.pairs), 1, `裁剪后应只剩 1 条 user 对（前提），实际: ${userCount(t.pairs)}`);
  // 证据对不受输入预算约束：3 条用户消息全在。
  assert.equal(userCount(t.evidencePairs), 3, `evidencePairs 应保留 3 条用户消息，实际: ${userCount(t.evidencePairs)}`);
  assert.ok(framedBytes(t.evidencePairs) > 4096, 'evidencePairs 应超过 maxInputBytes（证明未被裁剪）');
  // —— 2. 端到端：修法① ——
  assert.equal(suggestionLanguage(t.evidencePairs, 'zh', 100), '简体中文',
    '未裁剪证据 + zh 界面应判简体中文');
  // —— 3. 端到端：修法②兜住旧路径（即使有人再把证据换回 pairs，也不会吐英文）——
  assert.equal(suggestionLanguage(t.pairs, 'zh', 100), '简体中文',
    '裁剪后证据走助手回退，也不应推翻 zh 先验');
}

// —— 4. 合成摘要对不得混进语言证据 ——
{
  const events = [];
  let seq = 0;
  for (let turn = 1; turn <= 5; turn++) {
    events.push(turnStart(++seq, turn));
    events.push(userMsg(++seq, `第 ${turn} 条用户消息，讲中文`));
    events.push(asstMsg(++seq, turn % 2 === 0 ? REPORT : '好的，收到，已处理完。'));
    events.push(turnEnd(++seq, turn));
  }
  const t = buildTranscript(sessionOf(events), 3, 12000, 4096, true, 1500);
  const hasSummary = (pairs) => pairs.some(p => p.text.startsWith('[Earlier context summary]'));
  assert.ok(hasSummary(t.pairs), '本例应生成摘要对（否则该断言无意义）');
  assert.ok(!hasSummary(t.evidencePairs), 'evidencePairs 不应包含合成的摘要对');
  assert.equal(suggestionLanguage(t.evidencePairs, 'zh', 100), '简体中文', '含摘要前缀也不应改变判定');
}

// —— 5. 证据文本上界：巨型粘贴日志不放大正则成本，且判定只看开头 ——
{
  const huge = [{ role: 'user', text: '部署一下服务' + 'x'.repeat(200_000) }];
  const capped = [{ role: 'user', text: '部署一下服务' + 'x'.repeat(4000) }];
  assert.equal(
    suggestionLanguage(huge, 'zh', 100),
    suggestionLanguage(capped, 'zh', 100),
    '超过 EVIDENCE_TEXT_CAP_CHARS 的部分不应参与统计',
  );
}

console.log('✅ language-evidence 5 组断言全部通过');
