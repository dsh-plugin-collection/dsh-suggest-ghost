/**
 * 幽灵 overlay 的几何计算（纯函数，不碰 DOM）。
 *
 * ## 为什么要独立成模块
 *
 * 这段算术原先内联在 `GhostOverlay.align()` 里，而它决定的**不只是位置**：
 * overlay 的 left/width 直接决定灰字怎么折行。折行是否与「采纳之后正文的样子」
 * 一致，是用户能一眼看出来的观感（也是「长建议折成右侧窄栏」这个缺陷的根）。
 * 内联在 DOM 方法里时，这段算术只能靠真浏览器肉眼验；抽出来之后，它可以在
 * Node 里逐条钉住，浏览器侧只需验「按这个盒子画出来，行首是否落在正文行首上」。
 *
 * 输入全部是**已量好的数字**（调用方负责取 offsetParent 坐标系原点、视口坐标下的
 * 行尾矩形、内容宽），因此本模块对 DOM 结构零假设。
 */

/** 草稿行尾矩形（视口坐标系）里本模块要用的三个量。 */
export interface CaretBox {
  /** 末字符的右边缘（= 幽灵第一个字应该起笔的位置）。 */
  readonly right: number;
  /** 末字符的**字形墨迹**上缘，不是行框上缘。 */
  readonly top: number;
  /** 末字符的字形高度，用来算行内垂直偏移。 */
  readonly height: number;
}

/** 一次对齐所需的全部输入。 */
export interface OverlayGeometryInput {
  /** 编辑器内容原点（offsetParent 坐标系）左边界，已含 border + padding。 */
  readonly originLeft: number;
  /** 同上，上边界。 */
  readonly originTop: number;
  /** 内容宽（clientWidth 减左右 padding）。 */
  readonly contentWidth: number;
  /** 同一个内容原点在**视口**坐标系里的 x：把 caret 的视口坐标换算到 offsetParent 坐标系。 */
  readonly originViewportX: number;
  /** 同上，y。 */
  readonly originViewportY: number;
  /** 草稿行尾；`llm` 形态（草稿为空、整段从原点起）为 null。 */
  readonly caret: CaretBox | null;
  /** 编辑器的行高（`normal` 时为 NaN）。 */
  readonly lineHeight: number;
}

/** overlay 的盒子：left/top/width 直接写内联样式，textIndent 写 `text-indent`。 */
export interface OverlayGeometry {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly textIndent: number;
}

/** overlay 顶相对「行尾字形上缘」的上移量：让 overlay 内的文本与正文字形同高。 */
const inlineOffset = (lineHeight: number, caretHeight: number): number =>
  Number.isFinite(lineHeight) && lineHeight > 0 && caretHeight > 0
    ? Math.max(0, (lineHeight - caretHeight) / 2)
    : 0;

/**
 * 算出 overlay 的盒子。
 *
 * ## 口径：让灰字的折行 = 「采纳之后正文的样子」
 *
 * 幽灵只是预览，用户拿它判断「按 Tab 之后会变成什么」。所以排版必须与编辑器
 * 真的插入这段文字后**逐行同形**，而不只是「都在输入框里」：
 *
 *  - **第一行**从草稿行尾起笔（`text-indent` = 行尾相对内容原点的偏移）；
 *  - **折行后的续行**从内容原点的左边缘起排，可用整行宽度。
 *
 * 第二行从哪起排这一点，正是旧实现的缺陷所在：旧口径把 overlay 直接摆在行尾、
 * 宽度只取「行尾到行末」那一段，于是 overlay 自己折出来的每一行都从行尾那一列
 * 起排 —— 长建议在输入框右侧折成一条窄栏（用户截图），而且比真正的结果多占
 * 一行的垂直空间。用 `text-indent` 而不是「隐形 prefix 撑位」：后者要求 overlay
 * 的排版与编辑器逐像素一致，实测会瞬时不成立（prefix 撑出 0 宽），正是历史上
 * 那条「灰字压在草稿上」的来源；`text-indent` 只依赖**量出来的**行尾 x，
 * 与 overlay 自己的排版无关。
 *
 * 垂直方向不变：overlay 的顶对齐「草稿最后一行的行框顶」（扣掉字形与行框的
 * 行内偏移，让灰字与正文字形同高）。
 */
export function overlayGeometry(input: OverlayGeometryInput): OverlayGeometry {
  const { originLeft, originTop, contentWidth, originViewportX, originViewportY, caret, lineHeight } = input;
  if (caret === null) {
    return { left: originLeft, top: originTop, width: contentWidth, textIndent: 0 };
  }
  // 行尾在内容坐标系里的偏移；夹在 [0, contentWidth] 内，防测量抖动把缩进算成负数
  // 或超过内容宽。夹到边界后「第一行一个字都放不下」的情形由 overlay 的零宽断点
  // 兜住（`::before{content:"\200b"}`，见 src/client/index.ts 里那条样式规则）。
  const offset = Math.min(Math.max(caret.right - originViewportX, 0), contentWidth);
  return {
    left: originLeft,
    top: originTop + (caret.top - originViewportY) - inlineOffset(lineHeight, caret.height),
    width: contentWidth,
    textIndent: offset,
  };
}
