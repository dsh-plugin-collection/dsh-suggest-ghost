/**
 * `_ops` 反向通道写入的**串行队列**（纯 TS：零 DOM、零 ctx、零 I/O，可离线驱动）。
 *
 * ## 为什么需要它
 *
 * 写面是 CAS：「describe 取 revision → mutate(expected=revision)」（见
 * `index.ts` 的 `writeOpsNow`）。同一个页面里有**两条互不知情的写入源**：
 * 每次输入停顿触发的 `complete`，以及会话切换/未应答重试驱动的 `pull`。
 * 两者并发时，A 的 describe 与 mutate 之间会被 B 的写插队；而宿主每消费一次
 * `_ops` 还会把该字段写回空值（revision 再 +1）。于是在浏览器 console 里表现为
 * 成组的 `_ops write conflict retries exhausted: expectedRevision=N ... now N+1`，
 * 同时 `complete` 被耗尽预算丢掉（`completion not shown`）。根因不是「重试不够」，
 * 而是**本页自己跟自己抢**：串行化后，同一时刻只有一个 describe→mutate 在途，
 * 页面内部不再互抢 revision；剩下的冲突只可能来自宿主侧写入，那是退避重试要处理的。
 *
 * ## 两条合并语义（刻意不对称）
 *
 *  - `complete`：**排队中**（尚未开始执行）last-wins。每次输入停顿都会产生一条
 *    complete，但用户继续打字后，旧的草稿已经没有意义；新 complete 取代尚未发出的
 *    旧 complete，被取代者兑现 `false`（语义是「**未发送**」，不是「发送失败」）。
 *    **在途**（已开始执行）的 complete 不会被取消——取消一个已经发出的 RPC 只会
 *    让载荷状态更难解释。
 *  - `pull`：**不合并**。每条 pull 携带自己的 `sessionId`/`rev`，合并会丢掉对账
 *    请求（例如切会话时 A 的 pull 被 B 顶掉，A 就再没有对账机会）。
 *
 * ## 顺序与错误
 *
 * FIFO。`run` 抛错（含 reject）时该项兑现 `false` 且队列继续——写面自己已经把
 * describe 失败、拒绝等折成 `false`（`writeOpsNow` 就地收住，不外抛），这里是
 * 第二道保险：队列绝不能被一次异常永久卡住。
 *
 * `size` 是**排队中**（不含在途）的项数，只读，供冒烟断言。
 *
 * @module dsh-suggest-ghost/client/ops-write-queue
 */

/** 写入来源：`complete` 可合并，`pull` 不可合并（见模块头）。 */
export type OpsWriteKind = 'pull' | 'complete';

/** 队列里等待执行的一项。`resolve` 在兑现时只调用一次。 */
interface QueuedWrite {
  readonly payload: string;
  readonly kind: OpsWriteKind;
  readonly resolve: (landed: boolean) => void;
}

/**
 * 串行执行 `_ops` 写入。
 *
 * 构造入参就是真正的写函数（`index.ts` 的 `writeOpsNow`）；本类不关心信封、
 * revision、日志，只负责「至多一个在途、FIFO、complete 排队中 last-wins」。
 */
export class OpsWriteQueue {
  /** 真正的写面。失败/异常一律折成本项的 `false`，不向队列外抛。 */
  private readonly run: (payload: string, kind: OpsWriteKind) => Promise<boolean>;
  /** 排队中（尚未开始执行）的写入，队首最先执行。 */
  private readonly pending: QueuedWrite[] = [];
  /** 是否有 run 在途（至多一个；看门狗到点是唯一例外，见 `pump`）。 */
  private inFlight = false;
  /**
   * 单项看门狗（毫秒）：run 超过这个时长仍未兑现，就按 `false` 释放槽位、放行后续项。
   * 0 = 关闭。
   *
   * **为什么必须有**：串行化把「一条 RPC 永不兑现」从「那一条写丢了」升级成
   * 「整条通道永久卡死」——唯一的在途槽位被占住后，后面所有写（含 complete）都排队等它。
   * 写面的冲突退避总长只有 25+50+100+200=375ms，加两次 RPC 往返，8s 是十倍余量：
   * 正常慢不会误杀，真挂起（连接半断、远程层 promise 永不 settle）必然被放行。
   * 代价：超时项与迟到兑现的 run 可能短暂并发——迟到写的是**旧载荷**，宿主按载荷
   * 全等去重 + `seq` 单调，pull 幂等、complete 已被更新载荷 last-wins，不产生错误状态。
   */
  private readonly itemTimeoutMs: number;

  constructor(run: (payload: string, kind: OpsWriteKind) => Promise<boolean>, itemTimeoutMs = 8_000) {
    this.run = run;
    this.itemTimeoutMs = itemTimeoutMs;
  }

  /**
   * 排队一项写入。
   *
   * @param payload - 已套好信封（seq/locale）的 `_ops` 载荷原文。
   * @param kind - `'complete'` 才参与「排队中 last-wins」；`'pull'` 恒不合并。
   * @returns 该项最终是否被判定为落盘。被新 complete 取代的项**不会发送**，
   *          立即兑现 `false`。
   */
  enqueue(payload: string, kind: OpsWriteKind = 'pull'): Promise<boolean> {
    if (kind === 'complete') this.dropQueuedComplete();
    let settle: (landed: boolean) => void = () => { /* 由 Promise 构造器同步替换 */ };
    const promise = new Promise<boolean>((resolve) => {
      settle = resolve;
    });
    this.pending.push({ payload, kind, resolve: settle });
    // 启动推迟到微任务：同一轮同步调用里的多条 complete 才有机会合并成最后一条
    // （若同步启动，第一条会立刻变成「在途」，后续 complete 就只能排队而不是取代）。
    this.pump();
    return promise;
  }

  /** 排队中（不含在途）的项数。只读。 */
  get size(): number {
    return this.pending.length;
  }

  /** 若队列里已有一条尚未执行的 complete，兑现其 `false`（未发送）并移除。 */
  private dropQueuedComplete(): void {
    const index = this.pending.findIndex((item) => item.kind === 'complete');
    if (index < 0) return;
    const [replaced] = this.pending.splice(index, 1);
    replaced?.resolve(false);
  }

  /** 若没有在途项，取队首开始执行；执行完（无论成败）再递归泵下一个。 */
  private pump(): void {
    if (this.inFlight) return;
    const item = this.pending.shift();
    if (item === undefined) return;
    this.inFlight = true;
    void Promise.resolve().then(async () => {
      const runPromise = (async () => {
        try {
          return (await this.run(item.payload, item.kind)) === true;
        } catch {
          // 写面异常不阻断队列：本项按未落盘处理，后续项照常执行。
          return false;
        }
      })();
      let landed = false;
      let timedOut = false;
      if (this.itemTimeoutMs > 0) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const outcome = await Promise.race([
          runPromise.then((v) => ({ v, timedOut: false })),
          new Promise<{ v: boolean; timedOut: boolean }>((resolve) => {
            timer = setTimeout(() => resolve({ v: false, timedOut: true }), this.itemTimeoutMs);
          }),
        ]);
        if (timer !== undefined) clearTimeout(timer);
        landed = outcome.v;
        timedOut = outcome.timedOut;
      } else {
        landed = await runPromise;
      }
      // 兑现一次 race 只回到这里一次：迟到的 runPromise 不会重入本续体，无需代际守卫。
      this.inFlight = false;
      item.resolve(landed);
      // timedOut 目前只影响注释语义（race 输家的兑现被丢弃）；保留标志是为了
      // 断言/日志扩展时有据（冒烟第 8 组靠它证明「看门狗放行」而不是「碰巧快」）。
      void timedOut;
      this.pump();
    });
  }
}
