window.__ModuleLoader__.load({
	id: "dsh-suggest-ghost",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name2 in all)
    __defProp(target, name2, { get: all[name2], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client/index.ts
var index_exports = {};
__export(index_exports, {
  apply: () => apply,
  inject: () => inject,
  name: () => name,
  pushCellStats: () => pushCellStats
});
module.exports = __toCommonJS(index_exports);

// src/text-match.ts
var NORMALIZE_CACHE_MAX = 4096;
var normalizeCache = /* @__PURE__ */ new Map();
function clearNormalizeCache() {
  normalizeCache.clear();
}
function normalizeCore(text) {
  return text.replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 65248)).replace(/\u3000/g, " ").toLowerCase().replace(/\s+/g, " ").trim();
}
function normalizeForMatch(text) {
  const cached = normalizeCache.get(text);
  if (cached !== void 0) return cached;
  const result = normalizeCore(text);
  if (normalizeCache.size >= NORMALIZE_CACHE_MAX) normalizeCache.clear();
  normalizeCache.set(text, result);
  return result;
}
function hashText32(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

// src/client/history.ts
function commonPrefixLength(a, b) {
  const len = Math.min(a.length, b.length);
  let i = 0;
  while (i < len && a[i] === b[i]) i++;
  return i;
}
var TIME_TOKEN_RE = /^[+\d].*|^[a-z]+\d+.*|^\d{1,2}:\d{2}.*|^\d+月.*|^\d{1,2}日.*|^[上下]周.*|^今天.*|^明天.*|^后天.*|^今.*|^明.*|^后.*/i;
function stripCommandPrefix(draft) {
  const head = /^\/([A-Za-z][\w-]*)((?:\s+[\s\S]*)?)$/.exec(draft);
  if (head === null) return draft;
  const rest = (head[2] ?? "").replace(/^\s+/, "");
  if (rest === "") return "";
  const firstToken = /^\S+/.exec(rest);
  if (firstToken === null) return rest;
  if (TIME_TOKEN_RE.test(firstToken[0])) {
    return rest.slice(firstToken[0].length).replace(/^\s+/, "");
  }
  return rest;
}
var HISTORY_WEIGHTS = {
  /** 新近度（0–1，最新≈1）；跨会话候选固定 0。 */
  recency: 1,
  /** 会话内出现次数 / 候选内最大次数（0–1）。 */
  localFreq: 0.45,
  /** 全局热度频次 / **候选内**最大热度频次（0–1；无热度信号时为 0）。 */
  hotFreq: 0.3,
  /** 后缀信息量：min(后缀长, 60) / 60，偏好有内容的补全而非 1 字符碎片。 */
  suffixLen: 0.1
};
var SUFFIX_LEN_CAP = 60;
function historySuggestion(history, draft, opts = { minChars: 1, maxEntries: 0 }) {
  const normDraft = normalizeForMatch(draft);
  if (normDraft === "" || normDraft.length < opts.minChars) return void 0;
  const entries = opts.maxEntries > 0 ? history.slice(-opts.maxEntries) : history;
  const ignored = opts.ignored;
  const skipIgnored = ignored !== void 0 && ignored.size > 0;
  const byNorm = /* @__PURE__ */ new Map();
  entries.forEach((raw, idx) => {
    const norm = normalizeForMatch(raw);
    if (norm === "") return;
    if (skipIgnored && ignored.has(norm)) return;
    const prev = byNorm.get(norm);
    if (prev === void 0) {
      byNorm.set(norm, { text: raw, norm, bestIdx: idx, localCount: 1 });
    } else {
      prev.localCount += 1;
      if (idx > prev.bestIdx) {
        prev.bestIdx = idx;
        prev.text = raw;
      }
    }
  });
  if (opts.extraCandidates !== void 0) {
    for (const item of opts.extraCandidates) {
      const norm = normalizeForMatch(item.text);
      if (norm === "" || byNorm.has(norm)) continue;
      if (skipIgnored && ignored.has(norm)) continue;
      byNorm.set(norm, { text: item.text, norm, bestIdx: -1, localCount: 0 });
    }
  }
  const candidates = [];
  for (const c of byNorm.values()) {
    if (c.norm === normDraft) continue;
    if (!c.norm.startsWith(normDraft)) continue;
    candidates.push(c);
  }
  if (candidates.length === 0) return void 0;
  let maxLocal = 0;
  for (const c of candidates) if (c.localCount > maxLocal) maxLocal = c.localCount;
  let maxHot = 0;
  if (opts.hotCounts !== void 0) {
    for (const c of candidates) {
      const hotCount = opts.hotCounts.get(c.norm) ?? 0;
      if (hotCount > maxHot) maxHot = hotCount;
    }
  }
  let best;
  let bestScore = 0;
  let bestRecency = -1;
  for (const c of candidates) {
    const recency = c.bestIdx < 0 ? 0 : (c.bestIdx + 1) / Math.max(entries.length, 1);
    const localFreq = maxLocal > 0 ? c.localCount / maxLocal : 0;
    const hotCount = opts.hotCounts?.get(c.norm) ?? 0;
    const hotFreq = maxHot > 0 ? hotCount / maxHot : 0;
    const suffixLen = Math.min(Math.max(c.norm.length - normDraft.length, 0), SUFFIX_LEN_CAP) / SUFFIX_LEN_CAP;
    const score = HISTORY_WEIGHTS.recency * recency + HISTORY_WEIGHTS.localFreq * localFreq + HISTORY_WEIGHTS.hotFreq * hotFreq + HISTORY_WEIGHTS.suffixLen * suffixLen;
    if (best === void 0 || score > bestScore || score === bestScore && recency > bestRecency) {
      best = c;
      bestScore = score;
      bestRecency = recency;
    }
  }
  return best?.text;
}

// src/client/accept-guard.ts
function readDraftSnapshot(raw) {
  if (raw === null || typeof raw !== "object") return { draft: "", rev: null };
  const state = raw;
  const draftValue = state.draft;
  const revValue = state.draftRev;
  return {
    draft: typeof draftValue === "string" ? draftValue : "",
    rev: typeof revValue === "number" && Number.isFinite(revValue) ? revValue : null
  };
}
function draftDriftReason(base, live) {
  if (base.draft !== live.draft) return "draft-changed";
  if (base.rev !== null && live.rev !== null && base.rev !== live.rev) return "rev-changed";
  return null;
}
function commitDraftIfPristine(base, live, write) {
  const reason = draftDriftReason(base, live);
  if (reason !== null) return { committed: false, reason };
  write();
  return { committed: true, reason: null };
}
function acceptTarget(content) {
  return content.kind === "llm" ? content.text : content.full;
}
function buildFullAccept(content, draftAtCompute) {
  if (content.kind === "llm") return content.text;
  if (content.kind === "inline") return content.full;
  const contentDraft = stripCommandPrefix(draftAtCompute);
  const head = contentDraft === "" ? draftAtCompute : draftAtCompute.slice(0, draftAtCompute.length - contentDraft.length);
  const tailJoiner = head.endsWith(" ") || head === "" ? "" : " ";
  return `${head}${tailJoiner}${content.full}`;
}
function wordMatchBase(content, draftAtCompute) {
  return content.kind === "history" ? stripCommandPrefix(draftAtCompute) : draftAtCompute;
}
function buildWordAccept(content, draftAtCompute, matchBase, chunk) {
  if (content.kind !== "history") return draftAtCompute + chunk;
  const head = matchBase === "" ? draftAtCompute : draftAtCompute.slice(0, draftAtCompute.length - matchBase.length);
  const tailJoiner = head.endsWith(" ") || head === "" ? "" : " ";
  return `${head}${tailJoiner}${matchBase}${chunk}`;
}
function wordAcceptSettled(content, accepted) {
  const full = acceptTarget(content);
  return accepted === full || content.kind === "history" && accepted.endsWith(full);
}
var LEGACY_FRAME_HINT = { frame: 0, final: true };
function normalizeFrameNo(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) return 0;
  return Math.floor(value);
}
function normalizeFinal(value) {
  return value !== false;
}
function readFrameHint(primary, secondary) {
  for (const source of [primary, secondary]) {
    if (source === null || typeof source !== "object") continue;
    const record2 = source;
    if (record2.frame === void 0 && record2.final === void 0) continue;
    return { frame: normalizeFrameNo(record2.frame), final: normalizeFinal(record2.final) };
  }
  return LEGACY_FRAME_HINT;
}
function frameBucketKey(sessionId, turn) {
  const session = typeof sessionId === "string" && sessionId !== "" ? sessionId : "no-session";
  const turnKey = typeof turn === "number" && Number.isFinite(turn) ? String(Math.floor(turn)) : "no-turn";
  return `${session}|${turnKey}`;
}
var emptyFrameLedger = () => ({ seen: {}, dropped: 0 });
function observeFrame(ledger, bucket, frame) {
  if (frame < 1) {
    return { accept: true, ledger, outcome: "legacy", seen: ledger.seen[bucket] ?? null };
  }
  const seenValue = ledger.seen[bucket];
  if (seenValue === void 0) {
    return { accept: true, ledger: record(ledger, bucket, frame), outcome: "first", seen: null };
  }
  if (frame < seenValue) {
    return {
      accept: false,
      ledger: { seen: ledger.seen, dropped: ledger.dropped + 1 },
      outcome: "older",
      seen: seenValue
    };
  }
  if (frame === seenValue) {
    return { accept: true, ledger, outcome: "same", seen: seenValue };
  }
  return { accept: true, ledger: record(ledger, bucket, frame), outcome: "newer", seen: seenValue };
}
function record(ledger, bucket, frame) {
  return { seen: { ...ledger.seen, [bucket]: frame }, dropped: ledger.dropped };
}
function gateAccept(hint) {
  if (hint === null || hint === void 0) return { allow: true };
  if (hint.final === false) return { allow: false, reason: "provisional-frame" };
  return { allow: true };
}
function frameHintFields(hint) {
  return `frame=${hint.frame} final=${String(hint.final)}`;
}
function resolvePayloadFrames(input) {
  const { pushed, prevCompletionFrame } = input;
  const completionPayload = pushed === null || pushed === void 0 ? void 0 : pushed.completion;
  const completionFrame = completionPayload === void 0 ? prevCompletionFrame : completionPayload === null ? LEGACY_FRAME_HINT : readFrameHint(completionPayload);
  const suggestionPayload = pushed === null || pushed === void 0 ? null : pushed.suggestion ?? null;
  if (suggestionPayload === null) {
    return {
      accept: true,
      ledger: input.ledger,
      outcome: "absent",
      bucket: null,
      seen: null,
      suggestionFrame: LEGACY_FRAME_HINT,
      completionFrame
    };
  }
  const suggestionFrame = readFrameHint(suggestionPayload, pushed);
  const bucket = frameBucketKey(
    typeof pushed?.suggestionSessionId === "string" ? pushed.suggestionSessionId : null,
    typeof suggestionPayload.turn === "number" ? suggestionPayload.turn : null
  );
  const step = observeFrame(input.ledger, bucket, suggestionFrame.frame);
  return {
    accept: step.accept,
    ledger: step.ledger,
    outcome: step.outcome,
    bucket,
    seen: step.seen,
    suggestionFrame,
    completionFrame
  };
}

// src/client/accept-key.ts
var DEFAULT_ACCEPT_KEY = "Tab";
var DEFAULT_WORD_ACCEPT_KEY = "Right";
var DEFAULT_REGEN_KEY = "Alt+G";
function bindingTableFor(input) {
  const table = {};
  table.accept = input.kind === "llm" ? input.acceptKey ?? DEFAULT_ACCEPT_KEY : input.localAcceptKey ?? DEFAULT_ACCEPT_KEY;
  if (input.kind !== "llm" && input.wordAccept !== false) {
    table.word = input.wordAcceptKey ?? DEFAULT_WORD_ACCEPT_KEY;
  }
  if (input.kind === "llm" && input.regenEnabled !== false) {
    table.regen = input.regenKey ?? DEFAULT_REGEN_KEY;
  }
  if (input.dismissKey !== void 0 && input.dismissKey !== "") table.dismiss = input.dismissKey;
  if (input.forgetKey !== void 0 && input.forgetKey !== "") table.forget = input.forgetKey;
  return table;
}

// src/client/accept-source.ts
function acceptSourceVerdict(input) {
  const paintedChars = input.paintedText === null ? 0 : input.paintedText.length;
  const acceptedChars = input.accepted.length;
  if (input.paintedText === null) return { allow: false, reason: "not-painted", paintedChars, acceptedChars };
  if (input.paintedText === "") return { allow: false, reason: "painted-mismatch", paintedChars, acceptedChars };
  if (!input.accepted.endsWith(input.paintedText)) {
    return { allow: false, reason: "painted-mismatch", paintedChars, acceptedChars };
  }
  return { allow: true, reason: null, paintedChars, acceptedChars };
}

// src/client/yield-key.ts
function shouldYieldKey(event) {
  return event.defaultPrevented === true;
}

// src/client/completion-align.ts
function commonPrefixLength2(a, b) {
  const len = Math.min(a.length, b.length);
  let i = 0;
  while (i < len && a[i] === b[i]) i += 1;
  return i;
}
function alignCompletion(cur, payloadDraft, completionText) {
  if (completionText === "") return { ok: false, reason: "empty-text" };
  if (!hasUserDraft(cur)) return { ok: false, reason: "empty-draft" };
  if (cur === payloadDraft) {
    return { ok: true, kind: "exact", suffix: completionText, full: cur + completionText };
  }
  if (!cur.startsWith(payloadDraft)) {
    return { ok: false, reason: payloadDraft.startsWith(cur) ? "payload-superseded" : "draft-mismatch" };
  }
  const typedSince = cur.slice(payloadDraft.length);
  const overlap = Math.min(completionText.length, commonPrefixLength2(typedSince, completionText));
  const suffix = completionText.slice(overlap);
  if (suffix === "") return { ok: false, reason: "empty-text" };
  return { ok: true, kind: "extended", suffix, full: cur + suffix };
}
function ownsDraftByAlignmentContract(draft, payloadDraft) {
  return draft === payloadDraft || draft.startsWith(payloadDraft);
}
function classifyInlineFrame(input) {
  if (!input.inlineEnabled) return { kind: "superseded", reason: "inline-disabled" };
  if (!hasUserDraft(input.draft)) return { kind: "superseded", reason: "empty-draft" };
  const payload = input.payload;
  if (payload === null || payload === void 0) return { kind: "superseded", reason: "no-payload" };
  if (!input.payloadBelongsToCurrentSession) return { kind: "superseded", reason: "other-session" };
  if (payload.text === "") return { kind: "superseded", reason: "no-text" };
  if (input.alignedOk) return { kind: "show" };
  if (input.alignedReason === "empty-text") {
    return ownsDraftByAlignmentContract(input.draft, payload.draft) ? { kind: "consumed" } : { kind: "superseded", reason: "draft-mismatch" };
  }
  if (input.alignedReason === "empty-draft") return { kind: "superseded", reason: "empty-draft-after-align" };
  if (input.alignedReason === "payload-superseded") return { kind: "superseded", reason: "payload-superseded" };
  return { kind: "superseded", reason: "draft-mismatch" };
}
function decideInlineForm(input) {
  const state = classifyInlineFrame(input);
  if (state.kind === "show") return { showInline: true, allowHistory: true, hold: null };
  if (state.kind === "consumed") return { showInline: false, allowHistory: false, hold: "inline-consumed" };
  return { showInline: false, allowHistory: true, hold: null };
}
function hasUserDraft(draft) {
  return draft.trim() !== "";
}
function decideLlmForm(input) {
  return hasUserDraft(input.draft) ? { allow: false, reason: "draft-not-blank" } : { allow: true, reason: "blank-draft" };
}
function decideCompletionReuse(input) {
  const verdict = decideInlineForm({
    inlineEnabled: input.inlineEnabled,
    draft: input.draft,
    payload: input.payload,
    payloadBelongsToCurrentSession: input.payloadBelongsToCurrentSession,
    alignedOk: input.aligned !== null && input.aligned.ok,
    alignedReason: input.aligned === null || input.aligned.ok ? null : input.aligned.reason
  });
  if (verdict.showInline) return { show: true, holdHistory: false, reason: "aligned" };
  if (verdict.hold !== null) return { show: false, holdHistory: true, reason: "consumed" };
  const reason = input.aligned === null ? "inactive" : input.aligned.ok ? "aligned" : input.aligned.reason;
  return { show: false, holdHistory: false, reason };
}

// src/client/ops-envelope.ts
function createSeqSource() {
  let last = 0;
  return {
    next() {
      last += 1;
      return last;
    }
  };
}
function buildOpsPayload(payload, locale, seq) {
  let parsed;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return payload;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return payload;
  const base = parsed;
  const enriched = { ...base, seq };
  if (typeof locale === "string" && locale.length > 0) enriched.locale = locale;
  return JSON.stringify(enriched);
}

// src/client/chunk.ts
var segmenter;
try {
  const ctor = Intl.Segmenter;
  segmenter = typeof ctor === "function" ? new ctor("zh", { granularity: "word" }) : void 0;
} catch {
  segmenter = void 0;
}
function charClassOf(ch) {
  if (/\s/.test(ch)) return "space";
  if (/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(ch)) return "cjk";
  if (/[\w]/.test(ch)) return "word";
  return "punct";
}
function nextAcceptChunkFallback(text) {
  if (text === "") return "";
  let i = 0;
  while (i < text.length && charClassOf(text[i]) === "space") i++;
  if (i < text.length) {
    const cls = charClassOf(text[i]);
    let run = 0;
    while (i < text.length && charClassOf(text[i]) === cls) {
      i++;
      run++;
      if (cls === "cjk" && run >= 2) break;
    }
    while (i < text.length && charClassOf(text[i]) === "space") i++;
  }
  return text.slice(0, Math.max(i, 1));
}
function nextAcceptChunk(text) {
  if (text === "") return "";
  if (segmenter === void 0) return nextAcceptChunkFallback(text);
  const parts = [...segmenter.segment(text)];
  let firstWord = 0;
  while (firstWord < parts.length && !parts[firstWord].isWordLike) firstWord++;
  if (firstWord >= parts.length) return text;
  let end = firstWord + 1;
  while (end < parts.length && !parts[end].isWordLike) end++;
  return parts.slice(0, end).map((p) => p.segment).join("");
}

// src/client/overlay-geometry.ts
var inlineOffset = (lineHeight, caretHeight) => Number.isFinite(lineHeight) && lineHeight > 0 && caretHeight > 0 ? Math.max(0, (lineHeight - caretHeight) / 2) : 0;
function overlayGeometry(input) {
  const { originLeft, originTop, contentWidth, originViewportX, originViewportY, caret, lineHeight } = input;
  if (caret === null) {
    return { left: originLeft, top: originTop, width: contentWidth, textIndent: 0 };
  }
  const offset = Math.min(Math.max(caret.right - originViewportX, 0), contentWidth);
  return {
    left: originLeft,
    top: originTop + (caret.top - originViewportY) - inlineOffset(lineHeight, caret.height),
    width: contentWidth,
    textIndent: offset
  };
}

// src/client/inline-arm-policy.ts
var initialInlineArmState = () => ({
  ticket: null,
  firedSessionId: null,
  firedDraft: null,
  suppressed: 0
});
var firedMatch = (state, obs) => state.firedDraft !== null && state.firedSessionId === obs.sessionId && state.firedDraft === obs.draft;
var changedDimension = (ticket, obs) => {
  if (ticket.draft !== obs.draft) return "draft-changed";
  if (ticket.sessionId !== obs.sessionId) return "session-changed";
  if (ticket.ghostKind !== obs.ghostKind) return "kind-changed";
  if (ticket.delayMs !== obs.delayMs || ticket.minChars !== obs.minChars) return "config-changed";
  return null;
};
var decide = (state, obs, action, reason, ticket, suppressed, clearFired = false) => ({
  state: {
    ticket,
    firedSessionId: clearFired ? null : state.firedSessionId,
    firedDraft: clearFired ? null : state.firedDraft,
    suppressed
  },
  decision: {
    action,
    reason,
    dueAt: ticket === null ? null : ticket.dueAt,
    delayMs: ticket === null ? obs.delayMs : ticket.delayMs,
    draft: ticket === null ? obs.draft : ticket.draft,
    sessionId: ticket === null ? obs.sessionId : ticket.sessionId
  }
});
var decideInlineArm = (state, obs) => {
  if (!obs.enabled) return decide(state, obs, "cancel", "disabled", null, state.suppressed);
  if (obs.sessionId === null) return decide(state, obs, "cancel", "no-session", null, state.suppressed);
  if (obs.composing) return decide(state, obs, "cancel", "composing", null, state.suppressed);
  if (obs.draft.trim().length < obs.minChars) {
    return decide(state, obs, "cancel", "below-min-chars", null, state.suppressed);
  }
  if (obs.ghostKind === "inline") {
    return decide(state, obs, "cancel", "completion-visible", null, state.suppressed);
  }
  const { ticket } = state;
  if (ticket !== null && changedDimension(ticket, obs) === null) {
    return decide(state, obs, "skip", "same-observation", ticket, state.suppressed + 1);
  }
  if (ticket === null && firedMatch(state, obs)) {
    return decide(state, obs, "skip", "already-fired", null, state.suppressed + 1);
  }
  const next = {
    sessionId: obs.sessionId,
    draft: obs.draft,
    ghostKind: obs.ghostKind,
    minChars: obs.minChars,
    delayMs: obs.delayMs,
    dueAt: obs.now + obs.delayMs
  };
  return decide(
    state,
    obs,
    ticket === null ? "arm" : "reset",
    ticket === null ? "first-arm" : changedDimension(ticket, obs) ?? "draft-changed",
    next,
    state.suppressed,
    // 一旦为新的 (会话, 草稿) 起表，上一份草稿的去重键即刻作废：否则「输入 A → 停顿
    // 发问 → 继续输入 B → 删回 A」这条再普通不过的路径会被永久锁死在 A 上。
    true
  );
};
var settleInlineTimer = (state, sent) => ({
  ticket: null,
  firedSessionId: sent === null ? state.firedSessionId : sent.sessionId,
  firedDraft: sent === null ? state.firedDraft : sent.draft,
  suppressed: state.suppressed
});
var configValuesEqual = (a, b) => {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (!configValuesEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  const ra = a;
  const rb = b;
  const ka = Object.keys(ra);
  const kb = Object.keys(rb);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(rb, k)) return false;
    if (!configValuesEqual(ra[k], rb[k])) return false;
  }
  return true;
};
var ANCHOR_REDRAW_TOLERANCE_PX = 1;
function isSameGenerationGrowth(prev, next) {
  if (prev === null) return false;
  if (prev.kind !== next.kind) return false;
  if (prev.anchorText !== next.anchorText) return false;
  if (next.suffixText.length < prev.suffixText.length) return false;
  return next.suffixText.startsWith(prev.suffixText);
}
var anchorMeasurable = (kind) => kind !== "llm";
function decideOverlayPaint(input) {
  const { prev, next, painted, anchorDirty } = input;
  if (!painted) return "rebuild";
  if (!isSameGenerationGrowth(prev, next)) return "rebuild";
  if (!anchorDirty) return "grow-only";
  return anchorMeasurable(next.kind) ? "grow-remeasure" : "rebuild";
}
function anchorMovedBeyond(prev, current, tolerancePx = ANCHOR_REDRAW_TOLERANCE_PX) {
  if (prev === null || current === null) return true;
  if (!Number.isFinite(prev.right) || !Number.isFinite(prev.top)) return true;
  if (!Number.isFinite(current.right) || !Number.isFinite(current.top)) return true;
  return Math.abs(current.right - prev.right) > tolerancePx || Math.abs(current.top - prev.top) > tolerancePx;
}
function shouldSkipDeferredRepaint(input) {
  return input.painted === true && input.growing === true;
}
var OPS_TRACE_PREFIX = "[dsh-suggest-ghost][ops-trace]";
function stepReasonGate(last, reason) {
  if (reason === null) return { last: null, print: false };
  if (reason === last) return { last, print: false };
  return { last: reason, print: true };
}
var TRACE_SLOT_COOLDOWN_MS = 5e3;
var initialSlotEmitGate = () => ({
  lastEmitAt: null,
  pendingReason: null,
  pendingFields: ""
});
function stepSlotEmit(gate, now, wantsPrint, reason, fields) {
  const cooling = gate.lastEmitAt !== null && now - gate.lastEmitAt < TRACE_SLOT_COOLDOWN_MS;
  if (cooling) {
    return wantsPrint ? { gate: { ...gate, pendingReason: reason, pendingFields: fields }, emit: null } : { gate, emit: null };
  }
  if (gate.pendingReason !== null) {
    const emit = { reason: gate.pendingReason, fields: gate.pendingFields };
    return { gate: { lastEmitAt: now, pendingReason: null, pendingFields: "" }, emit };
  }
  if (wantsPrint) {
    return { gate: { lastEmitAt: now, pendingReason: null, pendingFields: "" }, emit: { reason, fields } };
  }
  return { gate, emit: null };
}
var SOURCE_ORDER = ["session", "input", "face", "other"];
function dominantRenderSource(counts) {
  let best = null;
  let bestValue = 0;
  for (const source of SOURCE_ORDER) {
    const value = counts[source] ?? 0;
    if (value > bestValue) {
      best = source;
      bestValue = value;
    }
  }
  return best;
}
var initialTallyState = () => ({ reason: null, atTotal: 0 });
var TALLY_MIN_INTERVAL_RENDERS = 50;
var totalOf = (counts) => (counts.session ?? 0) + (counts.input ?? 0) + (counts.face ?? 0) + (counts.other ?? 0);
function stepTally(state, counts) {
  const reason = dominantRenderSource(counts);
  const total = totalOf(counts);
  if (reason === null) return { state, print: false, line: "" };
  if (reason === state.reason) return { state, print: false, line: "" };
  if (total - state.atTotal < TALLY_MIN_INTERVAL_RENDERS) return { state, print: false, line: "" };
  return {
    state: { reason, atTotal: total },
    print: true,
    line: renderTallyLine(counts, reason)
  };
}
function renderTallyLine(counts, reason) {
  return `render tally: dominant=${reason ?? "none"} session=${counts.session ?? 0} input=${counts.input ?? 0} face=${counts.face ?? 0} other=${counts.other ?? 0} total=${totalOf(counts)}`;
}

// src/client/keyspec.ts
var KEY_CODES = {
  tab: "Tab",
  enter: "Enter",
  // `dismissKey` 的默认值是 `Escape`，而匹配端（`specMatches` → `keyCodeOf`）与录制端
  // （`keyNameOfCode`）都只认这张表：漏登记 ⇒ 默认值**静默不生效**（本仓踩过的同一个坑，
  // 见 `accept-key.ts` 头部注释）。钉在 `scripts/keyspec-smoke.mjs` 的默认值断言。
  escape: "Escape",
  slash: "Slash",
  space: "Space",
  comma: "Comma",
  period: "Period",
  minus: "Minus",
  equal: "Equal",
  semicolon: "Semicolon",
  quote: "Quote",
  backquote: "Backquote",
  backslash: "Backslash",
  bracketleft: "BracketLeft",
  bracketright: "BracketRight",
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`f${i + 1}`, `F${i + 1}`]))
};
function keyCodeOf(spec) {
  const parts = spec.split("+").map((p) => p.trim().toLowerCase()).filter(Boolean);
  if (parts.length === 0) return void 0;
  const key = parts[parts.length - 1];
  const direct = key === void 0 ? void 0 : KEY_CODES[key];
  if (direct !== void 0) return direct;
  if (key !== void 0 && /^[a-z]$/.test(key)) return `Key${key.toUpperCase()}`;
  if (key !== void 0 && /^[0-9]$/.test(key)) return `Digit${key}`;
  return void 0;
}
function keyNameOfCode(code) {
  if (code.startsWith("Key") && code.length === 4) return code.slice(3);
  if (code.startsWith("Digit") && code.length === 6) return code.slice(5);
  const arrows = {
    ArrowUp: "Up",
    ArrowDown: "Down",
    ArrowLeft: "Left",
    ArrowRight: "Right"
  };
  if (code in arrows) return arrows[code];
  if (/^F([1-9]|1[0-2])$/.test(code)) return code;
  if (Object.values(KEY_CODES).includes(code)) return code;
  return void 0;
}
var MODIFIER_KEYS = /* @__PURE__ */ new Set(["Alt", "AltGraph", "Control", "Meta", "Shift", "Fn", "FnLock"]);
function keyEventToSpec(event) {
  if (MODIFIER_KEYS.has(event.key)) return void 0;
  const key = keyNameOfCode(event.code);
  if (key === void 0) return void 0;
  const mods = [];
  if (event.altKey) mods.push("Alt");
  if (event.ctrlKey) mods.push("Ctrl");
  if (event.metaKey) mods.push("Meta");
  if (event.shiftKey) mods.push("Shift");
  return [...mods, key].join("+");
}
var KEY_ACTION_PRIORITY = Object.freeze(["accept", "word", "regen", "dismiss", "forget"]);
function keyFactsOf(event) {
  return {
    code: event.code,
    alt: event.altKey,
    ctrl: event.ctrlKey,
    meta: event.metaKey,
    shift: event.shiftKey
  };
}
function specIndex(spec) {
  if (spec === void 0) return void 0;
  const code = keyCodeOf(spec);
  if (code === void 0) return void 0;
  const parts = spec.split("+").map((p) => p.trim().toLowerCase()).filter(Boolean);
  const mods = parts.slice(0, -1).filter((p) => p === "alt" || p === "ctrl" || p === "meta" || p === "shift");
  return `${[...new Set(mods)].sort().join(",")}|${code}`;
}
function specMatches(facts, spec) {
  const index = specIndex(spec);
  if (index === void 0) return false;
  const [mods, code] = index.split("|");
  const set = new Set(mods === "" ? [] : mods.split(","));
  return code === facts.code && facts.alt === set.has("alt") && facts.ctrl === set.has("ctrl") && facts.meta === set.has("meta") && facts.shift === set.has("shift");
}
function ownerOfKey(table, facts) {
  for (const action of KEY_ACTION_PRIORITY) {
    if (specMatches(facts, table[action])) return action;
  }
  return null;
}
function isTextKey(code) {
  if (/^Key[A-Z]$/u.test(code) || /^Digit[0-9]$/u.test(code)) return true;
  const TEXT_CODES = /* @__PURE__ */ new Set([
    "Space",
    "Comma",
    "Period",
    "Minus",
    "Equal",
    "Semicolon",
    "Quote",
    "Backquote",
    "Backslash",
    "BracketLeft",
    "BracketRight"
  ]);
  return TEXT_CODES.has(code);
}
function hasDisarmingModifier(spec) {
  const parts = spec.split("+").map((p) => p.trim().toLowerCase()).filter(Boolean);
  return parts.slice(0, -1).some((p) => p === "alt" || p === "ctrl" || p === "meta");
}
var KEYCAPS = {
  Right: "\u2192",
  Left: "\u2190",
  Up: "\u2191",
  Down: "\u2193",
  Escape: "Esc"
};
function specKeycap(spec) {
  if (spec === void 0) return void 0;
  const parts = spec.split("+").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return void 0;
  const mods = parts.slice(0, -1);
  const main = parts[parts.length - 1];
  if (keyCodeOf(main) === void 0) return void 0;
  return [...mods, KEYCAPS[main] ?? main].join("+");
}
function isSafeActionKey(spec) {
  const code = keyCodeOf(spec);
  if (code === void 0) return false;
  return hasDisarmingModifier(spec) || !isTextKey(code);
}
function isSendCollisionKey(spec) {
  if (keyCodeOf(spec) !== "Enter") return false;
  return spec.split("+").map((p) => p.trim().toLowerCase()).filter(Boolean).length === 1;
}
function bindingConflicts(table, action) {
  const mine = specIndex(table[action]);
  if (mine === void 0) return [];
  return KEY_ACTION_PRIORITY.filter((other) => other !== action && specIndex(table[other]) === mine);
}
function hintSegments(table) {
  const out = [];
  for (const action of KEY_ACTION_PRIORITY) {
    const keycap = specKeycap(table[action]);
    if (keycap !== void 0) out.push({ action, keycap });
  }
  return out;
}
function factsOfSpec(spec) {
  const code = keyCodeOf(spec ?? "");
  if (code === void 0) return void 0;
  const parts = (spec ?? "").split("+").map((p) => p.trim().toLowerCase()).filter(Boolean);
  const mods = new Set(parts.slice(0, -1));
  return {
    code,
    alt: mods.has("alt"),
    ctrl: mods.has("ctrl"),
    meta: mods.has("meta"),
    shift: mods.has("shift")
  };
}
function keyRowStateOf(tables, scopes, action, value) {
  if (value.trim() === "") return "unbound";
  const inAny = scopes.some((w) => tables[w]?.[action] !== void 0);
  if (!inAny) return "off";
  return scopes.some((w) => {
    const table = tables[w];
    return table !== void 0 && bindingConflicts(table, action).length > 0;
  }) ? "clash" : "live";
}

// src/client/settings-result.ts
var OPS_WRITE_MAX_ATTEMPTS = 8;
var OPS_WRITE_CONFLICT_BACKOFF_CAP_MS = 1600;
var OPS_WRITE_CONFLICT_BACKOFF_BASE_MS = 100;
function opsConflictBackoffMs(attempt) {
  const tier = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0;
  return Math.min(
    OPS_WRITE_CONFLICT_BACKOFF_BASE_MS * 2 ** tier,
    OPS_WRITE_CONFLICT_BACKOFF_CAP_MS
  );
}
function opsConflictRetryAllowed(attempt) {
  return Number.isInteger(attempt) && attempt >= 0 && attempt + 1 < OPS_WRITE_MAX_ATTEMPTS;
}
function looksLikeNamespaceView(node) {
  const hasIdentity = typeof node.ns === "string" || typeof node.revision === "number";
  return hasIdentity && ("value" in node || "revision" in node);
}
function unwrapMutateResult(response) {
  const none = () => ({ ok: void 0, code: void 0, message: void 0, view: void 0 });
  let node = response;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof node !== "object" || node === null) return none();
    const record2 = node;
    if (typeof record2.ok === "boolean") {
      if (record2.ok === false) {
        const error = record2.error;
        const box = typeof error === "object" && error !== null ? error : void 0;
        return {
          ok: false,
          code: typeof box?.code === "string" ? box.code : void 0,
          // 老 host 可能把失败压成裸字符串 / 裸 Error：message 一律兜住，供文本判据用。
          message: typeof box?.message === "string" ? box.message : typeof error === "string" ? error : error instanceof Error ? error.message : void 0,
          view: void 0
        };
      }
      node = record2.value;
      continue;
    }
    if ("result" in record2) {
      node = record2.result;
      continue;
    }
    if (looksLikeNamespaceView(record2)) {
      return { ok: true, code: void 0, message: void 0, view: record2 };
    }
    return none();
  }
  return none();
}
function isConflictRefusal(code, message) {
  if (typeof code === "string") return code === "settings/conflict" || code === "SETTINGS_CONFLICT";
  return /conflict|revision/i.test(message ?? "");
}
function verdictFromView(view, expectedRevision, sentPayload) {
  if (view === void 0) return "unreadable";
  const revision = typeof view.revision === "number" ? view.revision : void 0;
  const box = view.value;
  const landedOps = typeof box === "object" && box !== null ? box._ops : void 0;
  if (landedOps === sentPayload) return "landed";
  if (revision !== void 0 && revision !== expectedRevision) return "landed";
  if (revision !== void 0) return "unsettled";
  return "unreadable";
}
function settleWriteVerdict(response, expectedRevision, sentPayload) {
  const outcome = unwrapMutateResult(response);
  if (outcome.ok === false) {
    return isConflictRefusal(outcome.code, outcome.message) ? "refused-conflict" : "refused-other";
  }
  const verdict = verdictFromView(outcome.view, expectedRevision, sentPayload);
  if (verdict !== "unreadable") return verdict;
  return outcome.ok === true ? "unreadable" : "unreadable";
}
function readRejection(error) {
  if (typeof error === "string") return { code: void 0, message: error };
  if (typeof error !== "object" || error === null) return { code: void 0, message: void 0 };
  const box = error;
  return {
    code: typeof box.code === "string" ? box.code : void 0,
    message: typeof box.message === "string" ? box.message : String(error)
  };
}

// src/client/stream-ghost.ts
var passthroughSchema = {
  parse: (value) => value,
  safeParse: (value) => ({ success: true, data: value })
};
var codec = (typeSymbol) => ({
  mode: "strict",
  typeSymbol,
  create: () => passthroughSchema
});
var GHOST_STREAM_NAMESPACE = "ghostStream";
function ghostStreamContribution() {
  return {
    package: "dsh-suggest-ghost",
    descriptors: [{
      id: `${GHOST_STREAM_NAMESPACE}/suggest`,
      service: GHOST_STREAM_NAMESPACE,
      namespace: GHOST_STREAM_NAMESPACE,
      method: "suggest",
      description: "\u672C\u4F1A\u8BDD\u4E0B\u4E00\u6B21\u751F\u6210\u7684\u5EFA\u8BAE\u5E27\u5E8F\u5217\uFF08\u51C0\u5316\u524D\u7F00\uFF1B\u7EC8\u5E27\u624D\u53EF\u91C7\u7EB3\uFF09\u3002",
      mode: "stream",
      invocation: { kind: "direct" },
      parameters: [{
        name: "sessionId",
        wire: "sessionId",
        description: "\u8981\u76D1\u542C\u54EA\u4E2A\u4F1A\u8BDD\u7684\u4E0B\u4E00\u6B21\u751F\u6210\u3002",
        source: "json",
        codec: codec("dsh-session/types#SessionId")
      }],
      cancellation: { parameter: "signal" },
      result: codec("dsh-suggest-ghost#GhostStreamFrame")
    }]
  };
}
function createGhostStreamChannel(deps) {
  let current = null;
  const closeNow = (note) => {
    if (current === null) return;
    const closing = current;
    current = null;
    try {
      closing.handle.dispose?.();
    } catch {
    }
    deps.onState("closed", closing.sessionId, note);
  };
  return {
    open: (sessionId) => {
      if (deps.namespace?.suggest === void 0) {
        deps.onState("unavailable", sessionId, "namespace-missing");
        return;
      }
      if (current?.sessionId === sessionId) return;
      closeNow("replaced");
      try {
        const handle = deps.namespace.suggest(sessionId);
        current = { sessionId, handle };
        deps.onState("open", sessionId, "");
        void (async () => {
          try {
            for await (const frame of handle) deps.onFrame(frame, sessionId);
            if (current?.sessionId === sessionId && current.handle === handle) current = null;
          } catch (error) {
            deps.onState("unavailable", sessionId, String(error instanceof Error ? error.message : error).slice(0, 120));
            if (current?.handle === handle) current = null;
          }
        })();
      } catch (error) {
        deps.onState("unavailable", sessionId, String(error instanceof Error ? error.message : error).slice(0, 120));
      }
    },
    close: (note) => {
      closeNow(note);
    },
    get sessionId() {
      return current?.sessionId ?? null;
    }
  };
}

// src/client/ops-write-queue.ts
var OpsWriteQueue = class {
  /** 真正的写面。失败/异常一律折成本项的 `false`，不向队列外抛。 */
  run;
  /** 排队中（尚未开始执行）的写入，队首最先执行。 */
  pending = [];
  /** 是否有 run 在途（至多一个；看门狗到点是唯一例外，见 `pump`）。 */
  inFlight = false;
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
  itemTimeoutMs;
  constructor(run, itemTimeoutMs = 8e3) {
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
  enqueue(payload, kind = "pull") {
    if (kind === "complete") this.dropQueuedComplete();
    let settle = () => {
    };
    const promise = new Promise((resolve) => {
      settle = resolve;
    });
    this.pending.push({ payload, kind, resolve: settle });
    this.pump();
    return promise;
  }
  /** 排队中（不含在途）的项数。只读。 */
  get size() {
    return this.pending.length;
  }
  /** 若队列里已有一条尚未执行的 complete，兑现其 `false`（未发送）并移除。 */
  dropQueuedComplete() {
    const index = this.pending.findIndex((item) => item.kind === "complete");
    if (index < 0) return;
    const [replaced] = this.pending.splice(index, 1);
    replaced?.resolve(false);
  }
  /** 若没有在途项，取队首开始执行；执行完（无论成败）再递归泵下一个。 */
  pump() {
    if (this.inFlight) return;
    const item = this.pending.shift();
    if (item === void 0) return;
    this.inFlight = true;
    void Promise.resolve().then(async () => {
      const runPromise = (async () => {
        try {
          return await this.run(item.payload, item.kind) === true;
        } catch {
          return false;
        }
      })();
      let landed = false;
      let timedOut = false;
      if (this.itemTimeoutMs > 0) {
        let timer;
        const outcome = await Promise.race([
          runPromise.then((v) => ({ v, timedOut: false })),
          new Promise((resolve) => {
            timer = setTimeout(() => resolve({ v: false, timedOut: true }), this.itemTimeoutMs);
          })
        ]);
        if (timer !== void 0) clearTimeout(timer);
        landed = outcome.v;
        timedOut = outcome.timedOut;
      } else {
        landed = await runPromise;
      }
      this.inFlight = false;
      item.resolve(landed);
      void timedOut;
      this.pump();
    });
  }
};

// src/client/settings-card.tsx
var import_react2 = require("react");

// src/prompt-override.ts
var PROMPT_MAX_CHARS = 6e3;

// src/model-catalog.ts
var MODEL_OPTIONS_PATH = "/api/suggest-ghost/options";

// src/client/useGhostT.ts
var import_react = require("react");

// src/client/ghost-lang.ts
function resolveGhostLang(active) {
  if (active === void 0) return "zh";
  if (active.startsWith("zh")) return "zh";
  return "en";
}

// src/client/useGhostT.ts
var noopSubscribe = () => () => {
};
function useGhostT(locale) {
  const subscribe = (0, import_react.useCallback)(
    (onStoreChange) => locale === void 0 ? noopSubscribe() : locale.subscribe(onStoreChange),
    [locale]
  );
  const getActive = (0, import_react.useCallback)(
    () => locale === void 0 ? void 0 : locale.getSnapshot().active,
    [locale]
  );
  const active = (0, import_react.useSyncExternalStore)(subscribe, getActive, getActive);
  return resolveGhostLang(active);
}

// src/client/styles.ts
var STYLE_ID = "dsh-suggest-ghost-card-css";
var COMPONENTS = [
  /* ==================== 表单根 ==================== */
  /* 裸表单，无卡片容器（对齐官方 SettingsForm） */
  ".sgc-settings-form{display:flex;flex-direction:column}",
  /* ==================== Section 分组 ==================== */
  ".sgc-section{padding:16px 0}",
  ".sgc-section-heading{margin:0;font-size:13px;font-weight:600;line-height:1.5;color:var(--dsw-alias-label-primary)}",
  /* 实验性徽章：数值照抄 dsh-later 的 .ss-section-beta（同一视觉语言，跨插件一致）。 */
  ".sgc-beta{display:inline-flex;align-items:center;padding:1px 8px;margin-left:8px;font-size:11px;font-weight:500;line-height:17px;color:var(--dsw-alias-state-business-primary);background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 10%,transparent);border-radius:999px;corner-shape:round;white-space:nowrap;vertical-align:middle}",
  ".sgc-section-fields{display:flex;flex-direction:column}",
  /* 两列并排网格（对齐 dsh-later 的 grid 布局） */
  ".sgc-section-fieldsGrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}",
  /* ==================== 字段 ==================== */
  ".sgc-field{display:flex;flex-direction:column;gap:6px;padding:12px 0}",
  // 路由三栏：provider | model | 档位（档位合法集由 model 决定 ⇒ 必须同栏）
  ".sgc-routePair{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}",
  "@media (max-width:1100px){.sgc-routePair{grid-template-columns:repeat(2,minmax(0,1fr))}}",
  "@media (max-width:720px){.sgc-routePair{grid-template-columns:minmax(0,1fr)}}",
  // 通用成对分组：两个短控件并排；中屏以下堆叠
  ".sgc-pair{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}",
  "@media (max-width:900px){.sgc-pair{grid-template-columns:minmax(0,1fr)}}",
  ".sgc-fieldHead{display:flex;align-items:center;gap:8px}",
  ".sgc-label-group{display:flex;align-items:center;gap:4px;flex:1;min-width:0}",
  ".sgc-label{min-width:0;color:var(--dsw-alias-label-primary);flex:1;font-size:13px;font-weight:500;line-height:1.5}",
  /* ==================== 输入框 ==================== */
  ".sgc-input{box-sizing:border-box;width:100%;min-height:36px;padding:0 12px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:1.5}",
  ".sgc-input:focus-visible{outline:none;border-color:var(--dsw-alias-state-business-primary)}",
  ".sgc-input:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}",
  ".sgc-inputInvalid{border-color:var(--dsw-alias-state-error-primary)}",
  ".sgc-inputReadOnly{opacity:.6;cursor:not-allowed}",
  /* 多行提示词（Gitea #182）。必须排在 `.sgc-input` **之后**：两条选择器特异性相同，
     靠顺序覆盖 padding / min-height。等宽是因为提示词里要看占位符与换行，比例字体下
     `{{builtin}}` 这种连续花括号容易看串行。 */
  ".sgc-textarea{min-height:120px;padding:8px 12px;line-height:1.6;resize:vertical;overflow:auto;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}",
  /* ==================== 快捷键按钮 ==================== */
  /* 键位表（Gitea #157 续的排版改版）：一行一个动作，左=动作名、中=状态、右=键帽 + ⓘ。
     为什么不用 .sgc-field 那套「标签在上、控件在下」：键帽的值只有 3~8 个字符，
     撑满 959px 的按钮等于 97% 死空间，而眼睛要从最左的值扫到最右的 ⓘ（实测 952px）。
     表格化后行高从 90px 压到 44px，扫读只走一列。 */
  ".sgc-kbGroup{margin-top:10px}",
  ".sgc-kbGroupHead{display:flex;align-items:baseline;gap:8px;margin:0 0 2px;padding:0 0 4px;border-bottom:.5px solid var(--dsw-alias-border-l2)}",
  ".sgc-kbGroupTitle{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary);letter-spacing:.02em}",
  ".sgc-kbGroupScope{font-size:11px;color:var(--dsw-alias-label-tertiary)}",
  ".sgc-kbRow{display:grid;grid-template-columns:minmax(0,1fr) 60px 36px 96px 24px;gap:10px;align-items:center;min-height:36px;padding:4px 0}",
  ".sgc-kbLabel{flex:1;min-width:0;font-size:13px;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
  ".sgc-kbState{font-size:11px;color:var(--dsw-alias-label-tertiary)}",
  ".sgc-kbStateWarn{color:var(--dsw-alias-state-warn-primary)}",
  ".sgc-kbRowOff .sgc-kbLabel,.sgc-kbRowOff .sgc-key{opacity:.45}",
  ".sgc-kbSwitchSlot{width:36px;height:20px;flex:none}",
  ".sgc-kbState{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
  ".sgc-kbCell{display:flex;align-items:center;gap:6px;justify-content:flex-end}",
  ".sgc-key.sgc-keyCompact{width:100%;min-width:0;text-align:center;padding:0 10px;min-height:32px}",
  ".sgc-kbRow .sgc-help{grid-column:1/-1}",
  ".sgc-kbWarns{grid-column:1/-1;margin:0 0 4px;font-size:12px;color:var(--dsw-alias-state-warn-primary)}",
  ".sgc-keyRow{display:flex;gap:8px;align-items:stretch}",
  ".sgc-keyRow>.sgc-key{flex:1 1 auto;min-width:0}",
  ".sgc-keyReset{appearance:none;flex:0 0 auto;cursor:pointer;border:.5px solid var(--dsw-alias-border-l4);background:transparent;color:var(--dsw-alias-label-secondary);border-radius:var(--dsw-radius-md,8px);padding:0 10px;font-size:12px}",
  ".sgc-keyReset:hover:not(:disabled){color:var(--dsw-alias-label-primary)}",
  ".sgc-keyReject{margin:4px 0 0;font-size:12px;color:var(--dsw-alias-state-error-primary)}",
  ".sgc-keyWarn{margin:4px 0 0;font-size:12px;color:var(--dsw-alias-state-warn-primary)}",
  ".sgc-keyEffective{margin:0 0 10px;font-size:12px;color:var(--dsw-alias-label-secondary);line-height:1.5}",
  ".sgc-keyEffectiveLabel{color:var(--dsw-alias-label-tertiary);margin-right:4px}",
  ".sgc-section-note{margin:0 0 10px;font-size:12px;color:var(--dsw-alias-label-secondary)}",
  ".sgc-key{box-sizing:border-box;width:100%;appearance:none;font:inherit;text-align:left;cursor:pointer;border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);min-height:36px;color:var(--dsw-alias-label-primary);border-radius:var(--dsw-radius-md,8px);padding:0 12px;font-size:13px;line-height:1.5}",
  ".sgc-key:focus-visible{border-color:var(--dsw-alias-state-business-primary);outline:none}",
  ".sgc-key:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}",
  ".sgc-keyCapturing,.sgc-keyCapturing:focus-visible{border-color:var(--dsw-alias-brand-primary)}",
  /* ==================== 帮助按钮 ==================== */
  ".sgc-help-btn{width:24px;height:24px;padding:0;flex:none;display:inline-flex;align-items:center;justify-content:center;background:none;border:none;border-radius:8px;cursor:pointer;color:var(--dsw-alias-label-tertiary)}",
  ".sgc-help-btn:hover,.sgc-help-btnOpen{color:var(--dsw-alias-label-secondary)}",
  ".sgc-help-btn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-1px}",
  /* ==================== 帮助展开区 ==================== */
  ".sgc-help{margin:0;padding:10px 0 0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary)}",
  ".sgc-help p{margin:0}",
  /* ==================== Toggle 行（布尔字段） ==================== */
  ".sgc-toggle-row{display:flex;align-items:center;justify-content:space-between;gap:16px}",
  ".sgc-toggle-label{flex:1;min-width:0;font-size:13px;font-weight:500;line-height:1.5;color:var(--dsw-alias-label-primary)}",
  ".sgc-toggle-switch{position:relative;width:36px;height:20px;flex:none;background:var(--dsw-alias-bg-module-platform);border-radius:999px;cursor:pointer;transition:background var(--ds-transition-duration-fast) var(--ds-ease-in-out);border:none;padding:0}",
  '.sgc-toggle-switch[aria-checked="true"]{background:var(--dsw-alias-state-business-primary)}',
  '.sgc-toggle-switch::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:999px;background:#fff;transition:transform var(--ds-transition-duration-fast) var(--ds-ease-in-out)}',
  '.sgc-toggle-switch[aria-checked="true"]::after{transform:translateX(16px)}',
  ".sgc-toggle-switch:disabled{opacity:0.4;cursor:default}",
  ".sgc-toggle-switch:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}",
  ".sgc-toggle-description{margin:0;padding:0 0 0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary)}",
  /* ==================== 只读/策略字段提示 ==================== */
  ".sgc-configOnly{color:var(--dsw-alias-label-tertiary);margin:2px 0 0;font-size:11px;line-height:1.4}",
  ".sgc-invalid{color:var(--dsw-alias-state-error-primary);margin:0;font-size:12px;line-height:1.5}",
  ".sgc-hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}",
  ".sgc-readOnly{color:var(--dsw-alias-label-tertiary);margin:12px 0 0;font-size:12px;line-height:1.5}",
  /* ==================== 底部操作栏 ==================== */
  // 官方 SettingsForm 的 footer 是**左对齐**（按钮在内容下方靠左），不是右下角；状态文字用 margin-left:auto 顶到最右。
  ".sgc-footer{align-items:center;gap:8px;padding-top:16px;display:flex;justify-content:flex-start;flex-wrap:wrap}",
  ".sgc-status{margin-left:auto;min-width:0;color:var(--dsw-alias-state-success-primary);font-size:12px;line-height:1.5}",
  // 底部操作栏按钮：**照官方 Button 的口径**（此前用错 token ⇒ 与官方观感不一致的根源）
  //   官方主按钮：background:--dsw-alias-button-primary-fill / color:--dsw-alias-label-primary-foreground / font-weight:500
  //   官方次按钮(ghost)：background:--dsw-alias-button-ghost-active-fill + inset 边框
  // 旧实现把 `label-primary`（正文色）当底色、`bg-layer-3` 当文字色 —— 那是反色按钮，官方不这么画；
  // 尺寸也从 13px/5px 对齐到官方 14px/22px 行高。
  ".sgc-save{appearance:none;font:inherit;cursor:pointer;border:1px solid transparent;border-radius:8px;padding:6px 14px;font-size:14px;line-height:22px;display:inline-flex;align-items:center;justify-content:center;min-height:34px}",
  ".sgc-save{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);font-weight:500}",
  ".sgc-save:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}",
  ".sgc-save:disabled{opacity:.4;cursor:default}",
  ".sgc-save:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}",
  /* ==================== 热度管理分组 ==================== */
  /* 折叠式 section 标题按钮：外观对齐 .sgc-section-heading（13px/600/primary），可点击展开 */
  ".sgc-sectionBtn{appearance:none;width:100%;font:inherit;background:none;border:0;text-align:left;cursor:pointer;display:flex;align-items:center;justify-content:space-between;gap:8px;color:var(--dsw-alias-label-primary);font-size:13px;font-weight:600;line-height:1.5;padding:0}",
  ".sgc-sectionBtn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;border-radius:4px}",
  ".sgc-sectionBtnText{min-width:0}",
  ".sgc-chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s}",
  ".sgc-chevronOpen{transform:rotate(180deg)}",
  ".sgc-hotList{display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;overflow:hidden;max-height:320px;overflow-y:auto}",
  ".sgc-hotRow{display:flex;align-items:center;gap:8px;padding:6px 10px;min-width:0}",
  ".sgc-hotRow+.sgc-hotRow{border-top:1px solid var(--dsw-alias-border-l2)}",
  ".sgc-hotRow:hover{background:var(--dsw-alias-bg-layer-2)}",
  ".sgc-hotPinFlag{flex:none;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:1px 7px;font-size:11px;font-weight:500;line-height:16px;white-space:nowrap}",
  ".sgc-hotText{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5}",
  ".sgc-hotCount{flex:none;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5;font-variant-numeric:tabular-nums}",
  ".sgc-hotBtn{flex:none;appearance:none;font:inherit;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);background:none;border-radius:6px;padding:2px 8px;font-size:12px;line-height:1.4;color:var(--dsw-alias-label-secondary)}",
  ".sgc-hotBtn:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}",
  ".sgc-hotBtn:disabled{opacity:.4;cursor:default}",
  ".sgc-hotBtn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}",
  ".sgc-hotBtnDanger:hover:not(:disabled){color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}",
  ".sgc-hotAdd{display:flex;gap:8px;margin-top:8px}",
  ".sgc-hotAdd .sgc-input{flex:1;min-width:0;min-height:30px;height:30px;font-size:12px}",
  ".sgc-hotMeta{display:flex;justify-content:space-between;align-items:center;gap:8px;margin:8px 0 0}",
  ".sgc-hotDanger{color:var(--dsw-alias-state-error-primary)}",
  // 「已忽略」子标题（本单）：与 `.sgc-section-heading` 同字号，加一条上分隔线区分
  // 「热度管理」与「已忽略」两块——两者语义相反（一个进候选池、一个出候选池），
  // 挤在同一块视觉里会让人以为它们是同一件事。
  ".sgc-ignoredHeading{margin-top:16px;padding-top:12px;border-top:1px solid var(--dsw-alias-border-l2)}"
].join("\n");
function injectStyles() {
  if (typeof document === "undefined") return () => void 0;
  if (document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`) !== null) {
    return () => void 0;
  }
  const tag = document.createElement("style");
  tag.dataset.plugin = "dsh-suggest-ghost";
  tag.dataset.pluginCss = STYLE_ID;
  tag.textContent = COMPONENTS;
  document.head.appendChild(tag);
  return () => {
    tag.remove();
  };
}

// src/client/settings-card.tsx
var import_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
var import_jsx_runtime = require("react/jsx-runtime");
var GHOST_FIELDS = [
  // —— 显示：生成中的指示 ——
  //
  // 两个选项**刻意独立**（用户要求互不影响、可同时开启）：文案里各自只说自己的效果，
  // 不提对方，也不写"同时开启更明显"这类暗示——那会把两个开关读成一档/两档的渐进关系。
  {
    key: "boxGlowEnabled",
    label: { zh: "\u751F\u6210\u65F6\u8F93\u5165\u6846\u53D1\u5149", en: "Glow around the input box" },
    hint: {
      zh: "\u751F\u6210\u671F\u95F4\u8BA9\u8F93\u5165\u6846\u8FB9\u7F18\u6709\u4E00\u5708\u547C\u5438\u7684\u5FAE\u5149\uFF0C\u7528\u6765\u63D0\u793A\u8FD8\u5728\u751F\u6210\u3002\u5B9E\u9A8C\u6027\u529F\u80FD\uFF0C\u9ED8\u8BA4\u5173\u95ED\u3002",
      en: "Pulse a soft glow around the input box while a suggestion is being generated. Experimental, off by default."
    },
    kind: "boolean",
    section: "appearance",
    writable: true
  },
  {
    key: "caretGlowEnabled",
    label: { zh: "\u751F\u6210\u65F6\u5149\u6807\u547C\u5438", en: "Pulse the text cursor" },
    hint: {
      zh: "\u751F\u6210\u671F\u95F4\u8BA9\u8F93\u5165\u5149\u6807\u5728\u4E24\u79CD\u989C\u8272\u4E4B\u95F4\u7F13\u6162\u53D8\u5316\u3002\u5B9E\u9A8C\u6027\u529F\u80FD\uFF0C\u9ED8\u8BA4\u5173\u95ED\u3002",
      en: "Slowly shift the text cursor between two colors while generating. Experimental, off by default."
    },
    kind: "boolean",
    section: "appearance",
    writable: true
  },
  // —— LLM 下一条建议 ——
  {
    key: "maxInputBytes",
    group: "pair",
    label: { zh: "\u8F93\u5165\u5B57\u8282\u4E0A\u9650", en: "Input byte cap" },
    hint: {
      zh: "\u751F\u6210\u5EFA\u8BAE\u65F6\u6700\u591A\u53D6\u7528\u591A\u5C11\u4E0A\u4E0B\u6587\uFF08\u5B57\u8282\uFF09\u3002\u8C03\u5927\u66F4\u51C6\uFF0C\u4F46\u66F4\u6162\u4E5F\u66F4\u8D39 token\u3002",
      en: "How much context (in bytes) suggestions may use. Larger is more accurate but slower and costs more."
    },
    kind: "number",
    section: "llm",
    writable: true
  },
  {
    key: "maxOutputTokens",
    group: "pair",
    label: { zh: "\u8F93\u51FA\u4EE4\u724C\u4E0A\u9650", en: "Output token cap" },
    hint: {
      zh: "\u5355\u6761\u5EFA\u8BAE\u6700\u591A\u751F\u6210\u591A\u5C11 token\u3002\u63A8\u7406\u6A21\u578B\u8981\u7ED9\u8DB3\u4F59\u91CF\uFF0C\u592A\u5C0F\u4F1A\u751F\u6210\u4E0D\u51FA\u5185\u5BB9\u3002",
      en: "Max tokens per suggestion. Give reasoning models headroom, or they may return nothing."
    },
    kind: "number",
    section: "llm",
    writable: true
  },
  {
    key: "maxSuggestionChars",
    group: "pair",
    label: { zh: "\u5EFA\u8BAE\u5B57\u7B26\u4E0A\u9650", en: "Suggestion character cap" },
    hint: { zh: "\u5E7D\u7075\u6587\u672C\u53EF\u89C1\u5B57\u7B26\u6570\u4E0A\u9650", en: "Max visible characters of the ghost text" },
    kind: "number",
    section: "llm",
    writable: true
  },
  {
    key: "maxRecentTurns",
    group: "pair",
    label: { zh: "\u53C2\u8003\u56DE\u5408\u6570", en: "Recent turns referenced" },
    hint: {
      zh: "\u53C2\u8003\u6700\u8FD1\u591A\u5C11\u4E2A\u56DE\u5408\u7684\u5BF9\u8BDD\u3002\u8C03\u5927\u4E0A\u4E0B\u6587\u66F4\u5B8C\u6574\uFF0C\u8C03\u5C0F\u66F4\u5FEB\u3002",
      en: "How many recent turns are used as context. More is richer, fewer is faster."
    },
    kind: "number",
    section: "llm",
    writable: true
  },
  {
    key: "maxTranscriptChars",
    label: { zh: "\u8F6C\u5F55\u5B57\u7B26\u9884\u7B97", en: "Transcript character budget" },
    hint: {
      zh: "\u9001\u8FDB\u6A21\u578B\u7684\u5BF9\u8BDD\u8BB0\u5F55\u6700\u591A\u591A\u957F\uFF08\u5B57\u7B26\uFF09\uFF0C\u8D85\u51FA\u4F1A\u88AB\u88C1\u6389\u3002\u505C\u987F\u7EED\u5199\u8FD8\u6709\u4E00\u9053\u81EA\u5DF1\u7684\u4E0A\u9650\uFF0C\u89C1\u300C\u7EED\u5199\u4E0A\u4E0B\u6587\u4E0A\u9650\u300D\u3002",
      en: "Max characters of conversation history sent to the model; the rest is trimmed. Pause completion has its own cap \u2014 see Completion context cap."
    },
    kind: "number",
    section: "llm",
    writable: true
  },
  {
    key: "contextSummaryEnabled",
    label: { zh: "\u957F\u4F1A\u8BDD\u6458\u8981", en: "Long session summary" },
    hint: {
      zh: "\u8001\u65E7\u5BF9\u8BDD\u88AB\u88C1\u6389\u65F6\uFF0C\u5148\u628A\u8981\u70B9\u538B\u6210\u6458\u8981\u4FDD\u7559\u4E0B\u6765\uFF08\u4E0D\u989D\u5916\u8C03\u7528\u6A21\u578B\uFF09\u3002",
      en: "When old messages are trimmed, keep their gist as a summary (no extra model calls)."
    },
    kind: "boolean",
    section: "llm",
    writable: true
  },
  {
    key: "contextSummaryChars",
    group: "pair",
    label: { zh: "\u6458\u8981\u5B57\u7B26\u9884\u7B97", en: "Summary character budget" },
    hint: {
      zh: "\u6458\u8981\u6700\u591A\u4FDD\u7559\u591A\u5C11\u5B57\u7B26\u3002\u592A\u5C0F\u4F1A\u4E22\u8981\u70B9\uFF0C\u592A\u5927\u4F1A\u6324\u5360\u6B63\u5F0F\u5BF9\u8BDD\u3002",
      en: "Max summary length. Too small loses details; too large crowds out the conversation."
    },
    kind: "number",
    section: "llm",
    writable: true
  },
  {
    key: "timeoutMs",
    group: "pair",
    label: { zh: "\u8D85\u65F6\uFF08\u6BEB\u79D2\uFF09", en: "Timeout (ms)" },
    hint: {
      zh: "\u4E00\u6B21\u5EFA\u8BAE\u6700\u591A\u7B49\u591A\u4E45\uFF08\u6BEB\u79D2\uFF09\u3002\u7F51\u7EDC\u6162\u53EF\u4EE5\u8C03\u5927\u3002",
      en: "How long a suggestion request may take (ms). Raise it on slow networks."
    },
    kind: "number",
    section: "llm",
    writable: true
  },
  {
    key: "regenKey",
    label: { zh: "\u6362\u4E00\u6761\u5FEB\u6377\u952E", en: "Regenerate shortcut" },
    short: { zh: "\u6362\u4E00\u6761", en: "another" },
    hint: {
      zh: "\u5EFA\u8BAE\u4E0D\u6EE1\u610F\u65F6\u6362\u4E00\u6761\u7684\u5FEB\u6377\u952E\uFF08\u53EA\u5728\u5E7D\u7075\u663E\u793A\u65F6\u751F\u6548\uFF09\u3002\u9ED8\u8BA4 Alt+G\u3002",
      en: "Shortcut to ask for another suggestion (only while the ghost is visible). Alt+G by default."
    },
    kind: "key",
    section: "keybinds",
    writable: true
  },
  {
    key: "regenEnabled",
    label: { zh: "\u5141\u8BB8\u6362\u4E00\u6761", en: "Allow regenerate" },
    hint: {
      zh: "\u6253\u5F00\u540E\u53EF\u4EE5\u6309\u4E0A\u9762\u7684\u5FEB\u6377\u952E\u518D\u8981\u4E00\u6761\u5EFA\u8BAE\uFF1B\u6BCF\u56DE\u5408\u6709\u6B21\u6570\u4E0A\u9650\uFF0C\u907F\u514D\u8BEF\u89E6\u65F6\u8FDE\u7EED\u8C03\u7528\u6A21\u578B\u3002",
      en: "Lets you ask for another suggestion with the shortcut above. Capped per turn so a stray keypress cannot keep calling the model."
    },
    kind: "boolean",
    section: "keybinds",
    writable: true
  },
  {
    key: "acceptKey",
    label: { zh: "\u91C7\u7EB3\u5FEB\u6377\u952E\uFF08\u4E0B\u4E00\u6761\u5EFA\u8BAE\uFF09", en: "Accept shortcut (next suggestion)" },
    short: { zh: "\u91C7\u7EB3", en: "accept" },
    hint: {
      zh: "\u53EA\u4F5C\u7528\u4E8E\u300C\u4E0B\u4E00\u6761\u5EFA\u8BAE\u300D\u90A3\u6761\u5E7D\u7075\u3002\u5B57\u6BCD\u952E\u4E5F\u80FD\u8BBE\uFF0C\u4F46\u5B83\u4F1A\u5403\u6389\u4F60\u6253\u7684\u7B2C\u4E00\u4E2A\u5B57\u7B26\uFF0C\u5EFA\u8BAE\u7528 Tab\u3001\u65B9\u5411\u952E\u6216 F1\u2013F12\u3002",
      en: "Applies to the next-suggestion ghost only. Letters work too, but one swallows your first keystroke \u2014 Tab, arrow keys or F1\u2013F12 are safer."
    },
    kind: "key",
    section: "keybinds",
    writable: true
  },
  {
    key: "localAcceptKey",
    label: { zh: "\u91C7\u7EB3\u5FEB\u6377\u952E\uFF08\u5386\u53F2\u8865\u5168 / \u505C\u987F\u7EED\u5199\uFF09", en: "Accept shortcut (history / pause completion)" },
    short: { zh: "\u91C7\u7EB3", en: "accept" },
    hint: {
      zh: "\u8FD9\u4E24\u7C7B\u8865\u5168\u662F\u8FB9\u6253\u5B57\u8FB9\u51FA\u73B0\u7684\uFF0C\u6240\u4EE5\u53EA\u80FD\u8BBE\u6210\u4E0D\u6253\u5B57\u7684\u952E\uFF1ATab\u3001\u65B9\u5411\u952E\u3001Enter\u3001F1\u2013F12\uFF0C\u6216\u5E26 Alt / Ctrl \u7684\u7EC4\u5408\u3002",
      en: "These two appear while you type, so only non-typing keys are allowed: Tab, arrows, Enter, F1\u2013F12, or a combo with Alt / Ctrl."
    },
    kind: "key",
    section: "keybinds",
    writable: true
  },
  {
    key: "wordAcceptKey",
    label: { zh: "\u9010\u8BCD\u91C7\u7EB3\u5FEB\u6377\u952E", en: "Word-by-word accept shortcut" },
    short: { zh: "\u9010\u8BCD\u91C7\u7EB3", en: "word-by-word" },
    hint: {
      zh: "\u4E00\u6B21\u5403\u4E00\u4E2A\u8BCD\u3002\u9ED8\u8BA4 \u2192\uFF0C\u53EA\u4F5C\u7528\u4E8E\u5386\u53F2\u8865\u5168\u4E0E\u505C\u987F\u7EED\u5199\uFF08\u4E0B\u4E00\u6761\u5EFA\u8BAE\u662F\u6574\u6761\u8986\u76D6\uFF0C\u6CA1\u6709\u9010\u8BCD\u8FD9\u8BF4\uFF09\u3002",
      en: "Takes one chunk at a time. \u2192 by default; applies to history and pause completion (the next suggestion is replaced whole)."
    },
    kind: "key",
    section: "keybinds",
    writable: true
  },
  {
    key: "forgetKey",
    label: { zh: "\u300C\u522B\u518D\u8865\u8FD9\u53E5\u300D\u5FEB\u6377\u952E", en: "Forget-this-suggestion shortcut" },
    short: { zh: "\u522B\u518D\u8865\u8FD9\u53E5", en: "forget this" },
    hint: {
      zh: "\u770B\u5230\u4E0D\u60F3\u518D\u88AB\u8865\u5168\u7684\u90A3\u53E5\u65F6\u6309\u4E0B\u5B83\uFF1A\u8FD9\u53E5\u4F1A\u4ECE\u5019\u9009\u91CC\u6C38\u4E45\u79FB\u9664\uFF0C\u4E4B\u540E\u6253\u5B57\u4E0D\u4F1A\u518D\u8865\u51FA\u6765\uFF0C\u4E5F\u4E0D\u4F1A\u518D\u8BA1\u5165\u70ED\u5EA6\u3002\u7559\u7A7A = \u4E0D\u63A5\u7BA1\u8FD9\u4E2A\u52A8\u4F5C\u3002\u6539\u9519\u4E86\u53EF\u4EE5\u5728\u4E0B\u9762\u7684\u300C\u5DF2\u5FFD\u7565\u300D\u91CC\u6062\u590D\u3002",
      en: "Press it on a ghost you are done with: that line leaves the candidate pool for good and stops counting toward hotness. Empty = no key. Restore it under Ignored below."
    },
    kind: "key",
    section: "keybinds",
    writable: true
  },
  {
    key: "dismissKey",
    label: { zh: "\u5173\u95ED\u5E7D\u7075\u5FEB\u6377\u952E", en: "Dismiss shortcut" },
    short: { zh: "\u5173\u95ED\u5E7D\u7075", en: "dismiss" },
    hint: {
      zh: "\u6536\u8D77\u5F53\u524D\u8FD9\u6761\u5E7D\u7075\uFF0C\u4E0D\u6539\u4F60\u5DF2\u8F93\u5165\u7684\u5185\u5BB9\u3002\u7559\u7A7A = \u4E0D\u63A5\u7BA1\u8FD9\u4E2A\u52A8\u4F5C\uFF0C\u8F93\u5165\u6846\u4E0A\u65B9\u90A3\u884C\u63D0\u793A\u4E5F\u4F1A\u8DDF\u7740\u53BB\u6389\u8FD9\u4E00\u53E5\u3002",
      en: "Hides the current ghost without touching what you typed. Leave it empty to give the action up \u2014 the hint line drops it too."
    },
    kind: "key",
    section: "keybinds",
    writable: true
  },
  {
    key: "llmEnabled",
    label: { zh: "\u542F\u7528 LLM \u5EFA\u8BAE", en: "Enable LLM suggestions" },
    hint: {
      zh: "\u7528\u6A21\u578B\u751F\u6210\u300C\u4E0B\u4E00\u53E5\u8BDD\u300D\u7684\u5EFA\u8BAE\u3002\u5173\u6389\u53EF\u7701 token\uFF0C\u5386\u53F2\u8865\u5168\u4E0E\u70ED\u5EA6\u7EDF\u8BA1\u7167\u5E38\u5DE5\u4F5C\u3002",
      en: "Generate the next-prompt suggestion with the model. Turning it off saves tokens; history completion and hotness still work."
    },
    kind: "boolean",
    section: "llm",
    writable: true
  },
  {
    key: "streamingDelivery",
    label: { zh: "\u6D41\u5F0F\u6295\u9012\u5EFA\u8BAE", en: "Stream suggestion frames" },
    hint: {
      zh: "\u8BA9\u5EFA\u8BAE\u6587\u5B57\u9010\u6B65\u6D6E\u73B0\uFF0C\u800C\u4E0D\u662F\u4E00\u6B21\u6027\u6574\u6BB5\u51FA\u73B0\u3002\u53EA\u5F71\u54CD\u89C2\u611F\uFF0C\u4E0D\u6539\u53D8\u751F\u6210\u901F\u5EA6\u3002",
      en: "Show suggestions appearing gradually instead of all at once. Affects appearance only, not speed."
    },
    kind: "boolean",
    section: "llm",
    writable: true
  },
  // ⚠️ 这两条 hint 原文写的是「留空继承主请求路由」—— 那正是 #47 的故障语义（主会话换到
  // 一条 401 的路由，建议与补全全部跟着漂过去）。留空现在的含义是**跟随部署默认**
  // （GUI 头部选的那条），要旧行为得显式打开下面那个开关。文案跟着语义走，不然界面在骗人。
  {
    key: "provider",
    group: "route",
    label: { zh: "Provider", en: "Provider" },
    hint: {
      zh: "\u5EFA\u8BAE\u7528\u54EA\u4E2A\u6A21\u578B\u670D\u52A1\u3002\u7559\u7A7A = \u8DDF\u968F\u7CFB\u7EDF\u9ED8\u8BA4\uFF0C\u4F46\u4E0D\u8DDF\u968F\u5F53\u524D\u4F1A\u8BDD\u3002",
      en: "Which provider suggestions use. Leave empty to follow the system default (not the current session)."
    },
    kind: "catalog",
    catalog: "providers",
    section: "llm",
    writable: true
  },
  {
    key: "model",
    group: "route",
    label: { zh: "Model", en: "Model" },
    hint: {
      zh: "\u5EFA\u8BAE\u7528\u54EA\u4E2A\u6A21\u578B\u3002\u8981\u548C\u4E0A\u4E00\u9879\u6210\u5BF9\u586B\u5199\uFF1B\u4E24\u9879\u90FD\u7559\u7A7A = \u8DDF\u968F\u7CFB\u7EDF\u9ED8\u8BA4\u3002",
      en: "Which model suggestions use. Fill it together with the provider; leave both empty to follow the system default."
    },
    kind: "catalog",
    catalog: "models",
    section: "llm",
    writable: true
  },
  {
    key: "suggestionReasoningEffort",
    group: "route",
    label: { zh: "\u5EFA\u8BAE\u63A8\u7406\u6863\u4F4D", en: "Suggestion reasoning effort" },
    hint: {
      zh: "\u751F\u6210\u5EFA\u8BAE\u65F6\u7684\u601D\u8003\u5F3A\u5EA6\u3002\u7559\u7A7A = \u7528\u6A21\u578B\u81EA\u5DF1\u7684\u9ED8\u8BA4\u3002\u4E0D\u540C\u6A21\u578B\u53EF\u9009\u6863\u4F4D\u4E0D\u540C\uFF0C\u5217\u8868\u91CC\u6CA1\u6709\u53EF\u4EE5\u76F4\u63A5\u586B\u3002",
      en: "Thinking effort for suggestions. Empty uses the model default. Available levels differ per model; you can type one if it is not listed."
    },
    // 目录驱动（#50）：选项来自宿主 llm.resolveModel(provider, model).reasoning.efforts
    // —— 合法集合随模型变，所以不能硬编码；拿不到就退化成文本框（见 renderField）。
    kind: "catalog",
    catalog: "efforts",
    section: "llm",
    writable: true
  },
  {
    key: "inheritSessionRoute",
    label: { zh: "\u5141\u8BB8\u7EE7\u627F\u4F1A\u8BDD\u8DEF\u7531", en: "Allow inheriting the session route" },
    hint: {
      zh: "\u5173\u95ED\u65F6\uFF0C\u6CA1\u6709\u5355\u72EC\u6307\u5B9A\u6A21\u578B\u7684\u5EFA\u8BAE\u8DDF\u968F\u7CFB\u7EDF\u9ED8\u8BA4\u3002\u4E00\u822C\u4FDD\u6301\u5173\u95ED\u3002",
      en: "When off, suggestions without their own provider/model follow the system default. Usually keep it off."
    },
    kind: "boolean",
    section: "llm",
    writable: true
  },
  // —— 自定义提示词（Gitea #182）——
  //
  // 放在各自分组的最末：它替代的是整条生成指令，不是某个阈值，排在一堆数字中间
  // 会让人以为它也是其中之一。占位符语义写在说明里——不填就永远用内置模板，
  // 所以默认形态下它只是一行安静的说明。
  // 上限 `PROMPT_MAX_CHARS` 从 `src/prompt-override.ts` 引，不在这里抄一份数字：
  // 抄来的数字与 schema 的 `.max()` 一旦分叉，界面挡住的就是另一个长度。
  {
    key: "suggestionPrompt",
    label: { zh: "\u4E0B\u4E00\u6761\u5EFA\u8BAE\u7684\u63D0\u793A\u8BCD", en: "Suggestion prompt" },
    hint: {
      zh: "\u7559\u7A7A\u4F7F\u7528\u5185\u7F6E\u63D0\u793A\u8BCD\u3002\u586B\u4E86\u5219\u6574\u6BB5\u66FF\u6362\uFF0C\u53EF\u5199 {{builtin}} \u4FDD\u7559\u5185\u7F6E\u539F\u6587\u3001{{language}} \u53D6\u672C\u8F6E\u5224\u5B9A\u8BED\u8A00\u3001{{maxChars}} \u53D6\u5B57\u6570\u4E0A\u9650\u3002",
      en: "Empty uses the built-in prompt. Your text replaces it: {{builtin}} keeps the built-in one, {{language}} the detected language, {{maxChars}} the character limit."
    },
    kind: "textarea",
    section: "llm",
    writable: true
  },
  // —— 历史前缀补全 ——
  {
    key: "historyEnabled",
    label: { zh: "\u542F\u7528\u5386\u53F2\u8865\u5168", en: "Enable history completion" },
    hint: {
      zh: "\u8F93\u5165\u65F6\u7528\u4F60\u4EE5\u524D\u8BF4\u8FC7\u7684\u8BDD\u8865\u5168\u540E\u534A\u53E5\u3002",
      en: "Complete what you are typing using things you said before."
    },
    kind: "boolean",
    section: "history",
    writable: true
  },
  {
    key: "historyCrossSession",
    label: { zh: "\u8DE8\u4F1A\u8BDD\u641C\u7D22", en: "Cross-session search" },
    hint: {
      zh: "\u4E5F\u53C2\u8003\u5176\u4ED6\u4F1A\u8BDD\u7684\u5386\u53F2\u3002\u5173\u6389\u5219\u53EA\u7528\u5F53\u524D\u4F1A\u8BDD\u3002",
      en: "Also draw on your other sessions. Off limits it to the current session."
    },
    kind: "boolean",
    section: "history",
    writable: true
  },
  {
    key: "historyMaxEntries",
    group: "pair",
    label: { zh: "\u6700\u5927\u5386\u53F2\u6761\u76EE", en: "Max history entries" },
    hint: {
      zh: "\u6700\u591A\u53C2\u8003\u591A\u5C11\u6761\u5386\u53F2\u8BB0\u5F55\uFF080 = \u4E0D\u9650\uFF09\u3002",
      en: "How many history entries to draw on (0 = no limit)."
    },
    kind: "number",
    section: "history",
    writable: true
  },
  {
    key: "historyMinChars",
    group: "pair",
    // label 必须带模式名：卡片里 `historyMinChars` 与 `inlineMinChars` 曾共用
    // 「最少输入字符」，两个 section 各出现一次——用户改了「历史」那个（存成 3），
    // 以为续写阈值也是 3，实际续写仍按默认 4 判定（2026-10-23 现场）。
    label: { zh: "\u6700\u5C11\u8F93\u5165\u5B57\u7B26\uFF08\u5386\u53F2\u8865\u5168\uFF09", en: "Min typed characters (history)" },
    hint: {
      zh: "\u8F93\u5165\u51E0\u4E2A\u5B57\u4E4B\u540E\u624D\u5F00\u59CB\u8865\u5168\uFF0C\u907F\u514D\u9891\u7E41\u6253\u6270\u3002",
      en: "How many characters to type before completion starts."
    },
    kind: "number",
    section: "history",
    writable: true
  },
  {
    key: "wordAccept",
    label: { zh: "\u9010\u8BCD\u91C7\u7EB3", en: "Word-by-word accept" },
    hint: {
      zh: "\u5173\u6389\u540E\u4E0D\u518D\u9010\u8BCD\u5403\u8FDB\u5EFA\u8BAE\uFF0C\u90A3\u4E2A\u952E\u56DE\u5230\u5B83\u539F\u672C\u7684\u4F5C\u7528\u3002\u7528\u54EA\u4E2A\u952E\u9010\u8BCD\u5728\u300C\u952E\u4F4D\u300D\u91CC\u6539\u3002",
      en: "Off = no chunk-by-chunk take-in; that key goes back to its normal job. The key itself is set under Shortcuts."
    },
    kind: "boolean",
    section: "keybinds",
    writable: true
  },
  {
    key: "showKeyHint",
    label: { zh: "\u952E\u4F4D\u63D0\u793A", en: "Key hint" },
    hint: {
      zh: "\u5EFA\u8BAE\u51FA\u73B0\u65F6\u663E\u793A\u4E00\u884C\u5F53\u524D\u952E\u4F4D\uFF0C\u5185\u5BB9\u8DDF\u968F\u4F60\u5728\u300C\u952E\u4F4D\u300D\u91CC\u6539\u8FC7\u7684\u6BCF\u4E00\u4E2A\u952E\u3002\u5173\u6389\u540E\u8BF4\u660E\u53EA\u5728\u8FD9\u4E2A\u9875\u9762\u3002",
      en: "While a suggestion is shown, one line lists the live keys \u2014 it follows every change you make under Shortcuts. Off = the explanation lives only here."
    },
    kind: "boolean",
    // 回到「外观」：键位分区改版成**快捷键表**之后，每一行都是「一个动作 + 一个键」，
    // 而这个开关既不是动作也不是键，混在表里会多出一行没有键帽的东西（表格化就白做了）。
    // 上一轮把它从 appearance 挪进 keybinds 的理由（「改完键顺手要关的就是它」）不成立了：
    // 表格化之后每一行都是「一个动作 + 一个键帽」，而这个开关既不是动作也没有键帽，
    // 混在表里就是一行破坏列对齐的东西。它管的正是「外观」那一组（输入框上方那行小字）。
    section: "appearance",
    writable: true
  },
  // —— 停顿续写 ——
  {
    key: "inlineEnabled",
    label: { zh: "\u505C\u987F\u7EED\u5199", en: "Pause completion" },
    hint: {
      zh: "\u4F60\u505C\u4E0B\u6765\u65F6\uFF0C\u7531\u6A21\u578B\u63A5\u7740\u5F80\u4E0B\u5199\u3002",
      en: "Let the model continue your draft when you pause."
    },
    kind: "boolean",
    section: "inline",
    writable: true
  },
  {
    key: "inlineDelayMs",
    group: "pair",
    label: { zh: "\u505C\u987F\u65F6\u957F", en: "Pause duration" },
    hint: {
      zh: "\u505C\u4E0B\u591A\u4E45\u4E4B\u540E\u624D\u5F00\u59CB\u7EED\u5199\uFF08\u6BEB\u79D2\uFF09\u3002",
      en: "How long to pause before continuation starts (ms)."
    },
    kind: "number",
    section: "inline",
    writable: true
  },
  {
    key: "inlineMinChars",
    group: "pair",
    label: { zh: "\u6700\u5C11\u8F93\u5165\u5B57\u7B26\uFF08\u505C\u987F\u7EED\u5199\uFF09", en: "Min typed characters (pause)" },
    hint: {
      zh: "\u81F3\u5C11\u8F93\u5165\u51E0\u4E2A\u5B57\u624D\u4F1A\u89E6\u53D1\u7EED\u5199\u3002",
      en: "Minimum characters before continuation can trigger."
    },
    kind: "number",
    section: "inline",
    writable: true
  },
  {
    key: "inlineMaxChars",
    group: "pair",
    label: { zh: "\u7EED\u5199\u957F\u5EA6\u4E0A\u9650", en: "Completion length cap" },
    hint: {
      zh: "\u7EED\u5199\u6700\u591A\u663E\u793A\u591A\u5C11\u5B57\uFF0C\u8D85\u51FA\u6309\u8BCD\u622A\u65AD\u3002",
      en: "Max length of the continuation; longer output is cut at a word boundary."
    },
    kind: "number",
    section: "inline",
    writable: true
  },
  // —— 续写上下文上限（Gitea #190）——
  //
  // 这道上限一直存在，只是过去藏在 `min(转录字符预算, 2000)` 的裸魔数里：用户把
  // 「转录字符预算」调到 50000，续写侧恒定只带约 3 条消息，而那句文案承诺的是别的东西。
  // 现在把它摆到明面上，默认值 = 那道魔数 ⇒ 不填就是今天的行为。
  // 说明里必须写清两道上界的优先级（取更小的那个），否则用户会以为调大这一项就够了。
  {
    key: "completionContextChars",
    group: "pair",
    label: { zh: "\u7EED\u5199\u4E0A\u4E0B\u6587\u4E0A\u9650", en: "Completion context cap" },
    hint: {
      zh: "\u7EED\u5199\u65F6\u6700\u591A\u5E26\u591A\u5C11\u5B57\u7684\u5BF9\u8BDD\u5386\u53F2\uFF08\u9ED8\u8BA4 2000\uFF09\u3002\u8C03\u5927\u66F4\u51C6\u4F46\u7B49\u5F85\u66F4\u4E45\uFF1B\u5B9E\u9645\u53D6\u5B83\u4E0E\u300C\u8F6C\u5F55\u5B57\u7B26\u9884\u7B97\u300D\u4E2D\u8F83\u5C0F\u7684\u90A3\u4E2A\u3002",
      en: "How much history a continuation reads (default 2000). Larger is more accurate but slower; the smaller of this and the transcript budget wins."
    },
    kind: "number",
    section: "inline",
    writable: true
  },
  {
    key: "completionReasoningEffort",
    group: "pair",
    label: { zh: "\u7EED\u5199\u63A8\u7406\u6863\u4F4D", en: "Completion reasoning effort" },
    hint: {
      zh: "\u7EED\u5199\u65F6\u7684\u601D\u8003\u5F3A\u5EA6\u3002\u7559\u7A7A = \u7528\u6A21\u578B\u9ED8\u8BA4\u3002\u8FD9\u91CC\u901A\u5E38\u9009\u4F4E\u6863\uFF0C\u7B49\u5F85\u66F4\u77ED\u3002",
      en: "Thinking effort for continuation. Empty uses the model default; a low level usually feels snappier."
    },
    // 目录驱动（#50）：选项来自宿主 resolveModel 的该模型合法档位；拿不到退化文本框
    kind: "catalog",
    catalog: "efforts",
    section: "inline",
    writable: true
  },
  {
    key: "completionPrompt",
    label: { zh: "\u7EED\u5199\u7684\u63D0\u793A\u8BCD", en: "Completion prompt" },
    hint: {
      zh: "\u7559\u7A7A\u4F7F\u7528\u5185\u7F6E\u63D0\u793A\u8BCD\u3002{{builtin}} / {{language}} / {{maxChars}} \u7684\u542B\u4E49\u4E0E\u300C\u4E0B\u4E00\u6761\u5EFA\u8BAE\u7684\u63D0\u793A\u8BCD\u300D\u4E00\u81F4\u3002",
      en: "Empty uses the built-in prompt. {{builtin}}, {{language}} and {{maxChars}} mean the same as in the suggestion prompt."
    },
    kind: "textarea",
    section: "inline",
    writable: true
  },
  // —— 语言设置 ——
  {
    key: "languageMode",
    label: { zh: "\u5EFA\u8BAE\u8BED\u8A00", en: "Suggestion language" },
    hint: {
      zh: "\u81EA\u52A8\uFF1A\u6839\u636E\u754C\u9762\u8BED\u8A00\u548C\u4F60\u7684\u8F93\u5165\u5224\u65AD\uFF1B\u6307\u5B9A\uFF1A\u56FA\u5B9A\u4F7F\u7528\u6240\u9009\u8BED\u8A00\u3002",
      en: "Auto follows the interface language and what you type; a fixed choice always uses that language."
    },
    kind: "select",
    section: "language",
    writable: true,
    options: [
      { value: "auto", label: { zh: "\u81EA\u52A8", en: "Auto" } },
      { value: "zh", label: { zh: "\u7B80\u4F53\u4E2D\u6587", en: "Simplified Chinese" } },
      { value: "zh-TW", label: { zh: "\u7E41\u9AD4\u4E2D\u6587", en: "Traditional Chinese" } },
      { value: "en", label: { zh: "English", en: "English" } },
      { value: "ja", label: { zh: "\u65E5\u672C\u8A9E", en: "Japanese" } },
      { value: "ko", label: { zh: "\uD55C\uAD6D\uC5B4", en: "Korean" } },
      { value: "ru", label: { zh: "\u0420\u0443\u0441\u0441\u043A\u0438\u0439", en: "Russian" } },
      { value: "fr", label: { zh: "Fran\xE7ais", en: "French" } },
      { value: "de", label: { zh: "Deutsch", en: "German" } },
      { value: "es", label: { zh: "Espa\xF1ol", en: "Spanish" } }
    ]
  },
  {
    key: "uiLocaleWeight",
    label: { zh: "\u754C\u9762\u8BED\u8A00\u6743\u91CD", en: "UI language weight" },
    hint: {
      zh: "\u300C\u81EA\u52A8\u300D\u65F6\u754C\u9762\u8BED\u8A00\u7684\u5206\u91CF\uFF080\u2013500\uFF09\u3002\u8D8A\u5927\u8D8A\u8D34\u8FD1\u754C\u9762\u8BED\u8A00\uFF0C0 = \u5B8C\u5168\u4E0D\u770B\u754C\u9762\u3002",
      en: "In Auto mode, how much the interface language counts (0\u2013500). 0 ignores it entirely."
    },
    kind: "number",
    section: "language",
    writable: true
  }
];
var zhStrings = {
  /** 只读提示 */
  readOnly: "\u5F53\u524D\u90E8\u7F72\u4E0D\u53EF\u5199\uFF08\u5185\u5B58\u6A21\u5F0F\uFF09",
  /** 策略字段（非 volatile）只能改配置文件 */
  configOnly: "\u7B56\u7565\u5B57\u6BB5\uFF1Ahost \u7AEF\u672A\u5F00\u653E\u5199\u5165\uFF0C\u8BF7\u6539 cordis.patch.yml",
  /** 显示设置 section（仅详情页显示） */
  sectionDisplay: "\u663E\u793A\u8BBE\u7F6E",
  /** 「外观」分组：纯视觉开关（两个光效 + 键位提示）。 */
  sectionAppearance: "\u5916\u89C2",
  /** 实验性徽章（与 dsh-later 的「高级语法」同一口径：默认关 + 标题挂徽章）。 */
  betaBadge: "\u5B9E\u9A8C\u6027",
  betaBadgeAria: "\u5B9E\u9A8C\u6027\u529F\u80FD\uFF0C\u884C\u4E3A\u53EF\u80FD\u968F\u7248\u672C\u8C03\u6574",
  showInSettings: "\u5728\u8BBE\u7F6E\u4E2D\u663E\u793A",
  showInSettingsHint: "\u5728\u8BBE\u7F6E\u5BF9\u8BDD\u6846\u4E2D\u663E\u793A\u672C\u63D2\u4EF6\u7684\u8BBE\u7F6E\u9875\uFF08\u5237\u65B0\u9875\u9762\u540E\u751F\u6548\uFF09",
  /** 分组标题 */
  sectionLlm: "LLM \u4E0B\u4E00\u6761\u5EFA\u8BAE",
  sectionHistory: "\u5386\u53F2\u524D\u7F00\u8865\u5168",
  sectionInline: "\u505C\u987F\u7EED\u5199",
  sectionLanguage: "\u8BED\u8A00\u8BBE\u7F6E",
  /** 帮助按钮无障碍标签（label 为字段名） */
  helpFor: (label) => `${label}\u8BF4\u660E`,
  /** footer 状态与按钮 */
  saved: "\u5DF2\u4FDD\u5B58",
  discard: "\u653E\u5F03\u4FEE\u6539",
  saving: "\u4FDD\u5B58\u4E2D\u2026",
  save: "\u4FDD\u5B58",
  /** 数字字段校验错误 */
  invalidNumber: "\u8BF7\u8F93\u5165\u6570\u5B57",
  /** 多行提示词字段：占位符与超长说明（超长必须在保存前挡住，理由见 fieldInvalid）。 */
  promptPlaceholder: "\u7559\u7A7A = \u4F7F\u7528\u5185\u7F6E\u63D0\u793A\u8BCD",
  promptTooLong: (max, current) => `\u63D0\u793A\u8BCD\u6700\u957F ${max} \u5B57\uFF0C\u5F53\u524D ${current} \u5B57\uFF0C\u8BF7\u7CBE\u7B80\u540E\u518D\u4FDD\u5B58`,
  /** 快捷键控件 */
  keyCapturing: "\u6309\u4E0B\u7EC4\u5408\u952E\u2026\uFF08Esc \u53D6\u6D88\uFF09",
  keyEmpty: "\u70B9\u51FB\u8BBE\u7F6E\u5FEB\u6377\u952E",
  keyReset: "\u6062\u590D\u9ED8\u8BA4",
  // —— 键位分区 ——
  sectionKeybinds: "\u952E\u4F4D",
  // —— 键位表（表格化后的组名与行内状态）——
  kbGroupLlm: "\u4E0B\u4E00\u6761\u5EFA\u8BAE",
  kbGroupLlmScope: "\u8349\u7A3F\u4E3A\u7A7A\u65F6\u51FA\u73B0",
  kbGroupLocal: "\u5386\u53F2\u8865\u5168 \xB7 \u505C\u987F\u7EED\u5199",
  kbGroupLocalScope: "\u8FB9\u6253\u5B57\u8FB9\u51FA\u73B0",
  kbGroupBoth: "\u6240\u6709\u5F62\u6001",
  kbGroupBothScope: "\u4E24\u7C7B\u5E7D\u7075\u4E0A\u90FD\u751F\u6548",
  kbStateOff: "\u5DF2\u5173\u95ED",
  kbStateUnbound: "\u4E0D\u63A5\u7BA1",
  kbStateClash: "\u540C\u952E",
  keybindNote: "\u8FD9\u91CC\u5217\u7684\u952E\u53EA\u5728\u5E7D\u7075\u51FA\u73B0\u65F6\u751F\u6548\uFF1B\u6539\u5B8C\u4FDD\u5B58\uFF0C\u8F93\u5165\u6846\u4E0A\u65B9\u90A3\u884C\u63D0\u793A\u4F1A\u8DDF\u7740\u53D8\u3002",
  keyUnsafe: (label) => `\u8FD9\u4E2A\u952E\u4F1A\u5403\u6389\u4F60\u6B63\u5728\u6253\u7684\u5B57\uFF0C${label}\u6362\u4E00\u4E2A`,
  keySendCollision: "\u7528 Enter \u91C7\u7EB3\u4F1A\u9876\u6389\u300C\u53D1\u9001\u300D\uFF0C\u6539\u7528\u7EC4\u5408\u952E\u66F4\u7A33",
  keyConflict: (other, winner) => `\u4E0E\u300C${other}\u300D\u7528\u4E86\u540C\u4E00\u4E2A\u952E\uFF1B\u540C\u65F6\u6309\u4E0B\u65F6\u7531\u300C${winner}\u300D\u5148\u62FF\u8D70`,
  // —— 热度管理 ——
  sectionHotness: "\u70ED\u5EA6\u7BA1\u7406\uFF08\u8DE8\u4F1A\u8BDD\u9AD8\u9891\u77ED\u8BED\uFF09",
  hotHint: "\u5373\u65F6\u751F\u6548\uFF0C\u65E0\u9700\u4FDD\u5B58\u3002\u5220\u9664\u53EA\u6E05\u5F53\u524D\u7EDF\u8BA1\uFF08\u518D\u6B21\u8F93\u5165\u4F1A\u91CD\u65B0\u8BA1\u5165\uFF09\uFF1B\u56FA\u5B9A\u540E\u4E0D\u53C2\u4E0E\u6DD8\u6C70\u3001\u8DE8\u4F1A\u8BDD\u5019\u9009\u6052\u7F6E\u9876\u3002",
  hotSearch: "\u5728\u4E0B\u65B9\u5217\u8868\u4E2D\u8FC7\u6EE4\u2026",
  hotEmpty: "\u6682\u65E0\u70ED\u5EA6\u6761\u76EE\u2014\u2014\u6B63\u5E38\u4F7F\u7528\u51E0\u4E2A\u56DE\u5408\u540E\u81EA\u52A8\u7D2F\u79EF\u3002",
  hotNoMatch: "\u6CA1\u6709\u5339\u914D\u7684\u6761\u76EE\uFF08\u4EC5\u8FC7\u6EE4\u5F53\u524D\u663E\u793A\u7684 top-K\uFF09\u3002",
  hotAdd: "\u6DFB\u52A0",
  hotAddPlaceholder: "\u624B\u5DE5\u65B0\u589E\u4E00\u6761\u5019\u9009\u77ED\u8BED\u2026",
  hotPin: "\u56FA\u5B9A",
  hotUnpin: "\u53D6\u6D88\u56FA\u5B9A",
  hotPinnedBadge: "\u5DF2\u56FA\u5B9A",
  hotDelete: "\u5220\u9664",
  hotClear: "\u6E05\u7A7A\u5168\u90E8",
  hotClearConfirm: "\u786E\u8BA4\u6E05\u7A7A\uFF1F",
  // —— 已忽略（本单）——
  sectionIgnored: "\u5DF2\u5FFD\u7565\uFF08\u4E0D\u4F1A\u518D\u88AB\u8865\u5168\uFF09",
  ignoredHint: "\u8FD9\u4E9B\u53E5\u5B50\u88AB\u300C\u522B\u518D\u8865\u8FD9\u53E5\u300D\u952E\u79FB\u51FA\u4E86\u5019\u9009\u6C60\uFF0C\u4E5F\u505C\u6B62\u8BA1\u5165\u70ED\u5EA6\u3002\u70B9\u300C\u6062\u590D\u300D\u8BA9\u5B83\u4EEC\u91CD\u65B0\u53C2\u4E0E\u8865\u5168\uFF1B\u6062\u590D\u4E0D\u8865\u56DE\u9891\u6B21\uFF08\u9891\u6B21\u662F\u89C2\u6D4B\u503C\uFF0C\u88AB\u5FFD\u7565\u671F\u95F4\u672C\u6765\u5C31\u6CA1\u518D\u8BB0\u8FC7\u8D26\uFF09\u3002",
  ignoredEmpty: "\u8FD8\u6CA1\u6709\u5FFD\u7565\u4EFB\u4F55\u53E5\u5B50\u3002\u7528\u5E7D\u7075\u63D0\u793A\u7684\u300C\u522B\u518D\u8865\u8FD9\u53E5\u300D\u5FEB\u6377\u952E\u5373\u53EF\u52A0\u5165\u8FD9\u91CC\u3002",
  ignoredRestore: "\u6062\u590D",
  ignoredClear: "\u5168\u90E8\u6062\u590D",
  ignoredMeta: (total) => `\u5171\u5FFD\u7565 ${total} \u6761`,
  hotMeta: (total, shown) => total > shown ? `\u5171 ${total} \u6761\uFF0C\u663E\u793A\u70ED\u5EA6\u6700\u9AD8\u7684 ${shown} \u6761` : `\u5171 ${total} \u6761`,
  // —— 目录型下拉框的占位项与档位诊断 ——
  // 这七条此前是**硬编码中文写在渲染路径里**的，没走字典：英文界面下卡片其余部分
  // 都是英文，唯独这几个下拉项/占位符露出中文。宿主注册了 ja 等六门之后，
  // 回退方向改成英文（`ghost-lang.ts`）把这类残留放大成肉眼可见的破洞，故一并收编。
  catalogDeployDefault: "\uFF08\u8DDF\u968F\u90E8\u7F72\u9ED8\u8BA4\uFF09",
  catalogEffortOmit: "\uFF08\u4E0D\u4F20\uFF0C\u6CBF\u7528\u6A21\u578B\u9ED8\u8BA4\uFF09",
  catalogPickProvider: "\uFF08\u5148\u9009 provider\uFF09",
  effortDefaultMark: "\uFF08\u9ED8\u8BA4\uFF09",
  effortNotInCatalog: "\uFF08\u4E0D\u5728\u5F53\u524D\u76EE\u5F55\u91CC\uFF09",
  effortCatalogStale: "\uFF08\u5BBF\u4E3B\u672A\u63D0\u4F9B\u6863\u4F4D\u76EE\u5F55\uFF1A\u91CD\u542F\u4E00\u6B21\u540E\u672C\u680F\u4F1A\u53D8\u4E0B\u62C9\uFF09",
  effortCatalogEmpty: "\uFF08\u8BE5\u6A21\u578B\u672A\u58F0\u660E\u63A8\u7406\u6863\u4F4D\uFF0C\u53EF\u624B\u586B\uFF09",
  catalogDiagTail: (diag) => `\uFF5C\u76EE\u5F55 ${diag}`
};
var enStrings = {
  readOnly: "Not writable in this deployment (in-memory mode)",
  configOnly: "Strategy field: not writable from the UI \u2014 edit cordis.patch.yml",
  sectionDisplay: "Display",
  sectionAppearance: "Appearance",
  betaBadge: "Beta",
  betaBadgeAria: "Beta feature; behaviour may change between versions",
  showInSettings: "Show in settings",
  showInSettingsHint: "Show this plugin's settings page in the settings dialog (refresh to take effect)",
  sectionLlm: "LLM next suggestion",
  sectionHistory: "History prefix completion",
  sectionInline: "Pause completion",
  sectionLanguage: "Language settings",
  helpFor: (label) => `About ${label}`,
  saved: "Saved",
  discard: "Discard changes",
  saving: "Saving\u2026",
  save: "Save",
  invalidNumber: "Enter a number",
  promptPlaceholder: "Leave empty to use the built-in prompt",
  promptTooLong: (max, current) => `Prompts are limited to ${max} characters; this one has ${current}. Shorten it before saving`,
  keyCapturing: "Press a key combo\u2026 (Esc to cancel)",
  keyEmpty: "Click to set a shortcut",
  keyReset: "Reset",
  sectionKeybinds: "Shortcuts",
  kbGroupLlm: "Next suggestion",
  kbGroupLlmScope: "appears on an empty draft",
  kbGroupLocal: "History / pause completion",
  kbGroupLocalScope: "appears while typing",
  kbGroupBoth: "All forms",
  kbGroupBothScope: "applies to both kinds of ghost",
  kbStateOff: "off",
  kbStateUnbound: "not bound",
  kbStateClash: "shared key",
  keybindNote: "These keys only apply while a suggestion is on screen. Save, and the hint line above the composer follows.",
  keyUnsafe: (label) => `That key would eat what you are typing \u2014 pick another for ${label}`,
  keySendCollision: "Using Enter to accept takes over Send \u2014 a combo is safer",
  keyConflict: (other, winner) => `Same key as \u201C${other}\u201D; on that press \u201C${winner}\u201D takes it first`,
  // —— Hotness management ——
  sectionHotness: "Hotness management (frequent cross-session phrases)",
  hotHint: "Takes effect immediately, no save needed. Delete only clears the current tally (typing it again re-counts); pinned entries are exempt from eviction and always lead cross-session candidates.",
  hotSearch: "Filter the list below\u2026",
  hotEmpty: "No entries yet \u2014 they accumulate automatically after a few turns of normal use.",
  hotNoMatch: "No matching entries (filters the displayed top-K only).",
  hotAdd: "Add",
  hotAddPlaceholder: "Manually add a candidate phrase\u2026",
  hotPin: "Pin",
  hotUnpin: "Unpin",
  hotPinnedBadge: "Pinned",
  hotDelete: "Delete",
  hotClear: "Clear all",
  hotClearConfirm: "Confirm clear?",
  // —— Ignored (this change) ——
  sectionIgnored: "Ignored (no longer completed)",
  ignoredHint: "These lines were removed from the candidate pool by the forget shortcut, and stop counting toward hotness. Restore puts them back into completion; it does not restore the tally, since nothing was counted while they were ignored.",
  ignoredEmpty: "Nothing ignored yet. Use the forget shortcut on a ghost to add entries here.",
  ignoredRestore: "Restore",
  ignoredClear: "Restore all",
  ignoredMeta: (total) => `${total} ignored`,
  hotMeta: (total, shown) => total > shown ? `${total} total, showing the top ${shown} by heat` : `${total} total`,
  catalogDeployDefault: "(follow the deployment default)",
  catalogEffortOmit: "(omit; use the model default)",
  catalogPickProvider: "(pick a provider first)",
  effortDefaultMark: "(default)",
  effortNotInCatalog: "(not in the current catalog)",
  effortCatalogStale: "(no effort catalog from the host \u2014 this field becomes a dropdown after a restart)",
  effortCatalogEmpty: "(this model declares no reasoning efforts; you can type one)",
  catalogDiagTail: (diag) => ` | catalog ${diag}`
};
var GHOST_STRINGS = { zh: zhStrings, en: enStrings };
function displayValue(v) {
  if (typeof v === "boolean") return v ? "true" : "false";
  return v === void 0 || v === null ? "" : String(v);
}
function KeyField({ id, value, disabled, t, onChange, validate, notes, resetTo, compact }) {
  const [capturing, setCapturing] = (0, import_react2.useState)(false);
  const [rejected, setRejected] = (0, import_react2.useState)(null);
  (0, import_react2.useEffect)(() => {
    if (!capturing) return;
    const onKey = (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        setCapturing(false);
        setRejected(null);
        return;
      }
      const spec = keyEventToSpec(event);
      if (spec === void 0) return;
      const refusal = validate?.(spec);
      if (refusal !== void 0) {
        setRejected(refusal);
        return;
      }
      onChange(spec);
      setCapturing(false);
      setRejected(null);
    };
    const cancel = () => setCapturing(false);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", cancel);
    };
  }, [capturing, onChange, validate]);
  const canReset = resetTo !== void 0 && resetTo !== value;
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "sgc-keyRow", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        "button",
        {
          type: "button",
          id,
          className: compact ? capturing ? "sgc-key sgc-keyCompact sgc-keyCapturing" : "sgc-key sgc-keyCompact" : capturing ? "sgc-key sgc-keyCapturing" : "sgc-key",
          disabled,
          onClick: () => {
            setCapturing((c) => !c);
            setRejected(null);
          },
          children: capturing ? t.keyCapturing : value === "" ? t.keyEmpty : value
        }
      ),
      canReset && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "sgc-keyReset", disabled, onClick: () => onChange(resetTo), children: t.keyReset })
    ] }),
    rejected !== null && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "sgc-keyReject", children: rejected }),
    (notes ?? []).map((note) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "sgc-keyWarn", children: note }, note))
  ] });
}
var KEY_BINDINGS = {
  acceptKey: { action: "accept", resetTo: "Tab", safety: "warn" },
  localAcceptKey: { action: "accept", resetTo: "Tab", safety: "block" },
  wordAcceptKey: { action: "word", resetTo: "Right", safety: "block" },
  regenKey: { action: "regen", resetTo: "Alt+G", safety: "warn" },
  dismissKey: { action: "dismiss", resetTo: "Escape", safety: "block" },
  // 忽略键：`safety: 'block'` —— 它是**三形态都生效**的动作，配成裸字母键就等于
  // 在用户每次打那个字母时都删掉一条候选（不可逆，且用户看不出是自己配的）。
  // 与 `localAcceptKey` / `wordAcceptKey` 同一条理由。
  forgetKey: { action: "forget", resetTo: "Alt+X", safety: "block" }
};
var KEY_FIELD_OF = {
  accept: "acceptKey",
  word: "wordAcceptKey",
  regen: "regenKey",
  dismiss: "dismissKey",
  forget: "forgetKey"
};
var KEY_TABLES = {
  acceptKey: ["llm"],
  regenKey: ["llm"],
  localAcceptKey: ["local"],
  wordAcceptKey: ["local"],
  dismissKey: ["llm", "local"],
  // 忽略键三形态都接管（与 dismiss 同一圈）：`llm` 的建议文本同样进热表，
  // 用户对它的「别再补这句」意图一致。
  forgetKey: ["llm", "local"]
};
var KEYBIND_SWITCH_OF = {
  wordAcceptKey: "wordAccept",
  regenKey: "regenEnabled"
};
var tableOf = (which, read, switches) => bindingTableFor(which === "llm" ? {
  kind: "llm",
  acceptKey: read("acceptKey"),
  regenKey: read("regenKey"),
  regenEnabled: switches.regen,
  dismissKey: read("dismissKey"),
  forgetKey: read("forgetKey")
} : {
  kind: "history",
  localAcceptKey: read("localAcceptKey"),
  wordAcceptKey: read("wordAcceptKey"),
  wordAccept: switches.word,
  dismissKey: read("dismissKey"),
  forgetKey: read("forgetKey")
});
var kbName = (key, lang) => {
  const f = GHOST_FIELDS.find((x) => x.key === key);
  if (f === void 0) return key;
  return String(f.short?.[lang] ?? f.label[lang]);
};
function keyNotes(key, value, lang, t, read, switches) {
  const meta = KEY_BINDINGS[key];
  if (meta === void 0 || value === "") return [];
  const notes = [];
  if (!isSafeActionKey(value)) {
    notes.push(t.keyUnsafe(kbName(key, lang)));
  }
  if (isSendCollisionKey(value)) notes.push(t.keySendCollision);
  for (const which of KEY_TABLES[key] ?? []) {
    const table = tableOf(which, read, switches);
    const clashes = bindingConflicts(table, meta.action);
    if (clashes.length === 0) continue;
    const loser = clashes[0];
    const facts = factsOfSpec(value);
    const winner = facts === void 0 ? meta.action : ownerOfKey({ ...table, [meta.action]: value, [loser]: value }, facts);
    const fieldOf = (a) => (a === "accept" && which === "local" ? "localAcceptKey" : KEY_FIELD_OF[a]) ?? "";
    notes.push(t.keyConflict(kbName(fieldOf(loser), lang), kbName(fieldOf(winner ?? meta.action), lang)));
    break;
  }
  return notes;
}
function HotnessSection({ scope, pushRaw, hotRaw, writable, busy, lang, t, uiLocale }) {
  const [search, setSearch] = (0, import_react2.useState)("");
  const [adding, setAdding] = (0, import_react2.useState)("");
  const [confirmClear, setConfirmClear] = (0, import_react2.useState)(false);
  const opsRev = (0, import_react2.useRef)(0);
  (0, import_react2.useEffect)(() => {
    if (!confirmClear) return;
    const timer = window.setTimeout(() => setConfirmClear(false), 3e3);
    return () => window.clearTimeout(timer);
  }, [confirmClear]);
  const disabled = !writable || busy;
  const parseHotCell = (raw) => {
    if (typeof raw !== "string" || raw === "" || raw === "null") return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  };
  const hotCell = parseHotCell(hotRaw);
  const pushCell = parseHotCell(pushRaw);
  const hotSource = hotCell ?? pushCell;
  let hot = Array.isArray(hotSource?.hot) ? hotSource.hot : [];
  let total = typeof hotSource?.total === "number" ? hotSource.total : 0;
  if (!Number.isFinite(total) || total < hot.length) total = hot.length;
  const ignored = Array.isArray(hotSource?.ignored) ? hotSource.ignored.filter(
    (e) => typeof e === "object" && e !== null && typeof e.norm === "string" && typeof e.text === "string"
  ) : [];
  const sendOps = (ops) => {
    if (!writable) return;
    opsRev.current += 1;
    const payload = { rev: opsRev.current, ops };
    if (uiLocale) payload.locale = uiLocale;
    void scope.set("_ops", JSON.stringify(payload));
  };
  const needle = search.trim().toLowerCase();
  const visible = needle === "" ? hot : hot.filter((entry) => entry.text.toLowerCase().includes(needle));
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "sgc-hint", children: t.hotHint }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      "input",
      {
        className: "sgc-input",
        type: "text",
        "aria-label": t.hotSearch,
        placeholder: t.hotSearch,
        value: search,
        disabled,
        onChange: (e) => setSearch(e.target.value)
      }
    ),
    hot.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "sgc-hint", children: t.hotEmpty }) : visible.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "sgc-hint", children: t.hotNoMatch }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "sgc-hotList", role: "list", children: visible.map((entry) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "sgc-hotRow", role: "listitem", children: [
      entry.pinned === true && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "sgc-hotPinFlag", children: t.hotPinnedBadge }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "sgc-hotText", title: entry.text, children: entry.text }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "sgc-hotCount", children: [
        "\xD7",
        entry.count
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        "button",
        {
          type: "button",
          className: "sgc-hotBtn",
          disabled,
          onClick: () => sendOps([{ op: "pin", text: entry.text, pinned: entry.pinned !== true }]),
          children: entry.pinned === true ? t.hotUnpin : t.hotPin
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        "button",
        {
          type: "button",
          className: "sgc-hotBtn sgc-hotBtnDanger",
          disabled,
          onClick: () => sendOps([{ op: "delete", text: entry.text }]),
          children: t.hotDelete
        }
      )
    ] }, entry.text)) }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "sgc-hotAdd", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        "input",
        {
          className: "sgc-input",
          type: "text",
          "aria-label": t.hotAddPlaceholder,
          placeholder: t.hotAddPlaceholder,
          value: adding,
          disabled,
          onChange: (e) => setAdding(e.target.value),
          onKeyDown: (e) => {
            if (e.key === "Enter" && adding.trim() !== "" && !disabled) {
              sendOps([{ op: "add", text: adding.trim(), pinned: true }]);
              setAdding("");
            }
          }
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        "button",
        {
          type: "button",
          className: "sgc-hotBtn",
          disabled: disabled || adding.trim() === "",
          onClick: () => {
            sendOps([{ op: "add", text: adding.trim(), pinned: true }]);
            setAdding("");
          },
          children: t.hotAdd
        }
      )
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "sgc-hotMeta", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "sgc-hint", children: t.hotMeta(total, hot.length) }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        "button",
        {
          type: "button",
          className: `sgc-hotBtn sgc-hotBtnDanger${confirmClear ? " sgc-hotConfirming" : ""}`,
          disabled: disabled || hot.length === 0,
          onClick: () => {
            if (!confirmClear) {
              setConfirmClear(true);
              return;
            }
            setConfirmClear(false);
            sendOps([{ op: "clear" }]);
          },
          children: confirmClear ? t.hotClearConfirm : t.hotClear
        }
      )
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h4", { className: "sgc-section-heading sgc-ignoredHeading", children: t.sectionIgnored }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "sgc-hint", children: t.ignoredHint }),
    ignored.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "sgc-hint", children: t.ignoredEmpty }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "sgc-hotList", role: "list", children: ignored.map((entry) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "sgc-hotRow", role: "listitem", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "sgc-hotText", title: entry.text, children: entry.text }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        "button",
        {
          type: "button",
          className: "sgc-hotBtn",
          disabled,
          onClick: () => sendOps([{ op: "restore", text: entry.text }]),
          children: t.ignoredRestore
        }
      )
    ] }, entry.norm)) }),
    ignored.length > 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "sgc-hotMeta", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "sgc-hint", children: t.ignoredMeta(ignored.length) }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        "button",
        {
          type: "button",
          className: "sgc-hotBtn",
          disabled,
          onClick: () => {
            for (const entry of ignored) sendOps([{ op: "restore", text: entry.text }]);
          },
          children: t.ignoredClear
        }
      )
    ] })
  ] });
}
function SuggestGhostCard({ scope, locale, surface, modelCatalog, modelCatalogDiag, modelCatalogSubscribe }) {
  (0, import_react2.useEffect)(() => injectStyles(), []);
  const lang = useGhostT(locale);
  const t = GHOST_STRINGS[lang];
  const [snap, setSnap] = (0, import_react2.useState)(scope.getSnapshot());
  (0, import_react2.useEffect)(() => scope.subscribe(() => setSnap(scope.getSnapshot())), [scope]);
  const [edits, setEdits] = (0, import_react2.useState)({});
  const [busy, setBusy] = (0, import_react2.useState)(false);
  const [saved, setSaved] = (0, import_react2.useState)(false);
  const [helpOpen, setHelpOpen] = (0, import_react2.useState)({});
  const [hotOpen, setHotOpen] = (0, import_react2.useState)(false);
  const [appearanceOpen, setAppearanceOpen] = (0, import_react2.useState)(false);
  const SHOW_SETTINGS_KEY = "dsh-suggest-ghost:show-settings-section";
  const [showSettings, setShowSettings] = (0, import_react2.useState)(() => {
    if (typeof localStorage === "undefined") return false;
    return localStorage.getItem(SHOW_SETTINGS_KEY) === "true";
  });
  const toggleShowSettings = () => {
    const next = !showSettings;
    setShowSettings(next);
    if (typeof localStorage !== "undefined") {
      if (next) localStorage.setItem(SHOW_SETTINGS_KEY, "true");
      else localStorage.removeItem(SHOW_SETTINGS_KEY);
    }
  };
  if (snap.status === "unavailable") return null;
  const value = snap.value ?? {};
  const writable = snap.writable && snap.status === "ready";
  const isDirty = Object.keys(edits).some((k) => GHOST_FIELDS.find((f) => f.key === k)?.writable === true);
  const fieldValue = (key) => {
    if (key in edits) return String(edits[key]);
    return displayValue(value[key]);
  };
  const keyStateNow = () => {
    const read = (k) => fieldValue(k).trim();
    const switches = { word: read("wordAccept") !== "false", regen: read("regenEnabled") !== "false" };
    return {
      read,
      switches,
      tables: { llm: tableOf("llm", read, switches), local: tableOf("local", read, switches) }
    };
  };
  const keyRowState = (key) => {
    const meta = KEY_BINDINGS[key];
    if (meta === void 0) return "live";
    const { read, switches } = keyStateNow();
    return keyRowStateOf(
      { llm: tableOf("llm", read, switches), local: tableOf("local", read, switches) },
      KEY_TABLES[key] ?? [],
      meta.action,
      read(key)
    );
  };
  const keybindGroups = () => {
    const groupOf = (key) => {
      const t2 = KEY_TABLES[key] ?? ["llm", "local"];
      return t2.length >= 2 ? "both" : t2[0];
    };
    const rank = (f) => {
      const a = KEY_BINDINGS[f.key]?.action;
      const i = a === void 0 ? -1 : KEY_ACTION_PRIORITY.indexOf(a);
      return i < 0 ? KEY_ACTION_PRIORITY.length : i;
    };
    return ["llm", "local", "both"].map((id) => ({
      id,
      // 组内按 **KEY_ACTION_PRIORITY** 排，不按 GHOST_FIELDS 的声明顺序。
      // 声明顺序让 `换一条` 排在 `采纳` 前面（因为 regenKey 在字段表里就写在 acceptKey 之前），
      // 而提示行、冲突警告的胜者、`ownerOfKey` 的仲裁用的都是优先级顺序 ——
      // 表格读起来应当与「按下那一下谁先拿走」同序，否则同一个键在三处出现三种次序。
      fields: keybindFields.filter((f) => groupOf(f.key) === id).slice().sort((x, y) => rank(x) - rank(y))
    })).filter((g) => g.fields.length > 0);
  };
  const kbGroupCopy = (id) => id === "llm" ? { title: t.kbGroupLlm, scope: t.kbGroupLlmScope } : id === "local" ? { title: t.kbGroupLocal, scope: t.kbGroupLocalScope } : { title: t.kbGroupBoth, scope: t.kbGroupBothScope };
  const renderKeyRow = (f) => {
    const editable = writable && f.writable;
    const fieldId = `sgc-field-${f.key}`;
    const helpId = `sgc-help-${f.key}`;
    const helpOpenNow = helpOpen[f.key] === true;
    const labelFull = f.label[lang];
    const helpAria = t.helpFor(labelFull);
    const state = keyRowState(f.key);
    const notes = keyNotes(f.key, fieldValue(f.key), lang, t, fieldValue, keyStateNow().switches);
    const switchKey = KEYBIND_SWITCH_OF[f.key];
    const stateText = state === "clash" ? t.kbStateClash : state === "unbound" ? t.kbStateUnbound : state === "off" ? switchKey !== void 0 ? t.kbStateOff : t.kbStateUnbound : "";
    return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: state === "off" || state === "unbound" ? "sgc-kbRow sgc-kbRowOff" : "sgc-kbRow", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("label", { className: "sgc-kbLabel", htmlFor: fieldId, title: labelFull, children: f.short?.[lang] ?? labelFull }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: state === "clash" ? "sgc-kbState sgc-kbStateWarn" : "sgc-kbState", children: stateText }),
      switchKey === void 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "sgc-kbSwitchSlot", "aria-hidden": "true" }) : (() => {
        const switchOn = fieldValue(switchKey) !== "false";
        return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          "button",
          {
            type: "button",
            id: `sgc-field-${switchKey}`,
            role: "switch",
            "aria-checked": switchOn,
            "aria-label": GHOST_FIELDS.find((x) => x.key === switchKey)?.label[lang] ?? switchKey,
            className: "sgc-toggle-switch",
            disabled: !editable || busy,
            onClick: () => setField(switchKey, !switchOn)
          }
        );
      })(),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        KeyField,
        {
          id: fieldId,
          value: fieldValue(f.key),
          disabled: !editable || busy,
          t,
          compact: true,
          onChange: (spec) => setField(f.key, spec),
          resetTo: KEY_BINDINGS[f.key]?.resetTo,
          validate: KEY_BINDINGS[f.key]?.safety === "block" ? (spec) => isSafeActionKey(spec) ? void 0 : t.keyUnsafe(kbName(f.key, lang)) : void 0,
          notes: []
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        "button",
        {
          type: "button",
          className: helpOpenNow ? "sgc-help-btn sgc-help-btnOpen" : "sgc-help-btn",
          "aria-label": helpAria,
          "aria-expanded": helpOpenNow,
          "aria-controls": helpId,
          onClick: () => setHelpOpen((prev) => ({ ...prev, [f.key]: !helpOpenNow })),
          children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.IconInfoOutlineRegular, { size: 12 })
        }
      ),
      notes.length > 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "sgc-kbWarns", children: notes.map((n) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "sgc-kbWarnLine", children: n }, n)) }),
      helpOpenNow && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { id: helpId, role: "region", "aria-label": helpAria, className: "sgc-help", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { children: f.hint[lang] }) })
    ] }, f.key);
  };
  const fieldInvalid = (f) => {
    if (!(f.key in edits)) return false;
    if (f.kind === "number") {
      const raw = String(edits[f.key]).trim();
      return raw === "" || Number.isNaN(Number(raw));
    }
    if (f.kind === "textarea") return String(edits[f.key]).length > PROMPT_MAX_CHARS;
    return false;
  };
  const invalidMessage = (f) => f.kind === "textarea" ? t.promptTooLong(PROMPT_MAX_CHARS, String(edits[f.key] ?? "").length) : t.invalidNumber;
  const anyInvalid = GHOST_FIELDS.some(fieldInvalid);
  const setField = (key, raw) => {
    setEdits((prev) => ({ ...prev, [key]: raw }));
  };
  const CATALOG_PATH = MODEL_OPTIONS_PATH;
  const [catalogProviders, setCatalogProviders] = (0, import_react2.useState)([]);
  const [catalogModels, setCatalogModels] = (0, import_react2.useState)({});
  const [catalogUnavailable, setCatalogUnavailable] = (0, import_react2.useState)(false);
  const [effortFallback, setEffortFallback] = (0, import_react2.useState)(null);
  const [catalogEfforts, setCatalogEfforts] = (0, import_react2.useState)({});
  const [, bumpCatalog] = (0, import_react2.useState)(0);
  (0, import_react2.useEffect)(() => {
    if (typeof modelCatalogSubscribe !== "function") return void 0;
    return modelCatalogSubscribe(() => bumpCatalog((n) => n + 1));
  }, [modelCatalogSubscribe]);
  const providerValue = fieldValue("provider");
  const officialGroups2 = (() => {
    try {
      const groups = typeof modelCatalog === "function" ? modelCatalog() : null;
      return Array.isArray(groups) && groups.length > 0 ? groups : [];
    } catch {
      return [];
    }
  })();
  const officialProviders = officialGroups2.map((g) => ({ id: g.id, name: g.name }));
  const officialModelsOf = (provider) => (officialGroups2.find((g) => g.id === provider)?.models ?? []).map((m) => ({ id: m.id, name: m.name }));
  (0, import_react2.useEffect)(() => {
    let cancelled = false;
    void (async () => {
      if (officialProviders.length > 0) {
        setCatalogProviders(officialProviders);
        return;
      }
      try {
        const res = await fetch(CATALOG_PATH, { method: "GET" });
        if (!res.ok) {
          setCatalogUnavailable(true);
          return;
        }
        const body = await res.json();
        const rows = Array.isArray(body.providers) ? body.providers : [];
        if (cancelled) return;
        setCatalogProviders(rows);
        setCatalogUnavailable(rows.length === 0);
      } catch {
        if (!cancelled) setCatalogUnavailable(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  (0, import_react2.useEffect)(() => {
    const provider = (providerValue ?? "").trim();
    if (provider === "" || catalogUnavailable || catalogModels[provider] !== void 0) return;
    const fromOfficial = officialModelsOf(provider);
    if (fromOfficial.length > 0) {
      setCatalogModels((prev) => ({ ...prev, [provider]: [...fromOfficial] }));
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`${CATALOG_PATH}?models=${encodeURIComponent(provider)}`, { method: "GET" });
        if (!res.ok) return;
        const body = await res.json();
        if (cancelled) return;
        setCatalogModels((prev) => ({
          ...prev,
          [provider]: Array.isArray(body.models) ? body.models : []
        }));
      } catch {
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [providerValue, catalogUnavailable]);
  const modelValue = fieldValue("model");
  (0, import_react2.useEffect)(() => {
    const provider = (providerValue ?? "").trim();
    const model = (modelValue ?? "").trim();
    if (provider === "" || model === "" || catalogUnavailable) return;
    const key = `${provider}|${model}`;
    if (catalogEfforts[key] !== void 0) return;
    const officialReasoning = officialGroups2.find((g) => g.id === provider)?.models.find((m) => m.id === model)?.reasoning;
    if (officialReasoning !== void 0) {
      const list = Array.isArray(officialReasoning.efforts) ? officialReasoning.efforts : [];
      setEffortFallback(list.length === 0 ? "empty" : null);
      if (list.length > 0) {
        setCatalogEfforts((prev) => ({ ...prev, [key]: {
          efforts: list.map((e) => ({ id: e.id, name: e.name, description: e.description })),
          defaultEffort: typeof officialReasoning.defaultEffort === "string" ? officialReasoning.defaultEffort : void 0
        } }));
      }
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`${CATALOG_PATH}?efforts=${encodeURIComponent(key)}`, { method: "GET" });
        if (!res.ok) return;
        const body = await res.json();
        if (cancelled) return;
        if (Array.isArray(body.providers)) {
          setEffortFallback("stale");
          return;
        }
        if (!Array.isArray(body.efforts) || body.efforts.length === 0) {
          setEffortFallback("empty");
          return;
        }
        setEffortFallback(null);
        setCatalogEfforts((prev) => ({
          ...prev,
          [key]: {
            efforts: Array.isArray(body.efforts) ? body.efforts : [],
            defaultEffort: typeof body.defaultEffort === "string" ? body.defaultEffort : void 0
          }
        }));
      } catch {
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [providerValue, modelValue, catalogUnavailable, catalogEfforts]);
  const catalogOptions = (which, currentValue) => {
    const provider = (providerValue ?? "").trim();
    const model = (modelValue ?? "").trim();
    const effortKey = `${provider}|${model}`;
    const rows = which === "providers" ? catalogProviders : which === "models" ? catalogModels[provider] ?? [] : catalogEfforts[effortKey]?.efforts ?? [];
    const current = currentValue;
    const defaultEffort = which === "efforts" ? catalogEfforts[effortKey]?.defaultEffort : void 0;
    const out = rows.map((r) => {
      const base = r.name === r.id ? r.id : `${r.id} \u2014 ${r.name}`;
      const desc = typeof r.description === "string" ? ` \xB7 ${r.description}` : "";
      const mark = defaultEffort === r.id ? t.effortDefaultMark : "";
      return { value: r.id, label: `${base}${desc}${mark}` };
    });
    ;
    if (current !== "" && !out.some((o) => o.value === current)) {
      out.unshift({ value: current, label: `${current}${t.effortNotInCatalog}` });
    }
    return out;
  };
  const save = async () => {
    if (anyInvalid) return;
    setBusy(true);
    try {
      for (const [key, raw] of Object.entries(edits)) {
        const def = GHOST_FIELDS.find((f) => f.key === key);
        if (!def.writable) continue;
        let final = raw;
        if (def.kind === "number") final = Number(raw);
        else if (def.kind === "boolean") final = raw === true || raw === "true";
        else if (def.kind === "key") {
          const trimmed = String(raw).trim();
          if (trimmed === "" && key !== "dismissKey" && key !== "forgetKey") continue;
          final = trimmed;
        }
        await scope.set(key, final);
      }
      setEdits({});
      setSaved(true);
      setTimeout(() => setSaved(false), 2e3);
    } finally {
      setBusy(false);
    }
  };
  const renderField = (f) => {
    const invalid = fieldInvalid(f);
    const editable = writable && f.writable;
    const fieldId = `sgc-field-${f.key}`;
    const helpId = `sgc-help-${f.key}`;
    const helpOpenNow = helpOpen[f.key] === true;
    const helpAria = t.helpFor(f.label[lang]);
    if (f.kind === "boolean") {
      const checked = fieldValue(f.key) === "true";
      return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "sgc-field", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "sgc-toggle-row", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "sgc-label-group", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("label", { className: "sgc-toggle-label", htmlFor: fieldId, children: f.label[lang] }) }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
            "button",
            {
              type: "button",
              id: fieldId,
              role: "switch",
              "aria-checked": checked,
              "aria-label": f.label[lang],
              className: "sgc-toggle-switch",
              disabled: !editable || busy,
              onClick: () => setField(f.key, !checked)
            }
          )
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: invalid ? "sgc-invalid" : "sgc-toggle-description", children: invalid ? t.invalidNumber : f.hint[lang] }),
        !f.writable && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "sgc-configOnly", children: t.configOnly })
      ] }, f.key);
    }
    const inputClass = [
      invalid ? "sgc-input sgc-inputInvalid" : "sgc-input",
      f.writable ? "" : "sgc-inputReadOnly"
    ].filter(Boolean).join(" ");
    const control = f.kind === "key" ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      KeyField,
      {
        id: fieldId,
        value: fieldValue(f.key),
        disabled: !editable || busy,
        t,
        onChange: (spec) => setField(f.key, spec),
        resetTo: KEY_BINDINGS[f.key]?.resetTo,
        validate: KEY_BINDINGS[f.key]?.safety === "block" ? (spec) => isSafeActionKey(spec) ? void 0 : t.keyUnsafe(f.label[lang]) : void 0,
        notes: keyNotes(
          f.key,
          fieldValue(f.key),
          lang,
          t,
          fieldValue,
          { word: fieldValue("wordAccept") !== "false", regen: fieldValue("regenEnabled") !== "false" }
        )
      }
    ) : f.kind === "catalog" && !catalogUnavailable && (f.catalog !== "efforts" || catalogOptions("efforts", fieldValue(f.key)).length > 0) ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
      "select",
      {
        className: inputClass,
        id: fieldId,
        value: fieldValue(f.key),
        disabled: !editable || busy,
        onChange: (e) => setField(f.key, e.target.value),
        children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "", children: (f.catalog ?? "providers") === "providers" ? t.catalogDeployDefault : (f.catalog ?? "") === "efforts" ? t.catalogEffortOmit : (providerValue ?? "").trim() === "" ? t.catalogPickProvider : t.catalogDeployDefault }),
          catalogOptions(f.catalog ?? "providers", fieldValue(f.key)).map((opt) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: opt.value, children: opt.label }, opt.value))
        ]
      }
    ) : f.kind === "select" ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      "select",
      {
        className: inputClass,
        id: fieldId,
        value: fieldValue(f.key),
        disabled: !editable || busy,
        onChange: (e) => setField(f.key, e.target.value),
        children: (f.options ?? []).map((opt) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: opt.value, children: opt.label[lang] }, opt.value))
      }
    ) : f.kind === "textarea" ? (
      // 提示词这类多行文本：单行 `<input>` 装不下，也看不出自己写了多少行。
      // `rows` 固定 5 行 + `resize:vertical`（见 styles.ts 的 `.sgc-textarea`），
      // 关掉拼写检查——这是发给模型的指令，不是散文，波浪线只会误导。
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        "textarea",
        {
          className: invalid ? `${inputClass} sgc-textarea sgc-inputInvalid` : `${inputClass} sgc-textarea`,
          id: fieldId,
          rows: 5,
          spellCheck: false,
          placeholder: t.promptPlaceholder,
          "aria-invalid": invalid || void 0,
          value: fieldValue(f.key),
          disabled: !editable || busy,
          onChange: (e) => setField(f.key, e.target.value)
        }
      )
    ) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      "input",
      {
        className: inputClass,
        placeholder: (() => {
          if (f.catalog !== "efforts") return "";
          const diag = typeof modelCatalogDiag === "function" ? modelCatalogDiag() : null;
          const tail = diag === null || diag === void 0 ? "" : t.catalogDiagTail(diag);
          if (effortFallback === "stale") return `${t.effortCatalogStale}${tail}`;
          if (effortFallback === "empty") return `${t.effortCatalogEmpty}${tail}`;
          return "";
        })(),
        id: fieldId,
        type: "text",
        ...f.kind === "number" ? { inputMode: "numeric" } : {},
        ...invalid ? { "aria-invalid": true } : {},
        value: fieldValue(f.key),
        disabled: !editable || busy,
        onChange: (e) => setField(f.key, e.target.value)
      }
    );
    return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "sgc-field", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "sgc-fieldHead", children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "sgc-label-group", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("label", { className: "sgc-label", htmlFor: fieldId, children: f.label[lang] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          "button",
          {
            type: "button",
            className: helpOpenNow ? "sgc-help-btn sgc-help-btnOpen" : "sgc-help-btn",
            "aria-label": helpAria,
            "aria-expanded": helpOpenNow,
            "aria-controls": helpId,
            onClick: () => setHelpOpen((prev) => ({ ...prev, [f.key]: !helpOpenNow })),
            children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.IconInfoOutlineRegular, { size: 12 })
          }
        )
      ] }) }),
      control,
      invalid && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "sgc-invalid", role: "status", children: invalidMessage(f) }),
      helpOpenNow && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { id: helpId, role: "region", "aria-label": helpAria, className: "sgc-help", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { children: f.hint[lang] }) }),
      !f.writable && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "sgc-configOnly", children: t.configOnly })
    ] }, f.key);
  };
  const renderFieldRun = (fields) => {
    const out = [];
    let i = 0;
    while (i < fields.length) {
      const head = fields[i];
      if (head.group === void 0) {
        out.push(renderField(head));
        i += 1;
        continue;
      }
      const run = [head];
      while (i + run.length < fields.length && fields[i + run.length]?.group === head.group) {
        run.push(fields[i + run.length]);
      }
      out.push(
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          "div",
          {
            className: head.group === "route" ? "sgc-routePair" : "sgc-pair",
            children: run.map((f) => renderField(f))
          },
          `sgc-group-${head.group}-${head.key}`
        )
      );
      i += run.length;
    }
    return out;
  };
  const llmFields = GHOST_FIELDS.filter((f) => f.section === "llm");
  const historyFields = GHOST_FIELDS.filter((f) => f.section === "history");
  const inlineFields = GHOST_FIELDS.filter((f) => f.section === "inline");
  const languageFields = GHOST_FIELDS.filter((f) => f.section === "language");
  const appearanceFields = GHOST_FIELDS.filter((f) => f.section === "appearance");
  const keybindFields = GHOST_FIELDS.filter((f) => f.section === "keybinds" && f.kind === "key");
  const SECTION_LAYOUT = {
    llm: "stack",
    history: "stack",
    inline: "stack",
    language: "grid",
    // 外观组的开关都带一句话说明 ⇒ 单列堆叠，别挤成两栏（挤了说明会折成三行）。
    appearance: "stack",
    // 键位组每一项都要放得下一条录制按钮 + 一到两行警告 ⇒ 同样单列。
    keybinds: "stack"
  };
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "sgc-settings-form", children: [
    !writable && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "sgc-readOnly", role: "status", children: t.readOnly }),
    surface === "detail" && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", { className: "sgc-section", "aria-labelledby": "sgc-section-display", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { className: "sgc-section-heading", id: "sgc-section-display", children: t.sectionDisplay }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "sgc-section-fields", children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "sgc-field", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "sgc-toggle-row", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "sgc-label-group", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("label", { className: "sgc-toggle-label", htmlFor: "sgc-show-settings", children: t.showInSettings }) }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
            "button",
            {
              type: "button",
              id: "sgc-show-settings",
              role: "switch",
              "aria-checked": showSettings,
              "aria-label": t.showInSettings,
              className: "sgc-toggle-switch",
              onClick: toggleShowSettings
            }
          )
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "sgc-toggle-description", children: t.showInSettingsHint })
      ] }) })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", { className: "sgc-section", "aria-labelledby": "sgc-section-llm", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { className: "sgc-section-heading", id: "sgc-section-llm", children: t.sectionLlm }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: SECTION_LAYOUT.llm === "grid" ? "sgc-section-fields sgc-section-fieldsGrid" : "sgc-section-fields", children: renderFieldRun(llmFields) })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", { className: "sgc-section", "aria-labelledby": "sgc-section-history", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { className: "sgc-section-heading", id: "sgc-section-history", children: t.sectionHistory }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: SECTION_LAYOUT.history === "grid" ? "sgc-section-fields sgc-section-fieldsGrid" : "sgc-section-fields", children: renderFieldRun(historyFields) })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", { className: "sgc-section", "aria-labelledby": "sgc-section-inline", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { className: "sgc-section-heading", id: "sgc-section-inline", children: t.sectionInline }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: SECTION_LAYOUT.inline === "grid" ? "sgc-section-fields sgc-section-fieldsGrid" : "sgc-section-fields", children: renderFieldRun(inlineFields) })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", { className: "sgc-section", "aria-labelledby": "sgc-section-keybinds", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { className: "sgc-section-heading", id: "sgc-section-keybinds", children: t.sectionKeybinds }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "sgc-section-note", children: t.keybindNote }),
      keybindGroups().map((g) => {
        const copy = kbGroupCopy(g.id);
        return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "sgc-kbGroup", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "sgc-kbGroupHead", children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "sgc-kbGroupTitle", children: copy.title }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "sgc-kbGroupScope", children: copy.scope })
          ] }),
          g.fields.map(renderKeyRow)
        ] }, g.id);
      })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", { className: "sgc-section", "aria-labelledby": "sgc-section-appearance", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
        "button",
        {
          type: "button",
          id: "sgc-section-appearance",
          className: "sgc-sectionBtn",
          "aria-expanded": appearanceOpen,
          "aria-controls": "sgc-appearance-body",
          onClick: () => setAppearanceOpen((o) => !o),
          children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "sgc-sectionBtnText", children: t.sectionAppearance }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.IconChevronDownOutlineRegular, { size: 14, className: appearanceOpen ? "sgc-chevron sgc-chevronOpen" : "sgc-chevron" })
          ]
        }
      ),
      appearanceOpen && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { id: "sgc-appearance-body", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: SECTION_LAYOUT.appearance === "grid" ? "sgc-section-fields sgc-section-fieldsGrid" : "sgc-section-fields", children: renderFieldRun(appearanceFields) }) })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", { className: "sgc-section", "aria-labelledby": "sgc-section-language", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { className: "sgc-section-heading", id: "sgc-section-language", children: t.sectionLanguage }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: SECTION_LAYOUT.language === "grid" ? "sgc-section-fields sgc-section-fieldsGrid" : "sgc-section-fields", children: renderFieldRun(languageFields) })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", { className: "sgc-section", "aria-labelledby": "sgc-section-hotness", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
        "button",
        {
          type: "button",
          id: "sgc-section-hotness",
          className: "sgc-sectionBtn",
          "aria-expanded": hotOpen,
          "aria-controls": "sgc-hotness-body",
          onClick: () => setHotOpen((o) => !o),
          children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "sgc-sectionBtnText", children: t.sectionHotness }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.IconChevronDownOutlineRegular, { size: 14, className: hotOpen ? "sgc-chevron sgc-chevronOpen" : "sgc-chevron" })
          ]
        }
      ),
      hotOpen && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { id: "sgc-hotness-body", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        HotnessSection,
        {
          scope,
          pushRaw: value._push,
          hotRaw: value._hot,
          writable,
          busy,
          lang,
          t,
          uiLocale: locale?.getSnapshot?.()?.active
        }
      ) })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "sgc-footer", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { className: "sgc-save", disabled: !writable || busy || !isDirty || anyInvalid, onClick: () => void save(), children: busy ? t.saving : t.save }),
      saved && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "sgc-status", role: "status", children: t.saved })
    ] })
  ] });
}

// src/client/pending-indicator.ts
var DEFAULT_PENDING_STYLE = Object.freeze({
  caretGlow: false,
  boxGlow: false
});
var BOX_GLOW_RULE = [
  "@keyframes sg-box-glow{0%,100%{opacity:.55}50%{opacity:1}}",
  'body:has(#dsh-suggest-ghost-overlay[data-box-glow="1"]) [data-composer-card]::after{',
  'content:"";position:absolute;inset:0;pointer-events:none;',
  "border-radius:inherit;box-shadow:inset 0 0 0 1.5px var(--dsw-alias-state-business-primary);",
  "opacity:.55;animation:sg-box-glow 1.6s var(--ds-ease-in-out,cubic-bezier(.4,0,.2,1)) infinite}"
].join("");
var CARET_GLOW_RULE = [
  "@keyframes sg-caret-glow{0%,100%{caret-color:var(--dsw-alias-state-business-primary)}",
  "50%{caret-color:var(--dsw-alias-label-primary)}}",
  'body:has(#dsh-suggest-ghost-overlay[data-caret-glow="1"]) [data-composer-input]{',
  "animation:sg-caret-glow 1.6s var(--ds-ease-in-out,cubic-bezier(.4,0,.2,1)) infinite}",
  "@media (prefers-reduced-motion:reduce){",
  'body:has(#dsh-suggest-ghost-overlay[data-caret-glow="1"]) [data-composer-input]{',
  "animation:none;caret-color:var(--dsw-alias-label-primary)}}"
].join("");

// src/client/pending-clock.ts
function startPending(sessionId, draft, now) {
  return { sessionId, draft, startedAt: now };
}
function tickPending(state, input) {
  if (state === null) return { lit: false, reason: "idle", waitMs: 0 };
  const elapsed = input.now - state.startedAt;
  if (elapsed >= input.deadlineMs) return { lit: false, reason: "expired", waitMs: 0 };
  if (input.sessionId !== state.sessionId) return { lit: false, reason: "session-changed", waitMs: 0 };
  if (!input.draft.startsWith(state.draft)) return { lit: false, reason: "draft-unrelated", waitMs: 0 };
  return { lit: true, reason: "still", waitMs: 0 };
}
function shouldFollowHostFalse(local, hostPending) {
  if (hostPending) return false;
  return local === null;
}

// src/client/key-hint-bar.tsx
var import_react3 = require("react");

// src/client/key-hint-text.ts
var WORDING = {
  accept: { zh: "\u91C7\u7EB3", en: "accept" },
  word: { zh: "\u9010\u8BCD", en: "word" },
  regen: { zh: "\u6362\u4E00\u6761", en: "another" },
  dismiss: { zh: "\u5173\u95ED", en: "dismiss" },
  forget: { zh: "\u522B\u518D\u8865", en: "forget" }
};
function keyHintText(input) {
  return input.segments.map((seg) => input.lang === "en" ? `${seg.keycap} ${WORDING[seg.action].en}` : `${seg.keycap} ${WORDING[seg.action].zh}`).join(" \xB7 ");
}

// src/client/key-hint-bar.tsx
var import_jsx_runtime2 = require("react/jsx-runtime");
var KEY_HINT_TESTID = "dsh-suggest-ghost-keyhint";
function KeyHintBar(props) {
  const { hint } = props;
  if (hint === null) return null;
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
    "div",
    {
      "data-suggest-ghost-keyhint": KEY_HINT_TESTID,
      style: {
        // ── 位置：输入卡片顶部、草稿首行之上的那段空隙（用户明确指定的位置）──
        //
        // 实测几何：card.top=672、草稿文字首行 top=686 ⇒ **空隙 14px**；
        // 编辑器 line-height=24px，但 11px 字号的字形只占约 11px，视觉上放得下。
        // （先前我把 `card padding-top:8px` 当成可用高度、下了"放不下"的结论 ——
        //   那是量错了层：真实空隙是 14px，用户圈出的位置本来就是够的。）
        //
        // 定位：父链为
        //   div(我的) → div(wrapper, static, rect=[0,0]) → .overlayAnchor(absolute, height:0)
        //   → .card(relative)，锚点就在卡片顶部内沿。
        //  - `top:0` ⇒ 与锚点对齐 = 卡片顶部内沿；
        //  - `height:14px` 把这一行的盒高压到空隙内，**不会碰到草稿首行**（判据 ③ 会验）；
        //  - `left:0;right:0` ⇒ 横向吃满卡片（wrapper 是 static，不构成包含块）。
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        // ── 盒高与字号：9px 字，盒子**只包到字**，底部不留空白 ──
        //
        // 空间约束（实测）：编辑器 `[data-composer-input]` 从卡片顶 +8px 开始，
        // 与提示行这条 672–686 的带子重叠。要让 9px 的字不被裁、且不被编辑器盖住：
        //  - `lineHeight` 必须 ≥ 字号的**字形**高度（9px 字约需 9px 行框），否则上下沿被裁；
        //  - 盒高不能超过 8px 太多（否则底部又被编辑器覆盖，判据 ③b 会红）。
        //
        // 折中做法：行框给 9px（字不被裁），盒子高度也收紧到 9px，
        // 底部**不再额外留 padding** —— 之前 14px 盒高时下面空着一大截，用户觉得宽。
        height: 9,
        padding: "0 12px",
        lineHeight: "9px",
        fontSize: 9,
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
        color: "var(--dsw-alias-label-tertiary, #8b8f94)",
        pointerEvents: "none"
      },
      children: keyHintText(hint)
    }
  );
}
function KeyHintBarSlot(props) {
  const { keyHintNow, subscribe } = props;
  const hint = (0, import_react3.useSyncExternalStore)(
    subscribe ?? (() => () => {
    }),
    keyHintNow,
    keyHintNow
  );
  const [, bump] = (0, import_react3.useState)(0);
  (0, import_react3.useEffect)(() => {
    const id = setInterval(() => {
      if (keyHintNow() !== hint) bump((n) => n + 1);
    }, 1e3);
    return () => clearInterval(id);
  }, [hint, keyHintNow]);
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(KeyHintBar, { hint });
}

// src/client/failure-note.tsx
var import_react4 = require("react");
var import_jsx_runtime3 = require("react/jsx-runtime");
var FAILURE_NOTE_TESTID = "dsh-suggest-ghost-failure-note";
var FAILURE_NOTE_TEXT = {
  "max-tokens": {
    zh: "\u5EFA\u8BAE\u751F\u6210\u672A\u5B8C\u6210\uFF1A\u8F93\u51FA\u9884\u7B97\u88AB\u63A8\u7406\u5185\u5BB9\u7528\u5B8C",
    en: "Suggestion incomplete: reasoning used up the output budget"
  },
  effort: {
    zh: "\u5EFA\u8BAE\u751F\u6210\u5931\u8D25\uFF1A\u8BE5\u6A21\u578B\u4E0D\u652F\u6301\u6240\u9009\u63A8\u7406\u6863\u4F4D",
    en: "Suggestion failed: this model does not support the selected reasoning effort"
  },
  timeout: {
    zh: "\u5EFA\u8BAE\u751F\u6210\u8D85\u65F6",
    en: "Suggestion timed out"
  },
  shape: {
    zh: "\u5EFA\u8BAE\u751F\u6210\u5931\u8D25\uFF1A\u6A21\u578B\u8FD4\u56DE\u4E86\u65E0\u6CD5\u91C7\u7EB3\u7684\u5185\u5BB9",
    en: "Suggestion failed: the model returned unusable content"
  },
  config: {
    zh: "\u5EFA\u8BAE\u751F\u6210\u5931\u8D25\uFF1A\u914D\u7F6E\u4E0D\u5B8C\u6574",
    en: "Suggestion failed: incomplete configuration"
  },
  other: {
    zh: "\u5EFA\u8BAE\u751F\u6210\u5931\u8D25\uFF08\u8BE6\u89C1\u63A7\u5236\u53F0\u7559\u75D5\uFF09",
    en: "Suggestion failed (see console trace)"
  }
};
function failureNoteText(reason, lang) {
  const row = FAILURE_NOTE_TEXT[reason] ?? FAILURE_NOTE_TEXT.other;
  return lang === "zh" ? row.zh : row.en;
}
function FailureNote(props) {
  const { failureNow, subscribe, lang } = props;
  const note = (0, import_react4.useSyncExternalStore)(
    subscribe ?? (() => () => {
    }),
    failureNow,
    failureNow
  );
  if (note === null) return null;
  return /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
    "div",
    {
      "data-suggest-ghost-failure": FAILURE_NOTE_TESTID,
      role: "status",
      "aria-live": "polite",
      style: {
        // 与键位提示同一套定位（零高度锚点、卡片顶部），见模块注释。
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        height: 9,
        padding: "0 12px",
        lineHeight: "9px",
        fontSize: 9,
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
        // 比提示行更弱一档：它是"没发生什么"的说明，不该比建议本身显眼。
        color: "var(--dsw-alias-label-quaternary, var(--dsw-alias-label-tertiary, #8b8f94))",
        opacity: 0.85,
        // 不抢焦点、不拦点击：用户打字时它的存在完全无感。
        pointerEvents: "none",
        userSelect: "none"
      },
      children: failureNoteText(note.reason, lang === "zh" ? "zh" : "en")
    }
  );
}

// src/client/index.ts
function mapOfficialGroups(groups) {
  const out = [];
  for (const group of groups ?? []) {
    if (typeof group.id !== "string" || group.id === "") continue;
    const models = [];
    for (const model of group.models ?? []) {
      if (typeof model.id !== "string" || model.id === "") continue;
      const efforts = (model.reasoning?.efforts ?? []).flatMap((effort) => {
        if (typeof effort.id !== "string" || effort.id === "") return [];
        const name2 = typeof effort.name === "string" && effort.name !== "" ? effort.name : effort.id;
        return [typeof effort.description === "string" && effort.description !== "" ? { id: effort.id, name: name2, description: effort.description } : { id: effort.id, name: name2 }];
      });
      const defaultEffort = typeof model.reasoning?.defaultEffort === "string" ? model.reasoning.defaultEffort : void 0;
      models.push({
        id: model.id,
        name: typeof model.name === "string" && model.name !== "" ? model.name : model.id,
        ...model.reasoning === void 0 ? {} : { reasoning: { efforts, ...defaultEffort === void 0 ? {} : { defaultEffort } } }
      });
    }
    out.push({ id: group.id, name: typeof group.name === "string" && group.name !== "" ? group.name : group.id, models });
  }
  return out;
}
var officialGroups = null;
var officialCatalogDiag = null;
var officialCatalogInflight = null;
var officialCatalogReader = null;
var officialCatalogLoader = null;
var officialCatalogListener = null;
var currentSessionIdOf = (snapshot) => {
  const current = snapshot.current;
  if (typeof current === "string" && current !== "") return current;
  return Object.values(snapshot.byId).find((row) => (row.retainedBy?.mainView ?? 0) > 0)?.id;
};
function unwrapSettingsDoc(response) {
  let node = response;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof node !== "object" || node === null) return void 0;
    const record2 = node;
    if (Array.isArray(record2.namespaces)) return record2;
    if (record2.ok === true) {
      node = record2.value;
      continue;
    }
    if ("result" in record2) {
      node = record2.result;
      continue;
    }
    if ("value" in record2) {
      node = record2.value;
      continue;
    }
    return void 0;
  }
  return void 0;
}
var PROJECTION_KEY = "suggestGhost";
var OVERLAY_ID = "dsh-suggest-ghost-overlay";
var PENDING_STYLE_ID = "dsh-suggest-ghost-pending-css";
var SETTINGS_NAMESPACE = "suggest-ghost";
var SETTINGS_SECTION_ID = "suggest-ghost";
var SECTION_LABELS = { zh: "\u8F93\u5165\u9884\u6D4B", en: "Input prediction" };
var PULL_MAX_ATTEMPTS = 4;
var PULL_RETRY_BASE_MS = 600;
var PENDING_MIN_VISIBLE_MS = 1200;
var PENDING_DEADLINE_MS = 6e4;
var name = "dsh-suggest-ghost";
var inject = ["conversation", "sessions", "remote", "remote.settings", "slots", "locale"];
var COMPOSER_SELECTOR = "[data-input-scroll] textarea, [data-input-scroll] [data-composer-input]";
function isComposerElement(el) {
  if (el === null) return false;
  const composer = el.closest("[data-input-scroll]") !== null && (el.matches("textarea") || el instanceof HTMLElement && el.isContentEditable);
  return composer;
}
function isComposerTarget(target) {
  return target instanceof Element && isComposerElement(target);
}
function suggestionFailureReason(message) {
  if (message.includes(MAX_TOKENS_STOP_CODE)) return "max-tokens";
  if (message.includes("reached maxOutputTokens")) return "max-tokens";
  if (message.includes(UNSUPPORTED_EFFORT_CODE) || /reasoning[ _-]?effort/i.test(message)) return "effort";
  if (/timed? ?out|timeout|abort/i.test(message)) return "timeout";
  if (/must contain text only|requested a tool/i.test(message)) return "shape";
  if (/no model-visible transcript|configuration is required/i.test(message)) return "config";
  return "other";
}
var MAX_TOKENS_STOP_CODE = "SUGGEST_GHOST_MAX_TOKENS";
var UNSUPPORTED_EFFORT_CODE = "UNSUPPORTED_REASONING_EFFORT";
function caretAtComposerEnd(el) {
  if (el instanceof HTMLTextAreaElement) {
    return el.selectionStart === el.value.length && el.selectionEnd === el.value.length;
  }
  const selection = document.getSelection();
  if (selection === null || selection.rangeCount === 0 || !selection.isCollapsed) return false;
  if (el.textContent === "") return true;
  const range = selection.getRangeAt(0);
  let last = el.lastChild;
  while (last !== null && last.lastChild !== null) last = last.lastChild;
  if (range.endContainer === last) {
    return range.endOffset === (last.textContent?.length ?? 0);
  }
  return range.endContainer === el && range.endOffset === el.childNodes.length;
}
var overlayShapeOf = (content) => ({
  kind: content.kind,
  anchorText: content.kind === "llm" ? "" : content.prefix,
  suffixText: content.kind === "llm" ? content.text : content.suffix
});
var lastElementChildOf = (host) => {
  for (let i = host.children.length - 1; i >= 0; i -= 1) {
    const child = host.children[i];
    if (child instanceof HTMLElement) return child;
  }
  return null;
};
var lastLineRectOf = (block) => {
  const range = document.createRange();
  range.selectNodeContents(block);
  const rects = range.getClientRects();
  for (let i = rects.length - 1; i >= 0; i -= 1) {
    const rect = rects[i];
    if (rect === void 0) continue;
    if (rect.width > 0 || rect.height > 0) {
      return { right: rect.right, top: rect.top, height: rect.height };
    }
  }
  return null;
};
var tailRectOf = (node) => {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node;
    const value = text.nodeValue ?? "";
    if (value.length === 0) return null;
    const range = document.createRange();
    range.setStart(text, Math.max(0, value.length - 1));
    range.setEnd(text, value.length);
    const rect = range.getBoundingClientRect();
    return rect.width > 0 || rect.height > 0 ? { right: rect.right, top: rect.top, height: rect.height } : null;
  }
  if (!(node instanceof HTMLElement)) return null;
  const display = getComputedStyle(node).display;
  if (/^inline-(block|flex|grid|table)/.test(display)) {
    const box2 = node.getBoundingClientRect();
    return box2.width > 0 || box2.height > 0 ? { right: box2.right, top: box2.top, height: box2.height } : null;
  }
  if (!display.startsWith("inline")) {
    const line2 = lastLineRectOf(node);
    if (line2 !== null) return line2;
    const box2 = node.getBoundingClientRect();
    return box2.width > 0 || box2.height > 0 ? { right: box2.right, top: box2.top, height: box2.height } : null;
  }
  const kids = node.childNodes;
  for (let i = kids.length - 1; i >= 0; i -= 1) {
    const child = kids[i];
    if (child === void 0) continue;
    if (child.nodeType === Node.TEXT_NODE) {
      if ((child.nodeValue ?? "").length === 0) continue;
      return tailRectOf(child);
    }
    if (child instanceof HTMLElement) return tailRectOf(child);
  }
  const line = lastLineRectOf(node);
  if (line !== null) return line;
  const box = node.getBoundingClientRect();
  return box.width > 0 || box.height > 0 ? { right: box.right, top: box.top, height: box.height } : null;
};
var GhostOverlay = class {
  el;
  composer = null;
  /**
   * 滚动容器（`[data-input-scroll]`）。
   *
   * 定位**不用**它（overlay 随内容自动滚动），保留它只为了挂 `scroll` 监听：
   * 滚动会使内容相对视口位移，需要触发一次重对齐与自检。
   */
  scroller = null;
  onScroll;
  onResize;
  /** 结构变化的合并入口（rAF 一拍只重排一次，见 {@link mutationObserver}）。 */
  onDomMutation;
  styleTag;
  /**
   * 生成中指示的样式标签（内容随设置变化）。
   *
   * 惰性创建：两个开关都关且从未开过时，这个节点根本不存在 ⇒ 零额外 DOM、零额外
   * 样式表。`syncPendingStyle()` 第一次真的需要时才插。
   */
  pendingStyle = null;
  /** 尺寸变化观察者：composer 自动增高/附件行出现/字体回流都会改变内容起点。 */
  resizeObserver = null;
  /**
   * 结构变化观察者：`ResizeObserver` 只看尺寸，看不到「盒子大小没变、里面换了内容」
   * 这一类变化——而引用 chip / quote 是**装饰器节点**，React portal 的提交晚于
   * Lexical 的 DOM 更新，量早一拍就会量到空盒子（锚点落到 chip 之前 ⇒ 灰字压在引用上）。
   * 回调里只标脏 + 重对齐，用 rAF 合并（一次渲染期间的多次 DOM 变更只重排一次）。
   */
  mutationObserver = null;
  /** rAF 合并标记（见 {@link onDomMutation}）。 */
  mutationFrame = 0;
  /** 正在显示的内容（供 ResizeObserver 回调重对齐后重新自检）。 */
  current = null;
  /**
   * 上一次**成功绘制**的形状（#38 快路径的输入）。与 `current` 同步更新，
   * 但 `hide()` / 自检被拦时一并清空——快路径只能在「屏幕上真有幽灵」时走。
   */
  shape = null;
  /** overlay 当前是否真的在绘制（`display:block` 且 `verify()` 通过、`data-shown="1"`）。 */
  painted = false;
  /**
   * 锚点脏标记：自上次全量对齐后发生过滚动 / 尺寸变化 / 重新挂载，则行尾坐标**可能**
   * 已移动，增长帧最多只能轻量重测一次，不能零测量。
   */
  anchorDirty = true;
  /** 上次全量对齐量到的行尾锚点（null = 没量过 / llm 形态没有行尾锚点）。 */
  anchor = null;
  /** 最近一次绘制是否走了增长快路径（错峰补渲染据此跳过重复重画）。 */
  lastPaintWasGrowth = false;
  /** 绘制计数（留痕与冒烟外部可观测；只有数字，没有正文）。 */
  paintStats = { growth: 0, remeasure: 0, rebuild: 0 };
  /**
   * #113：把本回合的逐帧痕迹写到**既有 overlay 节点**的 dataset 上，让"回合结束之后
   * 还能不能重建这张表"有答案 —— 判据是纯读 DOM，不依赖任何 console 捕获。
   *
   * 为什么落在 overlay 而不是新开一个全局对象：全局对象要自己管生命周期，而本插件
   * 一个页面里可能有多条 fiber（热重载/多实例），全局会打架；overlay 节点随 fiber 的
   * `destroy()` 一起消失，天然对齐。
   *
   * ⚠️ 与取证脚本的约定：本属性**只由本方法写**。外部若只是清空 `textContent` /
   * 改 `display` / 重新绘制，属性不受影响（已核：`scripts/cross-kernel` 那边没有
   * 替换节点的动作）；但若谁**替换/重建 overlay 节点**，痕迹会随之消失 —— 那属于
   * 换了载体，不是本条要保的性质，别在这里偷偷兜。
   */
  setStreamFrames(list) {
    if (list.length === 0) {
      delete this.el.dataset.streamFrames;
      return;
    }
    this.el.dataset.streamFrames = JSON.stringify(list);
  }
  constructor() {
    this.el = document.createElement("div");
    this.el.id = OVERLAY_ID;
    this.el.style.cssText = [
      "position:absolute",
      "pointer-events:none",
      "white-space:pre-wrap",
      "word-break:break-word",
      // 不设 overflow:hidden：它会贴着盒子边界裁掉 text-shadow 光晕（明显切割感）；
      // 换行安全已由 pre-wrap + break-word 保证，盒子高度自适应无需纵向裁剪。
      // 对齐官方 composer placeholder 的色阶（label-caption，全透明度），
      // 而非更重的 label-secondary：保证「幽灵」比正文明显更淡。
      "color:var(--dsw-alias-label-caption, #9aa0a6)",
      // 轻微同色泛光（贴身 1px + 8px 柔光晕）：与原生 placeholder 区分，
      // 提示这是「可采纳的建议」而非占位文案；同色晕不改变色相、暗/亮主题通用。
      "text-shadow:0 0 1px var(--dsw-alias-label-caption, #9aa0a6), 0 0 8px var(--dsw-alias-label-caption, #9aa0a6)",
      "z-index:1",
      // 初值：不绘制。用 display（而非旧版的 visibility）——见下方 show()/hide()
      // 与类注释，display 让节点彻底退出渲染，避免任何过渡期双绘。
      "display:none"
    ].join(";");
    this.onScroll = () => {
      this.anchorDirty = true;
    };
    this.onResize = () => {
      this.anchorDirty = true;
      this.alignAndVerify();
    };
    this.onDomMutation = () => {
      if (this.mutationFrame !== 0) return;
      const run = () => {
        this.mutationFrame = 0;
        this.anchorDirty = true;
        this.alignAndVerify();
      };
      this.mutationFrame = typeof requestAnimationFrame === "function" ? requestAnimationFrame(run) : setTimeout(run, 0);
    };
    this.styleTag = document.createElement("style");
    this.styleTag.dataset.pluginCss = "dsh-suggest-ghost";
    this.styleTag.textContent = [
      // ── 让位规则：幽灵**正在显示**时，placeholder 必须让位 ──
      //
      // 判据同时要求 `data-shown="1"` **且** overlay 未被 `display:none` 隐藏。
      // 只写 `data-shown` 不够：`hide()` / 自检失败路径会把 display 置回 none，
      // 若此时仍据 `data-shown` 或「节点存在」去隐藏 placeholder，就会出现
      // 「幽灵没显示、占位文案也没了」——草稿清空后输入框一片空白（实测过）。
      // 反过来只据「节点存在」同样错：节点在首次 show 后就常驻 DOM 不移除。
      //
      // `:not([style*="display: none"])` 读的是内联 style（本插件唯一写 display
      // 的地方），故与自身写入的状态严格同步，无属性时序竞态。
      'body:has(#dsh-suggest-ghost-overlay[data-shown="1"]:not([style*="display: none"])) [data-composer-placeholder]{display:none!important}',
      'body:has(#dsh-suggest-ghost-overlay[data-shown="1"]:not([style*="display: none"])) textarea::placeholder{visibility:hidden!important}',
      // 兜底：编辑器自带 data-placeholder 属性的伪元素（部分宿主形态）以及
      // 依赖 `[data-placeholder]` 出文案的 ::before/::after 实现。
      'body:has(#dsh-suggest-ghost-overlay[data-shown="1"]:not([style*="display: none"])) [data-composer-input][data-placeholder]::before{content:none!important}',
      'body:has(#dsh-suggest-ghost-overlay[data-shown="1"]:not([style*="display: none"])) [data-composer-input][data-placeholder]::after{content:none!important}',
      // ── 折行断点：允许在灰字**第一个字之前**断行 ──
      //
      // overlay 现在是整行全宽、用 `text-indent` 让首行从草稿行尾起笔（见
      // overlay-geometry.ts）。可 CSS 有一条硬规则：一行至少要放下一个字符——
      // 行尾离内容右缘不足一个字宽时，首字会**溢出**右缘，而编辑器在同样位置会把它
      // 折到下一行（那里存在断点，因为前面已经有字）。零宽空格补上同一个断点：
      // 放得下时零宽、紧贴在首字前不着痕迹，放不下时在此断行、续行落到内容原点，
      // 与「采纳之后正文长什么样」逐行一致。
      //
      // ⚠️ 用 generated content 而不是往 textContent 里塞字符：采纳闸读的是节点上
      // 那句话（`paintedText`），多一个看不见的字符就会让「屏幕文本 ≠ 待写入文本」，
      // 那是 #166 判定链的输入，不能动。
      '#dsh-suggest-ghost-overlay::before{content:"\\200b"}'
    ].join("\n");
    if (typeof document !== "undefined") document.head.appendChild(this.styleTag);
  }
  /** 当前绑定的输入框（未绑定时为 null）。 */
  get currentTextarea() {
    return this.composer;
  }
  /**
   * 把 overlay 节点挂到当前 composer 的父节点（`.grow`）里。
   *
   * ## 为什么需要这一层（#152）
   *
   * 节点与「绑定」是两件事，旧实现把它们绑死在同一处：`el` 只在 `attach()`
   * 里 append。于是只要节点被别人摘走（宿主重建 `.grow` 的子节点、HMR 热替换、
   * 别的插件动了那棵子树），而 composer 引用没变，就再没有任何路径会把节点放回去。
   *
   * 本方法只负责「节点在场」，**不碰**显示状态：`display` / `data-shown` 仍由
   * 显示路径独占（见 `alignAndVerify` 的两条顺序约束）。因此调用它不会让 placeholder
   * 让位——让位规则要求 `data-shown="1"` **且** overlay 未被 `display:none` 隐藏，
   * 两个条件都不由本方法改动。
   *
   * @returns 挂好之后节点是否真的在文档里。
   */
  ensureMounted() {
    const parent = this.composer?.parentElement ?? null;
    if (parent !== null && (this.el.parentElement !== parent || !this.el.isConnected)) {
      parent.appendChild(this.el);
    }
    return this.el.isConnected;
  }
  /**
   * 绑定到当前输入框（若变化则重建对齐）。
   *
   * 短路条件里**必须带 `this.el.isConnected`**：只看 composer 引用的话，引用没变
   * 而节点已被摘走时这里会直接 return，`appendChild` 永远不执行 ⇒ 节点再也回不来。
   * 这类「不入死」由 §自愈 保证：每一次需要用到节点的地方都先走 `ensureMounted()`。
   */
  attach(composer) {
    if (this.composer === composer && this.el.isConnected) return;
    this.detach();
    this.composer = composer;
    this.scroller = composer.closest("[data-input-scroll]");
    const parent = composer.parentElement;
    if (parent !== null) parent.appendChild(this.el);
    composer.addEventListener("scroll", this.onScroll, { passive: true });
    this.scroller?.addEventListener("scroll", this.onScroll, { passive: true });
    window.addEventListener("resize", this.onResize);
    if (typeof MutationObserver !== "undefined") {
      this.mutationObserver = new MutationObserver(this.onDomMutation);
      this.mutationObserver.observe(composer, { childList: true, subtree: true, characterData: true });
    }
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(this.onResize);
      this.resizeObserver.observe(composer);
      if (this.scroller !== null) this.resizeObserver.observe(this.scroller);
      if (parent !== null) this.resizeObserver.observe(parent);
    }
    this.anchorDirty = true;
    this.alignAndVerify();
  }
  /**
   * 复位绘制状态（hide / detach / 自检被拦都走这里）。
   *
   * 快路径的前提是「屏幕上已经有一枚自检通过的幽灵」，所以任何让 overlay 退出绘制的
   * 动作都必须把 `painted`/`shape` 一起摘掉，否则下一帧会在没画出来的节点上只改文本。
   */
  resetPaintState() {
    this.painted = false;
    this.shape = null;
    this.anchor = null;
    this.anchorDirty = true;
    this.lastPaintWasGrowth = false;
  }
  detach() {
    if (this.composer !== null) {
      this.composer.removeEventListener("scroll", this.onScroll);
      this.composer = null;
    }
    if (this.scroller !== null) {
      this.scroller.removeEventListener("scroll", this.onScroll);
      this.scroller = null;
    }
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.mutationObserver?.disconnect();
    this.mutationObserver = null;
    if (this.mutationFrame !== 0) {
      if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(this.mutationFrame);
      else clearTimeout(this.mutationFrame);
      this.mutationFrame = 0;
    }
    this.current = null;
    this.resetPaintState();
    this.el.dataset.shown = "0";
    this.el.style.display = "none";
    window.removeEventListener("resize", this.onResize);
    this.el.remove();
  }
  /**
   * 对齐 overlay 到输入框内容区（含 padding 起点）。
   *
   * ## 为什么**不做**滚动补偿（实测结论，勿回退）
   *
   * overlay 挂在 `.grow` 上，而 `.grow` 是滚动容器 `[data-input-scroll]` 的**子
   * 节点**——即 overlay 位于「被滚动的内容」坐标系里。滚动容器滚动时 `.grow`
   * 整体一起位移（实测 `scrollTop=120` 时 `.grow` 的 rect.top 同步上移 120），
   * 因此 overlay **自动跟随内容滚动，无需任何 scrollTop 项**。
   *
   * 实测反证（`.grow` 上的探针元素，`scrollTop=120`）：
   *  - `rect 差 - scrollTop` → 幽灵落在 `64`，正文在 `184`：**漂移 `-scrollTop`**；
   *  - `rect 差 + scrollTop` → 幽灵恒定不动，漂移 `+scrollTop`；
   *  - `offsetTop + paddingTop`（**本实现**）→ 与正文逐像素重合（5 个滚动位置全对）。
   *
   * 另注：rect 差在这里恒为 0（`.grow` 与编辑器一起移动、同点），用它会把真实的
   * 内容偏移丢掉；`offsetTop/offsetLeft` 相对 `offsetParent`，与滚动无关，才是
   * 「内容坐标系」里的正确坐标。
   */
  align() {
    const ta = this.composer;
    if (ta === null) return;
    const style = getComputedStyle(ta);
    const padLeft = parseFloat(style.paddingLeft) || 0;
    const padTop = parseFloat(style.paddingTop) || 0;
    const padRight = parseFloat(style.paddingRight) || 0;
    const borderLeft = parseFloat(style.borderLeftWidth) || 0;
    const borderTop = parseFloat(style.borderTopWidth) || 0;
    const originLeft = ta.offsetLeft + borderLeft + padLeft;
    const originTop = ta.offsetTop + borderTop + padTop;
    const fullWidth = ta.clientWidth - padLeft - padRight;
    const contentWidth = fullWidth > 0 ? fullWidth : ta.clientWidth;
    const taRect = ta.getBoundingClientRect();
    const originViewportX = taRect.left + borderLeft + padLeft;
    const originViewportY = taRect.top + borderTop + padTop;
    const end = this.current !== null && this.current.kind !== "llm" ? this.draftEndRect() : null;
    this.anchor = end === null ? null : { right: end.right, top: end.top };
    this.anchorDirty = false;
    const geometry = overlayGeometry({
      originLeft,
      originTop,
      contentWidth,
      originViewportX,
      originViewportY,
      caret: end === null ? null : { right: end.right, top: end.top, height: end.height },
      lineHeight: parseFloat(style.lineHeight)
    });
    this.el.style.left = `${geometry.left}px`;
    this.el.style.top = `${geometry.top}px`;
    this.el.style.width = `${geometry.width}px`;
    const TEXT_LAYOUT_PROPS = [
      "font-family",
      "font-size",
      "font-style",
      "font-variant",
      "font-weight",
      "font-stretch",
      "font-feature-settings",
      "font-kerning",
      "font-variant-ligatures",
      "font-variant-east-asian",
      "font-variant-caps",
      "font-variant-numeric",
      "font-variant-alternates",
      "font-variant-position",
      "font-size-adjust",
      "font-synthesis",
      "font-optical-sizing",
      "line-height",
      "letter-spacing",
      "word-spacing",
      "white-space",
      "overflow-wrap",
      "word-break",
      "tab-size",
      "text-indent",
      "direction",
      "writing-mode",
      "text-rendering",
      "text-size-adjust",
      "-webkit-text-size-adjust",
      "-webkit-font-smoothing",
      "-moz-osx-font-smoothing"
    ];
    for (const prop of TEXT_LAYOUT_PROPS) {
      this.el.style.setProperty(prop, style.getPropertyValue(prop));
    }
    this.el.style.textIndent = `${geometry.textIndent}px`;
    this.el.style.boxSizing = "border-box";
  }
  /**
   * 对齐后做几何自检：定位明显失真时宁可不显示，也绝不糊在正文上。
   *
   * ## 判据（依据实测，不是推测）
   *
   * overlay 是 `.grow` 的子节点，随内容一起滚动——所以「幽灵跑到滚动视口外」是
   * **正常且正确**的（正文也一起滚出去了，被滚动容器裁掉）。因此**不能**用
   * 「必须落在滚动视口内」当判据：实测 `scrollTop=384` 时幽灵与正文同在
   * `top=-80`，两者都被裁掉，这是正确的。
   *
   * 真正要防的是**定位失真**：overlay 没有落在编辑器内容原点上（例如宿主要
   * 在 `.grow` 与编辑器之间插入带 padding/border 的新层，或 `.grow` 不再是
   * offsetParent）。此时幽灵会浮在别的内容上——就是用户报告的重叠。
   *
   * 判据：幽灵左上角与「编辑器在 offsetParent 内的内容原点」之差必须在一个
   * 行高量级内。偏差超过一行，说明坐标系假设已被宿主破坏，放弃显示。
   */
  /**
   * 量出草稿**在屏幕上**的收尾位置（最后一行内容的右缘 + 行框顶 + 行框高）。
   *
   * ## 为什么不能量「最后一个文本节点的末字符」
   *
   * 旧口径是逐文本节点走、取最后一个非空文本节点的末字符矩形。它在纯文本草稿上
   * 成立，但只要草稿里出现**内联原子**就必然画错——DSH 的引用 chip / quote 都是
   * `contenteditable=false` 的 inline-flex 盒子，文字外面套着 `max-width` +
   * `overflow:hidden`（chip 240px、quote `min(80%,300px)`）：
   *
   *  - 文本节点的排版宽度是**未截断**的自然宽度 ⇒ 末字符矩形落在裁剪框**外面**；
   *  - 用户能看见的收尾却是裁剪框的右缘。
   *
   * 实测（真 Chromium + 0.11.2 产物，920px composer，chip 标签被 240px 截断）：
   * 可见收尾 `right=330.78`，文本节点末字符 `right=652.78` —— 差 **322px**。
   * 幽灵于是被画到草稿右侧几百像素的空地上（行末还有字时就直接压在那些字上），
   * 用户看到的就是「幽灵和引用文本之外的东西重叠」。
   *
   * ## 现在怎么量
   *
   * 量**最后一个块元素的最后一行**的 range 矩形：`range.selectNodeContents(block)`
   * 的 `getClientRects()` 逐行返回，取最后一条 ⇒ `right` 是这一行**渲染出来的**
   * 内容右缘（内联原子按它的盒子算，被截断时就是裁剪框），`top/height` 是行框。
   *
   * ⚠️ 不要退回 `range.selectNodeContents(editor)`：那会跨全部段落，多行时还要自己
   * 找最后一行（本仓库在这上面踩过两次）。这里只对**最后一个块**取 range。
   */
  draftEndRect() {
    const ta = this.composer;
    if (ta === null) return null;
    const block = lastElementChildOf(ta);
    if (block !== null) {
      const tail = block.lastChild;
      if (tail !== null) {
        const rect2 = tailRectOf(tail);
        if (rect2 !== null) return rect2;
      }
      const line = lastLineRectOf(block);
      if (line !== null) return line;
    }
    const walker = document.createTreeWalker(ta, NodeFilter.SHOW_TEXT);
    let last = null;
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const text = node;
      if (text.nodeValue && text.nodeValue.length > 0) last = text;
    }
    if (last === null) return null;
    const end = last.nodeValue.length;
    const range = document.createRange();
    range.setStart(last, Math.max(0, end - 1));
    range.setEnd(last, end);
    const rect = range.getBoundingClientRect();
    return rect.width > 0 || rect.height > 0 ? { right: rect.right, top: rect.top, height: rect.height } : null;
  }
  /**
   * overlay 里**第一个可见字**的矩形（视口坐标）。
   *
   * 为什么不用 `el.getBoundingClientRect()`：盒子左缘现在是内容原点（整行全宽），
   * 它已经不再等于「灰字起笔的位置」——起笔位置由 `text-indent` 决定。自检要证明的是
   * 「灰字接在草稿行尾」，只能量文字本身（量盒子等于量一个与判据无关的量）。
   *
   * 与 {@link draftEndRect} 同一口径：逐文本节点走，取第一个非空节点的**首字符**。
   */
  firstGlyphRect() {
    const walker = document.createTreeWalker(this.el, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const text = node;
      const value = text.nodeValue;
      if (value === null || value.length === 0) continue;
      const range = document.createRange();
      range.setStart(text, 0);
      range.setEnd(text, 1);
      const rect = range.getBoundingClientRect();
      return rect.width > 0 || rect.height > 0 ? rect : null;
    }
    return null;
  }
  /** 记录一次自检失败的原因（留在 `data-reject` 上供现场取证）并判为不显示。 */
  rejectAs(reason) {
    this.el.dataset.reject = reason;
    return false;
  }
  /**
   * 几何自检：定位明显失真时宁可不显示，也绝不糊在正文上。
   *
   * ## 两种形态判据不同（历史补全已改为锚定，不再检查原点）
   *
   *  - **历史补全**：幽灵的左上角必须正好落在 DOM 量出的草稿行尾（±4px）。
   *    另外要求 caret 本身落在编辑器自己的盒子里——这是为了拦住「量到游离/陈旧
   *    节点」的情形：游离节点的矩形是**全 0**，若不拦，锚点会被算到屏幕左上角。
   *  - **LLM 建议**（草稿为空、整段从内容原点起）：仍按原点判据，并额外确认
   *    占位文字**确实已让位**——否则幽灵就是叠在占位文案上（用户第一张截图）。
   *
   * 失败原因写进 `data-reject`：把「偶发重叠」变成「偶发没幽灵 + 一条可读证据」。
   */
  verify() {
    const ta = this.composer;
    if (ta === null) return false;
    const host = this.el.offsetParent;
    if (!(host instanceof HTMLElement)) return false;
    const ghostRect = this.el.getBoundingClientRect();
    const taRect = ta.getBoundingClientRect();
    const style = getComputedStyle(ta);
    const padLeft = parseFloat(style.paddingLeft) || 0;
    const padTop = parseFloat(style.paddingTop) || 0;
    const borderLeft = parseFloat(style.borderLeftWidth) || 0;
    const borderTop = parseFloat(style.borderTopWidth) || 0;
    const lineHeight = parseFloat(style.lineHeight);
    const tolerance = Number.isFinite(lineHeight) && lineHeight > 0 ? lineHeight : 24;
    if (this.current !== null && this.current.kind !== "llm") {
      const end = this.draftEndRect();
      if (end === null) return this.rejectAs("no-caret");
      if (end.right < taRect.left || end.right > taRect.right + 1 || end.top < taRect.top - 1 || end.top > taRect.bottom + 1) {
        return this.rejectAs("caret-outside-editor");
      }
      const originX = taRect.left + borderLeft + padLeft;
      const dxOrigin = Math.round(ghostRect.left - originX);
      if (Math.abs(dxOrigin) > 4) return this.rejectAs(`origin-drift-x dx=${dxOrigin}`);
      const first = this.firstGlyphRect();
      if (first === null) return this.rejectAs("no-anchor-glyph");
      const dx = Math.round(first.left - end.right);
      const sameLine = Math.abs(dx) <= 4 && Math.abs(Math.round(first.top - end.top)) <= 4;
      const wrappedToNextLine = Number.isFinite(lineHeight) && lineHeight > 0 && Math.abs(Math.round(first.left - originX)) <= 4 && Math.abs(Math.round(first.top - (end.top + lineHeight))) <= 4;
      if (!sameLine && !wrappedToNextLine) {
        return this.rejectAs(`anchor-drift dx=${dx} dy=${Math.round(first.top - end.top)}`);
      }
      const lineOff = Number.isFinite(lineHeight) && lineHeight > 0 && end.height > 0 ? Math.max(0, (lineHeight - end.height) / 2) : 0;
      const dy = Math.round(ghostRect.top - end.top);
      if (dy > 4 || dy < -(lineOff + 4)) {
        return this.rejectAs(`box-drift dy=${dy}`);
      }
    } else {
      if (Math.abs(ghostRect.top - (taRect.top + borderTop + padTop)) > tolerance) return this.rejectAs("origin-drift-y");
      if (Math.abs(ghostRect.left - (taRect.left + borderLeft + padLeft)) > tolerance) return this.rejectAs("origin-drift-x");
      const placeholder = document.querySelector("[data-composer-placeholder]");
      if (placeholder !== null && getComputedStyle(placeholder).display !== "none") {
        return this.rejectAs("placeholder-visible");
      }
    }
    if (!(host.contains(ta) || host === ta.parentElement)) return this.rejectAs("host-mismatch");
    delete this.el.dataset.reject;
    return true;
  }
  /**
   * 对齐 + 自检；自检失败则隐藏（保持 current 以便下次事件重试）。
   *
   * ## 两条顺序约束（都踩过坑，勿调换）
   *
   * 1. **必须先 `display:block` 再测量**：`getBoundingClientRect()` 对
   *    `display:none` 的元素恒返回全 0，先测量会把每次首帧都判为「空矩形 →
   *    不可显示」，`display` 永远停在 `none`——表现为幽灵彻底不出现。
   *
   * 2. **必须在显示之前就 `data-shown="1"`**：placeholder 的隐藏规则
   *    （`body:has(#…[data-shown="1"]) [data-composer-placeholder]{display:none}`）
   *    挂在 `data-shown` 上。若先 `display:block` 再标 `data-shown`，中间就存在
   *    一个「幽灵已可见、placeholder 还没隐藏」的窗口——两者同原点，直接重叠
   *    （实测：该窗口内 placeholder 的 computed display 仍是 block）。
   *
   * 注意两者是**不同元素上的两个开关**，互不冲突：
   *  - `data-shown` 打在 overlay 自身（控制 placeholder 是否让位）；
   *  - `display` 打在 overlay 自身（控制幽灵是否绘制）。
   * 因此正确顺序是：**先标 `data-shown` 让位 → 再 `display:block` → 测量自检
   * → 不合格则把两者一起回退**。
   */
  alignAndVerify() {
    if (this.current === null) return;
    this.align();
    this.el.dataset.shown = "1";
    this.el.style.display = "block";
    if (!this.verify()) {
      this.painted = false;
      this.el.style.display = "none";
      this.el.dataset.shown = "0";
      return;
    }
    this.painted = true;
  }
  /**
   * 显示幽灵内容（对齐由滚动/尺寸事件持续维护）；隐藏 placeholder 避免重叠。
   *
   * ## 两条路径（#38 第 2 条）
   *
   *  - **全量**（现状）：`textContent=''` 重建后缀 span → `align()` → `verify()`，
   *    两轮强制同步布局。形态变化、首次显示、自检被拦后的重试都走它。
   *  - **增长快路径**：同一次生成的文本变长（形态与锚定文本都没变、新后缀以旧后缀
   *    开头）**只改后缀 span 的文本**：
   *     - 锚点未脏（其间没有滚动/尺寸/重挂载事件）→ 一次测量都不做；
   *     - 锚点脏了 → 只量一次行尾，位移不超过 {@link ANCHOR_REDRAW_TOLERANCE_PX}
   *       就不重排，超了才落回全量。
   *    快路径**不碰** `display` / `data-shown`：进入它的前提是两者已一致且自检刚通过，
   *    因此上面那两条顺序约束与「verify 失败即不绘制」都原样保持。
   *
   * @param content - 本帧要显示的幽灵内容。
   */
  show(content) {
    if (content.kind === "llm" && content.pending) {
      this.el.dataset.regenPending = "1";
    } else {
      delete this.el.dataset.regenPending;
    }
    const next = overlayShapeOf(content);
    const action = decideOverlayPaint({
      prev: this.shape,
      next,
      painted: this.painted,
      anchorDirty: this.anchorDirty
    });
    if (action !== "rebuild" && this.applyGrowthText(content, next)) {
      this.current = content;
      this.shape = next;
      this.lastPaintWasGrowth = true;
      if (action === "grow-only") {
        this.paintStats.growth += 1;
        return;
      }
      this.paintStats.remeasure += 1;
      const rect = this.draftEndRect();
      const point = rect === null ? null : { right: rect.right, top: rect.top };
      if (point !== null && !anchorMovedBeyond(this.anchor, point)) {
        this.anchor = point;
        this.anchorDirty = false;
        return;
      }
    }
    this.rebuild(content, next);
  }
  /** 全量重建 + 对齐 + 自检（现状路径）。 */
  rebuild(content, next) {
    this.el.textContent = "";
    this.buildText(content);
    this.current = content;
    this.shape = next;
    this.lastPaintWasGrowth = false;
    this.paintStats.rebuild += 1;
    this.alignAndVerify();
  }
  /** 全量建文本节点：llm 整段文本；其余只渲染后缀（锚定由 align() 负责）。 */
  buildText(content) {
    if (content.kind === "llm") {
      this.el.textContent = content.text;
      return;
    }
    const suffix = document.createElement("span");
    suffix.textContent = content.suffix;
    this.el.append(suffix);
  }
  /**
   * 增长帧的文本写入：后缀 span **只改文本**，不重建节点。
   *
   * @returns false = 结构对不上（节点被外来者摘走 / 形态与节点形状不符），调用方落回全量。
   */
  applyGrowthText(content, next) {
    if (content.kind === "llm") {
      this.el.textContent = next.suffixText;
      return true;
    }
    const holder = this.el.firstElementChild;
    if (holder === null || holder.textContent === void 0) return false;
    holder.textContent = next.suffixText;
    return true;
  }
  /**
   * 浮层**此刻真的画在屏幕上**的那段文本（#166 方案 B1 的判据输入）。
   *
   * ⚠️ 这不是 `this.current` 的投影，而是**从节点上读回来**的：`current` 是内部状态，
   * 采纳闸若拿它比 `accepted`，那两值都由同一份 content 推导，必然相等 —— 判据就成了
   * 同义反复（实测：把屏幕上那句改掉之后 `current.text` 仍是槽里那条，闸放行、
   * 草稿照样被整段覆盖）。读回来只碰本插件自己的节点，不是宿主 DOM 遍历。
   *
   * 口径与 {@link buildText} / {@link applyGrowthText} 的写入口一致：
   *  - `llm`：整段文本写在节点自身的 `textContent` 上；
   *  - `history` / `inline`：只把**后缀**装进第一枚子节点。
   */
  get paintedText() {
    if (this.current !== null && this.current.kind === "llm") return this.el.textContent ?? "";
    const holder = this.el.firstElementChild;
    return holder === null ? "" : holder.textContent ?? "";
  }
  /** 屏幕上是否正有一枚「靠增长快路径维持」的幽灵（错峰补渲染据此让路）。 */
  get growing() {
    return this.painted && this.lastPaintWasGrowth;
  }
  /** 是否已绘制（自检通过）。 */
  get isPainted() {
    return this.painted;
  }
  /** 绘制计数（只有数字；留痕用，见 `renderTraced` 的 tally 出口）。 */
  get paints() {
    return this.paintStats;
  }
  hide() {
    this.current = null;
    this.resetPaintState();
    this.el.style.display = "none";
    this.el.textContent = "";
    this.el.dataset.shown = "0";
    delete this.el.dataset.reject;
  }
  /**
   * 按「设置 + 在途位」同步生成中指示。
   *
   * 三条设计约束：
   *  1. **状态打在插件自己的节点上**（`data-caret-glow` / `data-box-glow`），宿主侧
   *     一律经 `body:has()` 命中。这是既有 `data-shown` 让位 placeholder 的同款做法：
   *     React/Lexical 重渲染会剥掉编辑器上的外来类与内联样式，而 overlay 是我们的
   *     私有节点，不受影响。
   *  2. **只增删属性，不重绘**：两个属性各自独立，改一个不碰另一个（用户要求两个
   *     选项互不影响）。样式表内容变化只在**真的变了**时重建，避免每帧重插。
   *  3. **彻底关闭时移除整个标签**：两个开关都关就让它从 DOM 里消失，不留下一条
   *     永不命中的空规则（那不是"省字节"，是让排查时看到的 DOM 与真实状态一致）。
   *
   * @param style - 两个开关的当前值。
   * @param pending - 当前会话是否有续写在途。
   */
  syncPendingStyle(style, pending) {
    if (typeof document === "undefined") return;
    const caret = style.caretGlow === true;
    const box = style.boxGlow === true;
    const live = pending === true;
    if ((caret || box) && live) this.ensureMounted();
    if (caret && live) this.el.dataset.caretGlow = "1";
    else delete this.el.dataset.caretGlow;
    if (box && live) this.el.dataset.boxGlow = "1";
    else delete this.el.dataset.boxGlow;
    const css = [
      caret ? CARET_GLOW_RULE : "",
      box ? BOX_GLOW_RULE : ""
    ].filter((part) => part !== "").join("\n");
    if (css === "") {
      this.pendingStyle?.remove();
      this.pendingStyle = null;
      return;
    }
    if (this.pendingStyle === null) {
      const tag = document.createElement("style");
      tag.dataset.pluginCss = PENDING_STYLE_ID;
      this.pendingStyle = tag;
      document.head.appendChild(tag);
    }
    if (this.pendingStyle.textContent !== css) this.pendingStyle.textContent = css;
  }
  dispose() {
    this.detach();
    this.styleTag.remove();
    this.pendingStyle?.remove();
    this.pendingStyle = null;
  }
};
var remoteOf = (ctx) => ctx.get("remote");
var sectionLabel = (locale) => SECTION_LABELS[resolveGhostLang(locale?.getSnapshot().active)];
function applyInner(ctx) {
  applyBody(ctx);
}
function applyBody(ctx) {
  const sessions = ctx.get("sessions");
  if (sessions === void 0) return;
  const overlay = new GhostOverlay();
  let keyHintValue = null;
  const keyHintSubs = /* @__PURE__ */ new Set();
  const sameHintSegments = (a, b) => a.length === b.length && a.every((seg, i) => seg.action === b[i].action && seg.keycap === b[i].keycap);
  const setKeyHint = (next) => {
    const same = keyHintValue === null && next === null || keyHintValue !== null && next !== null && keyHintValue.kind === next.kind && keyHintValue.lang === next.lang && sameHintSegments(keyHintValue.segments, next.segments);
    if (same) return;
    keyHintValue = next;
    for (const fn of [...keyHintSubs]) {
      try {
        fn();
      } catch {
      }
    }
  };
  const keyHintNow = () => keyHintValue;
  let failureNote = null;
  const failureSubs = /* @__PURE__ */ new Set();
  const notifyFailure = () => {
    for (const fn of [...failureSubs]) {
      try {
        fn();
      } catch {
      }
    }
  };
  const noteSuggestionFailure = (reason) => {
    if (failureNote?.reason === reason) return;
    failureNote = { reason };
    notifyFailure();
  };
  const clearSuggestionFailure = () => {
    if (failureNote === null) return;
    failureNote = null;
    notifyFailure();
  };
  const failureNow = () => failureNote;
  const subscribeFailure = (fn) => {
    failureSubs.add(fn);
    return () => {
      failureSubs.delete(fn);
    };
  };
  const activeLang = () => resolveGhostLang(ctx.get("locale")?.getSnapshot().active);
  let lastSessionId;
  const CACHE_KEY = "dsh-suggest-ghost:cache";
  const loadFromCache = () => {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (raw === null) return {};
      return JSON.parse(raw);
    } catch {
      return {};
    }
  };
  const saveToCache = (data) => {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(data));
    } catch {
    }
  };
  const cached = loadFromCache();
  let bound = null;
  let shown = null;
  let lastCompletionSkip = "";
  let frameLedger = emptyFrameLedger();
  const traceGates = {
    "inline-arm-cancel": null,
    "tab-abandon": null,
    "word-abandon": null,
    "accept-gate-tab": null,
    "accept-gate-word": null,
    "stale-frame": null,
    "form-hold": null,
    // #129：LLM 形态的进入判据把这一支拦掉了（草稿里有用户已输入的字符）。
    // 常态槽（`ROUTINE_TRACE_SLOTS`，debug 级）：它每帧都可能成立，不是故障。
    "llm-form-guard": null,
    // #127：换一条的两条客户端留痕。`regen-skipped` 是常态（在历史补全/续写上按 regen 键
    // 不会有任何动作，而那是设计如此），`regen-requested` 只是发出确认。
    // 两者都进常态槽（debug 级）：它们每帧都可能成立，不是故障（#97 那条反向教训：
    // 只有真正的失败才该走 warn）。
    "regen-skipped": null,
    "regen-requested": null,
    "deferred-repaint": null,
    "push-cell": null,
    // #165：宿主推来的生成失败摘要（`_push.error`）**首次出现 / 理由变化**时打一行。
    // 进故障槽（warn，默认可见）：它正是过去「整类静默全灭」时唯一该有的线索。
    // 同一理由连打由 `traceOnce` 的理由闸挡住，所以一次风暴不刷屏。
    "suggestion-failed": null
  };
  const traceSlotGates = {};
  const ROUTINE_TRACE_SLOTS = /* @__PURE__ */ new Set([
    "push-cell",
    "inline-arm-cancel",
    "deferred-repaint",
    // #127：换一条的两条（同上，常态证据走 debug）。
    "llm-form-guard",
    "regen-skipped",
    "regen-requested",
    // #129：「非空草稿 ⇒ llm 形态不可达」在用户打字的整段时间里**每帧都成立**，
    // 属常态证据（判据把形态拦掉了），不是故障。留痕只在理由变化时打一行，
    // 通道走 debug（默认隐藏，Verbose 可见）——与 `tab-abandon` 那类失败告警相反。
    "llm-form-guard"
  ]);
  const traceOnce = (slot, reason, fields) => {
    const step = stepReasonGate(traceGates[slot] ?? null, reason);
    traceGates[slot] = step.last;
    const out = stepSlotEmit(traceSlotGates[slot] ?? initialSlotEmitGate(), Date.now(), step.print, reason, fields);
    traceSlotGates[slot] = out.gate;
    if (out.emit === null) return;
    const line = `${OPS_TRACE_PREFIX} ${slot}: reason=${out.emit.reason}${out.emit.fields === "" ? "" : ` ${out.emit.fields}`}`;
    if (ROUTINE_TRACE_SLOTS.has(slot)) console.debug(line);
    else console.warn(line);
  };
  const traceClear = (slot, reason) => {
    traceGates[slot] = stepReasonGate(traceGates[slot] ?? null, reason).last;
    traceSlotGates[slot] = initialSlotEmitGate();
  };
  let composing = false;
  let settings = {
    historyEnabled: true,
    historyCrossSession: false,
    historyMaxEntries: 50,
    historyMinChars: 1,
    inlineEnabled: true,
    streamingDelivery: false,
    inlineDelayMs: 100,
    inlineMinChars: 4,
    wordAccept: true,
    // 键位三兄弟的初值：与 `src/index.ts` 的 `.default()`、`generate.ts` 的两处
    // `readVolatile` 逐字同值（集合比对钉在 `scripts/keybinding-registration-smoke.mjs`）。
    // 这一处最特殊：它是**旧宿主**（没有这三个配置键 / describe 读不到）时的兜底，
    // 写错就等于在旧内核上凭空改变键位。
    wordAcceptKey: "Right",
    localAcceptKey: "Tab",
    dismissKey: "Escape",
    // 忽略键（本单）。与上面三键同款：初值与 `accept-key.ts` 的 `DEFAULT_FORGET_KEY`
    // 逐字同值（集合比对钉在 `scripts/keybinding-registration-smoke.mjs` 的 ⑥）。
    forgetKey: "Alt+X",
    // #157：幽灵显示时浮一行键位提示（默认开）。
    showKeyHint: false,
    regenEnabled: true,
    regenKey: "Alt+G",
    regenPending: false,
    completionPending: false,
    // 缺省与宿主 schema 逐字同值（2026-11-09 起两项都默认关，实验性）：旧宿主、
    // 载荷缺失、冷启动三种情况下客户端都按这套走，与宿主侧行为一致。
    caretGlowEnabled: false,
    boxGlowEnabled: false,
    suggestion: cached.suggestion ?? null,
    // 缓存里的建议可能来自上一进程；帧提示一起持久化，避免把 provisional 帧的
    // 建议冷启动后当成终帧采纳（读不到时按旧载荷兜底）。
    suggestionFrame: cached.suggestionFrame ?? LEGACY_FRAME_HINT,
    completion: null,
    completionFrame: LEGACY_FRAME_HINT,
    completionSessionId: null,
    hot: cached.hot ?? null,
    // 忽略表不冷启动缓存：它是用户数据、下一次 pull 就带回来；先按空表起步不会
    // 造成任何错误行为（空表 = 不过滤，与「没忽略过」同形），而缓存它要新增一份
    // 冷启动载荷字段，属于另一件事。
    ignored: [],
    history: cached.history ?? [],
    historySessionId: cached.historySessionId ?? null,
    suggestionSessionId: cached.suggestionSessionId ?? null
  };
  let documentRevisionSeen = -1;
  let settingsEpoch = 0;
  const bindingTableOfContent = (content) => bindingTableFor({
    kind: content.kind,
    acceptKey: content.kind === "llm" ? content.acceptKey : void 0,
    localAcceptKey: settings.localAcceptKey,
    wordAcceptKey: settings.wordAcceptKey,
    regenKey: settings.regenKey,
    dismissKey: settings.dismissKey,
    // 忽略键（本单）：与 dismissKey 同款，空串 = 不接管。
    forgetKey: settings.forgetKey,
    wordAccept: settings.wordAccept,
    regenEnabled: settings.regenEnabled
  });
  let hotCountsCache = null;
  let ignoredCache = null;
  let ghostContentCache = null;
  const resolve = (currentId) => {
    const id = currentId;
    if (id === void 0) {
      bound = null;
      lastSessionId = void 0;
      return;
    }
    if (id === lastSessionId && bound !== null) return;
    const actx = sessions.scope(id);
    if (actx === void 0) return;
    const session = sessions.sessionOf(actx);
    if (session === void 0) return;
    const conversation = actx.get("conversation");
    if (conversation === void 0) return;
    const input = conversation.input.for(actx);
    if (input === void 0) return;
    lastSessionId = id;
    bound = {
      session,
      input,
      projectionFace: session.projections.faceOf(PROJECTION_KEY)
    };
    resubscribeBound?.();
    pullHistory(id);
  };
  const ghostContent = (currentId) => {
    if (!settings.historyEnabled && settings.suggestion === null && (!settings.inlineEnabled || settings.completion === null)) return { content: null, key: null, base: null };
    if (bound === null) return { content: null, key: null, base: null };
    if (composing) return { content: null, key: null, base: null };
    const snapshot = bound.session.getSnapshot();
    const base = readDraftSnapshot(bound.input.state.getSnapshot());
    const draft = base.draft;
    if (ghostContentCache !== null && ghostContentCache.draft === draft && ghostContentCache.settingsEpoch === settingsEpoch && ghostContentCache.composing === composing && ghostContentCache.running === snapshot.running && ghostContentCache.currentId === currentId) {
      return { content: ghostContentCache.result, key: ghostContentCache.key, base };
    }
    const result = computeGhostContent(draft, snapshot, currentId);
    let key = null;
    if (result !== null) {
      key = result.kind === "llm" ? `llm:${result.pending ? "pending:" : ""}${result.text}` : `${result.kind}:${result.prefix}|${result.suffix}`;
    }
    ghostContentCache = { draft, settingsEpoch, composing: false, running: snapshot.running, currentId, result, key };
    return { content: result, key, base };
  };
  const computeGhostContent = (draft, snapshot, currentId) => {
    if (hasUserDraft(draft) && settings.inlineEnabled) {
      const completion = settings.completion;
      const aligned = completion === null || completion === void 0 || settings.completionSessionId === null || settings.completionSessionId !== currentId ? null : alignCompletion(draft, completion.draft, completion.text);
      const skipReason = completion === null || completion === void 0 ? "none" : settings.completionSessionId !== currentId ? "other-session" : aligned !== null && !aligned.ok ? aligned.reason : null;
      if (skipReason !== null) {
        if (skipReason !== lastCompletionSkip) {
          lastCompletionSkip = skipReason;
          const sink = console.warn;
          sink(
            `[dsh-suggest-ghost][ops-trace] completion not shown: reason=${skipReason} draftChars=${draft.length} payloadDraftChars=${completion?.draft?.length ?? -1} completionChars=${completion?.text?.length ?? -1} draftIsOldPrefix=${String(completion !== null && completion !== void 0 && completion.draft.startsWith(draft))} payloadSessionMatches=${String(settings.completionSessionId === currentId)}`
          );
        }
      } else {
        lastCompletionSkip = "";
      }
      if (aligned !== null && aligned.ok) {
        return { kind: "inline", prefix: draft, suffix: aligned.suffix, full: aligned.full, frame: settings.completionFrame };
      }
      const form = decideCompletionReuse({
        inlineEnabled: settings.inlineEnabled,
        draft,
        payload: completion,
        payloadBelongsToCurrentSession: settings.completionSessionId !== null && settings.completionSessionId === currentId,
        aligned
      });
      if (form.holdHistory) {
        traceOnce(
          "form-hold",
          "inline-consumed",
          ` draftChars=${draft.length} payloadDraftChars=${completion?.draft?.length ?? -1} completionChars=${completion?.text?.length ?? -1} wouldBe=history ${frameHintFields(settings.completionFrame)}`
        );
        return null;
      }
      traceClear("form-hold", null);
    }
    if (settings.historyEnabled && hasUserDraft(draft)) {
      traceClear("form-hold", null);
      const contentDraft = stripCommandPrefix(draft);
      if (contentDraft.trim() === "") return null;
      const history = settings.historySessionId !== null && settings.historySessionId === currentId ? settings.history : [];
      const hot = settings.hot;
      if (hotCountsCache === null || hotCountsCache.src !== hot) {
        const map = hot !== null && hot.length > 0 ? new Map(hot.map((h) => [normalizeForMatch(h.text), h.count])) : void 0;
        hotCountsCache = { src: hot, map };
      }
      const hotCounts = hotCountsCache.map;
      const ignored = settings.ignored;
      if (ignoredCache === null || ignoredCache.src !== ignored) {
        ignoredCache = { src: ignored, set: new Set(ignored.map((e) => e.norm)) };
      }
      const ignoredSet = ignoredCache.set;
      const full = historySuggestion(history, contentDraft, {
        minChars: settings.historyMinChars,
        maxEntries: settings.historyMaxEntries,
        hotCounts,
        ignored: ignoredSet,
        extraCandidates: settings.historyCrossSession ? hot ?? void 0 : void 0
      });
      if (full === void 0) return null;
      const common = commonPrefixLength(contentDraft, full);
      return { kind: "history", prefix: draft, suffix: full.slice(common), full, frame: LEGACY_FRAME_HINT };
    }
    const llmForm = decideLlmForm({ draft, historyEnabled: settings.historyEnabled });
    if (!llmForm.allow) {
      traceOnce(
        "llm-form-guard",
        llmForm.reason,
        ` draftChars=${draft.length} historyEnabled=${String(settings.historyEnabled)}`
      );
      return null;
    }
    traceClear("llm-form-guard", null);
    const streamed = streamFrameFor(currentId);
    if (streamed !== null) {
      pushCellStats.llmGhostOffered += 1;
      return {
        kind: "llm",
        text: streamed.text,
        acceptKey: settings.suggestion?.acceptKey ?? DEFAULT_ACCEPT_KEY,
        frame: { frame: streamed.frame, final: streamed.final },
        // 流式帧本身就是"正在增长"，与「换一条在途」是两件事：它有自己的帧号，
        // 所以这里恒为 false（在途位只由 `_push.regenPending` 驱动）。
        pending: false
      };
    }
    const suggestion = settings.suggestion;
    if (suggestion === null || suggestion === void 0) return null;
    const ownerMismatch = settings.suggestionSessionId !== null && settings.suggestionSessionId !== currentId;
    const stale = snapshot.running || ownerMismatch;
    if (stale) {
      if (!snapshot.running && ownerMismatch) pushCellStats.ownerHidden += 1;
      return null;
    }
    pushCellStats.llmGhostOffered += 1;
    return {
      kind: "llm",
      text: suggestion.text,
      acceptKey: suggestion.acceptKey,
      frame: settings.suggestionFrame,
      // #127：宿主在途 ⇒ 这条是旧的。**不在途时不带这个位**，让 key 与既有缓存逐字不变。
      pending: settings.regenPending
    };
  };
  let cachedComposer = null;
  let validatedComposer = null;
  const pendingStyleOf = (s) => ({
    caretGlow: typeof s.caretGlowEnabled === "boolean" ? s.caretGlowEnabled : DEFAULT_PENDING_STYLE.caretGlow,
    boxGlow: typeof s.boxGlowEnabled === "boolean" ? s.boxGlowEnabled : DEFAULT_PENDING_STYLE.boxGlow
  });
  let localPending = null;
  let pendingFloorTimer = null;
  const settleLocalPending = () => {
    if (localPending === null) return;
    localPending = null;
    if (pendingFloorTimer !== null) {
      clearTimeout(pendingFloorTimer);
      pendingFloorTimer = null;
    }
    render();
  };
  const lightLocalPending = (sessionId, draft) => {
    localPending = startPending(sessionId, draft, Date.now());
    if (pendingFloorTimer !== null) {
      clearTimeout(pendingFloorTimer);
      pendingFloorTimer = null;
    }
    pendingFloorTimer = setTimeout(() => {
      pendingFloorTimer = null;
      render();
    }, PENDING_DEADLINE_MS + 50);
    render();
  };
  const pendingLitNow = (currentId, draft) => {
    const tick = tickPending(localPending, {
      now: Date.now(),
      sessionId: currentId ?? null,
      draft,
      minVisibleMs: PENDING_MIN_VISIBLE_MS,
      deadlineMs: PENDING_DEADLINE_MS
    });
    if (localPending !== null && !tick.lit) {
      localPending = null;
    }
    if (localPending !== null) return true;
    return settings.completionPending === true;
  };
  const render = () => {
    const currentId = currentSessionIdOf(sessions.list.getSnapshot());
    resolve(currentId);
    const attachedNow = overlay.currentTextarea;
    const composerNow = attachedNow !== null && attachedNow.isConnected ? attachedNow : cachedComposer !== null && cachedComposer.isConnected ? cachedComposer : document.querySelector(COMPOSER_SELECTOR);
    if (composerNow !== null) {
      if (composerNow === validatedComposer || isComposerElement(composerNow)) {
        validatedComposer = composerNow;
        cachedComposer = composerNow;
        overlay.attach(composerNow);
        overlay.ensureMounted();
      }
    }
    overlay.syncPendingStyle(
      pendingStyleOf(settings),
      pendingLitNow(currentId, bound === null ? "" : readDraftSnapshot(bound.input.state.getSnapshot()).draft)
    );
    const { content, key, base } = ghostContent(currentId);
    scheduleInlineTrigger(currentId, content === null ? null : content.kind);
    retryPendingPull();
    if (content === null || base === null) {
      if (shown !== null) {
        overlay.hide();
        shown = null;
      }
      return;
    }
    if (key === null) return;
    if (shown !== null && shown.key === key) return;
    if (composerNow === null) return;
    if (composerNow !== validatedComposer) {
      if (shown !== null) {
        overlay.hide();
        shown = null;
      }
      return;
    }
    setKeyHint(null);
    overlay.attach(composerNow);
    overlay.show(content);
    if (overlay.isPainted && settings.showKeyHint) {
      setKeyHint({
        kind: content.kind,
        segments: hintSegments(bindingTableOfContent(content)),
        lang: activeLang()
      });
    } else {
      setKeyHint(null);
    }
    shown = { key, content, base };
  };
  const locale = ctx.get("locale");
  const opsSeq = createSeqSource();
  const writeOpsNow = (payload) => {
    const svc = remoteOf(ctx)?.settings;
    if (svc === void 0) return Promise.resolve(false);
    const enriched = buildOpsPayload(payload, locale?.getSnapshot?.()?.active, opsSeq.next());
    const doWrite = (attempt) => svc.describe().then(
      (described) => {
        const list = unwrapSettingsDoc(described)?.namespaces ?? [];
        const row = list.find((r) => r.ns === SETTINGS_NAMESPACE);
        const rev = typeof row?.revision === "number" ? row.revision : 0;
        return svc.mutate(SETTINGS_NAMESPACE, [{ op: "set", path: ["_ops"], value: enriched }], rev).then(
          // 兑现 ≠ 落盘：远程面把冲突折成 `{ok:false,error}` 后照样兑现
          // （见 unwrapMutateResult 的源码取证）。
          (mutated) => settleWrite(mutated, rev, enriched, attempt),
          // reject 只可能是装配故障（参数元数 / 方法未挂载 / 缺 Context 适配器）。
          (error) => {
            const rejection = readRejection(error);
            if (opsConflictRetryAllowed(attempt) && isConflictRefusal(rejection.code, rejection.message)) {
              return retryAfterOpsConflict(attempt);
            }
            console.warn(`[suggest-ghost] _ops write rejected by client api: code=${String(rejection.code)}, message=${String(rejection.message)}`);
            return false;
          }
        );
      },
      // describe 自己失败（后端未就绪 / 连接断开）：**必须就地收住**。调用点是
      // `void writeOps(...)`，让它 reject 出去就成了 unhandled rejection；改结构前
      // 这一支由外层 onRejected 兜着，重构时很容易漏。
      (error) => {
        console.warn(`[suggest-ghost] _ops write skipped: describe() failed, ${String(error)}`);
        return false;
      }
    );
    const settleWrite = (mutated, rev, sent, attempt) => {
      const verdict = settleWriteVerdict(mutated, rev, sent);
      switch (verdict) {
        case "landed":
          return Promise.resolve(true);
        case "refused-conflict":
          if (opsConflictRetryAllowed(attempt)) return retryAfterOpsConflict(attempt);
          return reportWrite(mutated, rev, "conflict retries exhausted");
        case "refused-other":
          return reportWrite(mutated, rev, verdict);
        case "unsettled":
          return reportWrite(mutated, rev, verdict);
        case "unreadable":
          return readBackOnce(rev, sent).then((settled) => {
            if (settled === true) return Promise.resolve(true);
            return reportWrite(mutated, rev, verdict);
          });
      }
    };
    const retryAfterOpsConflict = async (attempt) => {
      await new Promise((resolve2) => {
        setTimeout(resolve2, opsConflictBackoffMs(attempt));
      });
      return doWrite(attempt + 1);
    };
    const readBackOnce = (rev, sent) => svc.describe().then((described) => {
      const row = (unwrapSettingsDoc(described)?.namespaces ?? []).find((r) => r.ns === SETTINGS_NAMESPACE);
      const verdict = verdictFromView(row, rev, sent);
      return verdict === "landed" ? true : void 0;
    }).catch(() => {
      return void 0;
    });
    const preview = (value, max) => {
      const s = JSON.stringify(value);
      return (s === void 0 ? "undefined" : s).slice(0, max);
    };
    const reportWrite = (mutated, rev, verdict) => {
      const outcome = unwrapMutateResult(mutated);
      const view = outcome.view;
      console.warn(
        `[suggest-ghost] _ops write ${String(verdict)}: expectedRevision=${rev}, code=${String(outcome.code)}, message=${String(outcome.message).slice(0, 120)}, revisionAfter=${String(view?.revision)}, _opsAfter=${preview(view?.value, 40)}`
      );
      return Promise.resolve(false);
    };
    return doWrite(0);
  };
  const opsWriteQueue = new OpsWriteQueue(writeOpsNow);
  const writeOps = (payload, kind = "pull") => opsWriteQueue.enqueue(payload, kind);
  let inlineTriggerTimer = null;
  const clearInlineTimer = () => {
    if (inlineTriggerTimer !== null) {
      clearTimeout(inlineTriggerTimer);
      inlineTriggerTimer = null;
    }
  };
  let armState = initialInlineArmState();
  const renderHits = { session: 0, input: 0, face: 0, other: 0 };
  let tallyState = initialTallyState();
  let deferredRepaintSkips = 0;
  const renderTraced = (source) => {
    renderHits[source] += 1;
    const tally = stepTally(tallyState, renderHits);
    if (tally.print) {
      tallyState = tally.state;
      console.debug(`${OPS_TRACE_PREFIX} render-source: reason=${tally.state.reason ?? "none"} ${tally.line.replace("render tally: ", "")} deferredSkipped=${deferredRepaintSkips}`);
    }
    render();
  };
  let resubscribeBound = null;
  const requestRegen = (content, base) => {
    const sessionId = currentSessionIdOf(sessions.list.getSnapshot());
    if (sessionId === void 0) {
      traceOnce("regen-skipped", "no-session", ` shownChars=${content.text.length} draftChars=${base.draft.length}`);
      return;
    }
    regenRev += 1;
    traceOnce("regen-requested", "sent", ` shownChars=${content.text.length} draftChars=${base.draft.length}`);
    traceClear("regen-requested", null);
    void writeOps(
      JSON.stringify({
        rev: regenRev,
        ops: [{ op: "regen", sessionId, basisRev: documentRevisionSeen, shownHash: hashText32(content.text) }]
      }),
      "regen"
    );
  };
  const requestForget = (content) => {
    const target = acceptTarget(content);
    if (target.trim() === "") return;
    forgetRev += 1;
    traceOnce("forget-requested", "sent", ` kind=${content.kind} chars=${target.length}`);
    void writeOps(
      JSON.stringify({ rev: forgetRev, ops: [{ op: "forget", text: target }] }),
      "forget"
    );
    overlay.hide();
    setKeyHint(null);
    shown = null;
  };
  const scheduleInlineTrigger = (currentId, ghostKind) => {
    const sessionId = bound === null ? null : currentId ?? null;
    const obs = {
      now: Date.now(),
      draft: bound === null ? "" : bound.input.state.getSnapshot().draft,
      sessionId,
      ghostKind,
      enabled: settings.inlineEnabled,
      minChars: settings.inlineMinChars,
      delayMs: settings.inlineDelayMs,
      composing
    };
    const outcome = decideInlineArm(armState, obs);
    armState = outcome.state;
    const { decision } = outcome;
    if (decision.action === "skip") return;
    clearInlineTimer();
    if (decision.action === "cancel") {
      if (decision.reason === "disabled" || decision.reason === "no-session") {
        traceOnce(
          "inline-arm-cancel",
          decision.reason,
          ` draftChars=${obs.draft.length} minChars=${obs.minChars} bound=${String(bound !== null)} enabled=${String(obs.enabled)}`
        );
      } else {
        traceClear("inline-arm-cancel", null);
      }
      return;
    }
    traceClear("inline-arm-cancel", null);
    const armedSessionId = decision.sessionId;
    inlineTriggerTimer = setTimeout(() => {
      inlineTriggerTimer = null;
      const draftNow = bound?.input.state.getSnapshot().draft ?? "";
      if (bound === null || draftNow.trim().length < settings.inlineMinChars) {
        armState = settleInlineTimer(armState, null);
        return;
      }
      armState = settleInlineTimer(armState, { sessionId: armedSessionId, draft: draftNow });
      lightLocalPending(armedSessionId, draftNow);
      void writeOps(
        JSON.stringify({ rev: 0, ops: [{ op: "complete", sessionId: armedSessionId, draft: draftNow }] }),
        "complete"
      );
    }, Math.max(0, decision.dueAt - obs.now));
  };
  let pullRev = 0;
  let regenRev = 0;
  let forgetRev = 0;
  let lastPulledSessionId;
  let pendingPull = null;
  let pullRetryTimer = null;
  const pullHistory = (sessionId) => {
    if (sessionId === lastPulledSessionId) return;
    lastPulledSessionId = sessionId;
    pendingPull = { sessionId, attempts: 0 };
    pullRev += 1;
    void writeOps(JSON.stringify({ rev: pullRev, ops: [{ op: "pull", sessionId }] }));
    schedulePullRetry();
  };
  const retryPendingPull = () => {
    const pending = pendingPull;
    if (pending === null) return;
    if (lastSessionId !== pending.sessionId) {
      pendingPull = null;
      return;
    }
    if (settings.historySessionId === pending.sessionId) {
      pendingPull = null;
      return;
    }
    if (pending.attempts >= PULL_MAX_ATTEMPTS) {
      pendingPull = null;
      return;
    }
    pending.attempts += 1;
    pullRev += 1;
    void writeOps(JSON.stringify({ rev: pullRev, ops: [{ op: "pull", sessionId: pending.sessionId }] }));
    schedulePullRetry();
  };
  const schedulePullRetry = () => {
    if (pendingPull === null || pullRetryTimer !== null) return;
    const delay = PULL_RETRY_BASE_MS * 2 ** pendingPull.attempts;
    pullRetryTimer = setTimeout(() => {
      pullRetryTimer = null;
      retryPendingPull();
    }, delay);
  };
  const GHOST_STREAM_INJECT_KEY = `remote.${GHOST_STREAM_NAMESPACE}`;
  const STREAM_FRAMES_MAX = 64;
  let streamFramesLog = [];
  let streamFramesKey = "";
  let streamedFrame = null;
  let lastRunning = false;
  let ghostStreamNamespace;
  const streamTrace = (msg) => {
    console.debug(`[dsh-suggest-ghost][ops-trace] ${msg}`);
  };
  const ghostStream = createGhostStreamChannel({
    // **必须是 getter**：命名空间要等懒注入完成后才回填，静态取值会永远拿到 undefined。
    get namespace() {
      return ghostStreamNamespace;
    },
    onFrame: (frame, sessionId) => {
      streamTrace(`stream frame=${frame.frame} final=${frame.final ? 1 : 0} chars=${frame.text.length} turn=${frame.turn} t=${Math.round(performance.now())}`);
      const framesKey = `${sessionId}|${frame.turn}`;
      if (streamFramesKey !== framesKey) {
        streamFramesKey = framesKey;
        streamFramesLog = [];
      }
      streamFramesLog.push({
        frame: frame.frame,
        final: frame.final ? 1 : 0,
        chars: frame.text.length,
        t: Math.round(performance.now())
      });
      if (streamFramesLog.length > STREAM_FRAMES_MAX) {
        streamFramesLog.splice(0, streamFramesLog.length - STREAM_FRAMES_MAX);
      }
      overlay.setStreamFrames(streamFramesLog);
      if (streamedFrame !== null && streamedFrame.sessionId !== sessionId) return;
      if (streamedFrame !== null && streamedFrame.turn === frame.turn && frame.frame < streamedFrame.frame) return;
      streamedFrame = { sessionId, text: frame.text, frame: frame.frame, final: frame.final, turn: frame.turn };
      render();
    },
    onState: (state, sessionId, note) => {
      streamTrace(`stream ${state} session=${sessionId.slice(0, 12)}${note === "" ? "" : " note=" + note}`);
      if ((state === "closed" || state === "unavailable") && streamedFrame?.sessionId === sessionId) {
        streamedFrame = null;
      }
    }
  });
  const streamFrameFor = (currentId) => settings.streamingDelivery && streamedFrame !== null && streamedFrame.sessionId === currentId ? streamedFrame : null;
  const remote = remoteOf(ctx);
  if (remote?.settings !== void 0) {
    let lastRevision = -1;
    let describeInFlight = false;
    let lastPushRaw = "\0";
    let lastPushed = null;
    let lastFrames = null;
    const applySettings = () => {
      void (async () => {
        if (describeInFlight) return;
        describeInFlight = true;
        try {
          const described = await remote.settings.describe();
          const list = unwrapSettingsDoc(described)?.namespaces ?? [];
          const entry = list.find((row) => row.ns === SETTINGS_NAMESPACE);
          if (entry === void 0) return;
          const rev = typeof entry.revision === "number" ? entry.revision : 0;
          if (rev === lastRevision) return;
          lastRevision = rev;
          documentRevisionSeen = rev;
          pushCellStats.applies += 1;
          const v = entry.value ?? {};
          const pushRaw = typeof v._push === "string" ? v._push : "";
          const pushCellChanged = pushRaw !== lastPushRaw;
          let pushed;
          if (pushCellChanged) {
            pushCellStats.parses += 1;
            lastPushRaw = pushRaw;
            pushed = null;
            if (pushRaw !== "") {
              try {
                pushed = JSON.parse(pushRaw);
              } catch {
                pushed = null;
              }
            }
            lastPushed = pushed;
          } else {
            pushCellStats.cellSkips += 1;
            pushed = lastPushed;
          }
          let hotPushed = null;
          if (typeof v._hot === "string" && v._hot !== "") {
            try {
              hotPushed = JSON.parse(v._hot);
            } catch {
              hotPushed = null;
            }
          }
          const hotSource = hotPushed ?? pushed ?? {};
          let frames;
          if (pushCellChanged || lastFrames === null) {
            pushCellStats.frameRuns += 1;
            frames = resolvePayloadFrames({
              ledger: frameLedger,
              pushed,
              prevCompletionFrame: settings.completionFrame
            });
            frameLedger = frames.ledger;
            lastFrames = frames;
          } else {
            frames = lastFrames;
          }
          traceOnce(
            "push-cell",
            pushCellChanged ? "suggestion-cell-changed" : "hot-cell-only",
            ` parses=${pushCellStats.parses} frameRuns=${pushCellStats.frameRuns} cellSkips=${pushCellStats.cellSkips} applies=${pushCellStats.applies}`
          );
          if (!frames.accept) {
            traceOnce(
              "stale-frame",
              frames.outcome,
              ` bucket=${String(frames.bucket)} ${frameHintFields(frames.suggestionFrame)} seen=${String(frames.seen)} dropped=${frames.ledger.dropped}`
            );
            return;
          }
          if (frames.outcome !== "legacy") traceClear("stale-frame", null);
          const next = {
            historyEnabled: typeof v.historyEnabled === "boolean" ? v.historyEnabled : true,
            historyCrossSession: typeof v.historyCrossSession === "boolean" ? v.historyCrossSession : false,
            historyMaxEntries: typeof v.historyMaxEntries === "number" ? v.historyMaxEntries : 50,
            historyMinChars: typeof v.historyMinChars === "number" ? v.historyMinChars : 1,
            inlineEnabled: typeof v.inlineEnabled === "boolean" ? v.inlineEnabled : true,
            streamingDelivery: typeof v.streamingDelivery === "boolean" ? v.streamingDelivery : false,
            inlineDelayMs: typeof v.inlineDelayMs === "number" ? v.inlineDelayMs : 100,
            inlineMinChars: typeof v.inlineMinChars === "number" ? v.inlineMinChars : 4,
            wordAccept: typeof v.wordAccept === "boolean" ? v.wordAccept : true,
            wordAcceptKey: typeof v.wordAcceptKey === "string" && v.wordAcceptKey.trim() !== "" ? v.wordAcceptKey : "Right",
            localAcceptKey: typeof v.localAcceptKey === "string" && v.localAcceptKey.trim() !== "" ? v.localAcceptKey : "Tab",
            // `dismissKey` 与上面两键**不同判据**：空串是合法值（= 不接管关闭动作），
            // 所以这里只判类型、不把空串当缺失。`?? 'Escape'` 只在键缺席（旧宿主）时兜底。
            dismissKey: typeof v.dismissKey === "string" ? v.dismissKey : "Escape",
            // 与 dismissKey 同一条判据：空串合法（= 不接管），只判类型。
            // 兜底写成字面量（与 `DEFAULT_FORGET_KEY` 同值，由
            // `scripts/keybinding-registration-smoke.mjs` 的 ⑥ 逐字比对钉住）：
            // 那一道闸读的就是客户端里的字面量，写成常量会让它「找不到兜底」。
            forgetKey: typeof v.forgetKey === "string" ? v.forgetKey : "Alt+X",
            showKeyHint: typeof v.showKeyHint === "boolean" ? v.showKeyHint : false,
            regenEnabled: typeof v.regenEnabled === "boolean" ? v.regenEnabled : true,
            regenKey: typeof v.regenKey === "string" && v.regenKey.trim().length > 0 ? v.regenKey : "Alt+G",
            suggestion: pushed?.suggestion === null || pushed?.suggestion === void 0 ? null : pushed.suggestion,
            // 归一化后的帧提示（#38）：作废/缺省都由判据本身回 {@link LEGACY_FRAME_HINT}。
            suggestionFrame: frames.suggestionFrame,
            // 热度快照：显式 null = 宿主说「没有热度」；缺省 = 这一格没说话 ⇒ 保留现值。
            // （旧实现里缺省会被判成 null，两格拆开之后这个区别第一次变得可观测。）
            hot: hotSource.hot === null || hotSource.hot === void 0 ? hotPushed === null && pushed?.hot === void 0 ? settings.hot : null : hotSource.hot,
            // 忽略表：与 `hot` **同一条缺省判据**（这一格没说话 ⇒ 保留现值），
            // 但**多一层**：`null` 在宿主侧是有意义的值（「没有忽略条目」），
            // 所以这里显式 `null` ⇒ `[]`，不能走「保留现值」那一支——否则用户
            // 点完「全部恢复」后列表永远停在旧内容。
            ignored: hotSource.ignored === void 0 ? settings.ignored : Array.isArray(hotSource.ignored) ? hotSource.ignored.filter(
              (e) => typeof e === "object" && e !== null && typeof e.norm === "string" && typeof e.text === "string"
            ) : [],
            // history 省略 = host 本次推送不携带历史（保留现值）。启动对账推送正是
            // 这种形态：它只负责恢复建议，历史留给紧随其后的 pull 应答，此时若把
            // 本地历史清成 [] 会把「切回会话仍有历史」的体验一起清掉。
            history: Array.isArray(hotSource.history) ? hotSource.history.filter((t) => typeof t === "string") : settings.history,
            historySessionId: Array.isArray(hotSource.history) ? typeof hotSource.historySessionId === "string" ? hotSource.historySessionId : null : settings.historySessionId,
            suggestionSessionId: typeof pushed?.suggestionSessionId === "string" ? pushed.suggestionSessionId : null,
            // #127：宿主只在 true 时写 ⇒ 缺省即「不在途」。旧宿主不给键也读 false（升级期无害）。
            regenPending: pushed?.regenPending === true,
            // 续写在途：同一套缺省语义（宿主只在 true 时写）。
            completionPending: pushed?.completionPending === true,
            // 指示样式：两键**恒写**（配置语义，不是事件），所以只认真正的布尔值；
            // 缺失（旧宿主 / 载荷没带）时沿用现值——现值已经与宿主 schema 同缺省。
            caretGlowEnabled: typeof pushed?.caretGlow === "boolean" ? pushed.caretGlow : settings.caretGlowEnabled,
            boxGlowEnabled: typeof pushed?.boxGlow === "boolean" ? pushed.boxGlow : settings.boxGlowEnabled,
            // 续写：载荷省略 = host 未更新（保留现值，显示时仍以 draft 全等校验兜底）；
            // 显式 null = host 作废（切会话/回合结束清理）。
            completion: pushed?.completion === void 0 ? settings.completion : pushed.completion,
            // 续写的帧提示（#38）：本期宿主不出帧号，这里只可能带 `final`。
            completionFrame: frames.completionFrame,
            completionSessionId: pushed?.completion === void 0 ? settings.completionSessionId : typeof pushed.completionSessionId === "string" ? pushed.completionSessionId : null
          };
          const pushError = typeof pushed?.error === "string" && pushed.error.trim() !== "" ? pushed.error.trim() : null;
          if (pushError !== null) {
            const reason = suggestionFailureReason(pushError);
            traceOnce("suggestion-failed", reason, ` chars=${pushError.length}`);
            noteSuggestionFailure(reason);
          } else {
            if (pushCellChanged) clearSuggestionFailure();
            traceClear("suggestion-failed", null);
          }
          if (configValuesEqual(next, settings)) return;
          if (next.suggestion !== settings.suggestion) pushCellStats.suggestionRefSwaps += 1;
          settingsEpoch++;
          clearNormalizeCache();
          hotCountsCache = null;
          ignoredCache = null;
          ghostContentCache = null;
          settings = next;
          if (localPending !== null && (next.completion !== null || shouldFollowHostFalse(localPending, next.completionPending))) {
            localPending = null;
            if (pendingFloorTimer !== null) {
              clearTimeout(pendingFloorTimer);
              pendingFloorTimer = null;
            }
          }
          saveToCache({
            hot: settings.hot,
            history: settings.history,
            historySessionId: settings.historySessionId,
            suggestion: settings.suggestion,
            // 帧提示一起持久化：冷启动恢复出的建议不能是「provisional 却被当成终帧采纳」。
            suggestionFrame: settings.suggestionFrame,
            suggestionSessionId: settings.suggestionSessionId
          });
          renderTraced("other");
        } catch {
        } finally {
          describeInFlight = false;
        }
      })();
    };
    const onDocumentUpdated = (...args) => {
      const ns = typeof args[0] === "string" ? args[0] : void 0;
      if (ns !== void 0 && ns !== SETTINGS_NAMESPACE) return;
      applySettings();
    };
    const offUpdated = remote.$on?.("settings/document-updated", onDocumentUpdated);
    if (typeof remote.$mount === "function") {
      void Promise.resolve().then(async () => {
        const unmount = await remote.$mount(ghostStreamContribution());
        void ctx.inject([GHOST_STREAM_INJECT_KEY], (child) => {
          const childRemote = child.remote;
          ghostStreamNamespace = childRemote?.[GHOST_STREAM_NAMESPACE];
          streamTrace("stream namespace bound");
          return () => void 0;
        });
        return unmount;
      }).then((unmount) => {
        ctx.effect(() => unmount, "suggest-ghost: stream mount");
      }).catch((error) => {
        console.warn(`[dsh-suggest-ghost][ops-trace] stream unavailable, falling back to whole-block push: ${String(error instanceof Error ? error.message : error).slice(0, 160)}`);
      });
    }
    const offReset = ctx.on("connection/reset", () => applySettings());
    ctx.effect(() => () => {
      offUpdated?.();
      offReset();
    });
    applySettings();
  }
  const onKeyDown = (event) => {
    if (shouldYieldKey(event)) return;
    if (event.isComposing) return;
    if (shown === null) return;
    const focused = document.activeElement;
    if (!(focused instanceof HTMLTextAreaElement) && !(focused instanceof HTMLElement && focused.isContentEditable)) return;
    if (!isComposerTarget(focused)) return;
    const content = shown.content;
    const base = shown.base;
    const table = bindingTableOfContent(content);
    const facts = keyFactsOf(event);
    const owner = ownerOfKey(table, facts);
    if (owner === null) {
      if (settings.regenEnabled && specMatches(facts, settings.regenKey) && content.kind !== "llm") {
        traceOnce("regen-skipped", "not-llm", ` kind=${content.kind}`);
      }
      return;
    }
    if (owner === "dismiss") {
      event.preventDefault();
      event.stopPropagation();
      overlay.hide();
      setKeyHint(null);
      shown = null;
      traceOnce("ghost-dismissed", "key", ` kind=${content.kind}`);
      return;
    }
    if (owner === "regen") {
      event.preventDefault();
      event.stopPropagation();
      requestRegen(content, base);
      return;
    }
    if (owner === "forget") {
      event.preventDefault();
      event.stopPropagation();
      requestForget(content);
      return;
    }
    if (owner === "accept") {
      const gate = gateAccept(content.frame);
      if (!gate.allow) {
        traceOnce(
          "accept-gate-tab",
          gate.reason,
          ` kind=${content.kind} ${frameHintFields(content.frame)} ghostChars=${acceptTarget(content).length} draftChars=${base.draft.length}`
        );
        return;
      }
      traceClear("accept-gate-tab", null);
      const accepted = buildFullAccept(content, base.draft);
      const source = acceptSourceVerdict({
        // ⚠️ 取**节点上真画出来的那段**（`paintedText`），不是内部状态 `shown.content`：
        // 后者与 `accepted` 同源推导，拿它比等于同义反复（#166 B1 的本意是校验
        // 「屏幕上的那句是不是我要写的那句」）。
        paintedText: overlay.paintedText,
        paintedContent: shown.content,
        accepted
      });
      if (!source.allow) {
        traceOnce(
          "tab-abandon",
          source.reason ?? "unknown",
          ` kind=${content.kind} paintedChars=${source.paintedChars} acceptedChars=${source.acceptedChars} draftChars=${base.draft.length} ${frameHintFields(content.frame)}`
        );
        return;
      }
      traceClear("tab-abandon", null);
      event.preventDefault();
      event.stopPropagation();
      if (bound !== null) {
        const input = bound.input;
        const outcome = commitDraftIfPristine(
          base,
          readDraftSnapshot(input.state.getSnapshot()),
          () => {
            input.setDraft(accepted);
          }
        );
        if (!outcome.committed) {
          traceOnce(
            "tab-abandon",
            outcome.reason ?? "unknown",
            ` kind=${content.kind} acceptedChars=${accepted.length} baseDraftChars=${base.draft.length} baseRev=${String(base.rev)} ${frameHintFields(content.frame)}`
          );
        } else {
          traceClear("tab-abandon", null);
        }
      }
      overlay.hide();
      setKeyHint(null);
      shown = null;
      return;
    }
    if (owner === "word") {
      const ta = focused;
      const full = acceptTarget(content);
      const wordGate = gateAccept(content.frame);
      if (!wordGate.allow) {
        traceOnce(
          "accept-gate-word",
          wordGate.reason,
          ` kind=${content.kind} ${frameHintFields(content.frame)} ghostChars=${full.length} draftChars=${base.draft.length}`
        );
        return;
      }
      traceClear("accept-gate-word", null);
      if (!caretAtComposerEnd(ta)) return;
      const matchBase = wordMatchBase(content, base.draft);
      if (!full.startsWith(matchBase) || matchBase.length >= full.length) return;
      const chunk = nextAcceptChunk(full.slice(matchBase.length));
      if (chunk === "") return;
      const accepted = buildWordAccept(content, base.draft, matchBase, chunk);
      const wordSource = acceptSourceVerdict({
        paintedText: overlay.paintedText,
        paintedContent: shown.content,
        accepted
      });
      if (!wordSource.allow) {
        traceOnce(
          "word-abandon",
          wordSource.reason ?? "unknown",
          ` kind=${content.kind} chunkChars=${chunk.length} paintedChars=${wordSource.paintedChars} acceptedChars=${wordSource.acceptedChars} draftChars=${base.draft.length} ${frameHintFields(content.frame)}`
        );
        return;
      }
      traceClear("word-abandon", null);
      event.preventDefault();
      event.stopPropagation();
      if (bound !== null) {
        const input = bound.input;
        const outcome = commitDraftIfPristine(
          base,
          readDraftSnapshot(input.state.getSnapshot()),
          () => {
            input.setDraft(accepted);
          }
        );
        if (!outcome.committed) {
          traceOnce(
            "word-abandon",
            outcome.reason ?? "unknown",
            ` kind=${content.kind} chunkChars=${chunk.length} acceptedChars=${accepted.length} baseDraftChars=${base.draft.length} baseRev=${String(base.rev)} ${frameHintFields(content.frame)}`
          );
          overlay.hide();
          setKeyHint(null);
          shown = null;
          return;
        }
        traceClear("word-abandon", null);
      }
      if (wordAcceptSettled(content, accepted)) {
        overlay.hide();
        setKeyHint(null);
        shown = null;
      }
    }
  };
  ctx.effect(() => {
    let unsubs = [];
    let deferredRenders = [];
    const scheduleDeferredRenders = () => {
      for (const t of deferredRenders) clearTimeout(t);
      deferredRenders = [60, 300, 900].map((ms) => setTimeout(() => {
        if (shouldSkipDeferredRepaint({ painted: overlay.isPainted, growing: overlay.growing })) {
          deferredRepaintSkips += 1;
          traceOnce(
            "deferred-repaint",
            "growth-streak",
            ` skipped=${deferredRepaintSkips} paints=growth:${overlay.paints.growth}/remeasure:${overlay.paints.remeasure}/rebuild:${overlay.paints.rebuild}`
          );
          return;
        }
        traceClear("deferred-repaint", null);
        renderTraced("other");
      }, ms));
    };
    const subscribeBound = () => {
      for (const un of unsubs) un();
      unsubs = [];
      if (bound === null) return;
      const b = bound;
      unsubs.push(
        b.session.subscribe(() => {
          const running = b.session.getSnapshot().running === true;
          if (lastRunning && !running && settings.streamingDelivery) {
            const id = currentSessionIdOf(sessions.list.getSnapshot());
            if (id !== void 0) ghostStream.open(id);
          }
          lastRunning = running;
          renderTraced("session");
        }),
        b.input.state.subscribe(() => {
          if (readDraftSnapshot(b.input.state.getSnapshot()).draft.trim() !== "") ghostStream.close("draft-changed");
          renderTraced("input");
        }),
        bound.projectionFace.subscribe(() => renderTraced("face"))
      );
    };
    const rebind = (knownId) => {
      const hook = resubscribeBound;
      resubscribeBound = null;
      try {
        resolve(knownId ?? currentSessionIdOf(sessions.list.getSnapshot()));
      } finally {
        resubscribeBound = hook;
      }
      subscribeBound();
      scheduleDeferredRenders();
    };
    resubscribeBound = subscribeBound;
    rebind();
    renderTraced("other");
    const onList = () => {
      const id = currentSessionIdOf(sessions.list.getSnapshot());
      if (id !== lastSessionId) rebind(id);
      renderTraced("other");
    };
    const unList = sessions.list.subscribe(onList);
    const onCompositionStart = () => {
      composing = true;
      renderTraced("other");
    };
    const onCompositionEnd = () => {
      composing = false;
      renderTraced("other");
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("compositionstart", onCompositionStart, true);
    window.addEventListener("compositionend", onCompositionEnd, true);
    return () => {
      unList();
      for (const un of unsubs) un();
      unsubs = [];
      resubscribeBound = null;
      for (const t of deferredRenders) clearTimeout(t);
      if (pullRetryTimer !== null) clearTimeout(pullRetryTimer);
      pullRetryTimer = null;
      pendingPull = null;
      clearInlineTimer();
      armState = initialInlineArmState();
      traceClear("inline-arm-cancel", null);
      traceClear("form-hold", null);
      traceClear("deferred-repaint", null);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("compositionstart", onCompositionStart, true);
      window.removeEventListener("compositionend", onCompositionEnd, true);
      overlay.dispose();
    };
  }, "dsh-suggest-ghost: composer ghost render");
  const ENTRY_ID = "suggest-ghost";
  if (ctx.slots !== void 0) {
    ctx.inject(["configForms"], () => {
      const forms = ctx.get("configForms");
      if (forms === void 0 || typeof forms.get !== "function" || typeof forms.whileServed !== "function") return;
      const formScope = forms.get(ENTRY_ID);
      ctx.effect(
        () => forms.whileServed(
          [ENTRY_ID],
          () => ctx.slots.inject(
            "plugins.bundle.config",
            () => ctx.slots.register({
              name: "plugins.bundle.config",
              key: "dsh-suggest-ghost",
              locale: "dsh-suggest-ghost",
              // ⚠️ 两个入口（详情页 / 设置对话框）必须传同样的一组目录能力：
              // 只给其中一个传过 ⇒ 另一个入口会静默退回 HTTP 目录（此前详情页就是这样，
              // 表现为"档位永远文本框，而且连诊断都不显示"）。
              inject: () => ({
                scope: formScope,
                locale,
                surface: "detail",
                modelCatalog: () => officialCatalogReader?.() ?? null,
                modelCatalogDiag: () => officialCatalogDiag,
                modelCatalogSubscribe: (listener) => {
                  officialCatalogListener = listener;
                  return () => {
                    if (officialCatalogListener === listener) officialCatalogListener = null;
                  };
                }
              })
            }, SuggestGhostCard)
          )
        ),
        "dsh-suggest-ghost: plugins-page card"
      );
    });
  }
  if (ctx.slots !== void 0) {
    const disposeKeyHint = ctx.slots.inject(
      "conversation.input.overlay",
      () => ctx.slots.register({
        name: "conversation.input.overlay",
        id: "suggest-ghost-keyhint",
        // 参考实现（dsh-input-assist）在同一槽位用 200；取相近量级，
        // 保证排在别人的输入区浮层之后/之前有可调余量。
        order: 200,
        // 组件只读这一个 thunk；`subscribe` 让「幽灵出现/消失」能推动重渲染。
        inject: () => ({
          keyHintNow,
          subscribe: (fn) => {
            keyHintSubs.add(fn);
            return () => {
              keyHintSubs.delete(fn);
            };
          }
        })
      }, KeyHintBarSlot)
    );
    ctx.effect(() => disposeKeyHint, "dsh-suggest-ghost: input overlay key hint");
    const disposeFailureNote = ctx.slots.inject(
      "conversation.input.overlay",
      () => ctx.slots.register({
        name: "conversation.input.overlay",
        id: "suggest-ghost-failure-note",
        // 键位提示是 200；失败指示排在它之前（更靠锚点内侧），即使两者同时在场
        // 也不会互相覆盖（两者都是 `top:0`，所以顺序只影响无障碍读取次序）。
        order: 199,
        inject: () => ({
          failureNow,
          subscribe: subscribeFailure,
          // 语言随帧现读：与键位提示同规，改界面语言后下一次推送就是新文案。
          get lang() {
            return activeLang();
          }
        })
      }, FailureNote)
    );
    ctx.effect(() => disposeFailureNote, "dsh-suggest-ghost: input overlay failure note");
  }
  const remoteForCard = remoteOf(ctx);
  if (ctx.slots === void 0 || remoteForCard?.settings === void 0) return;
  const SHOW_SETTINGS_KEY = "dsh-suggest-ghost:show-settings-section";
  const showSettingsSection = typeof localStorage !== "undefined" && localStorage.getItem(SHOW_SETTINGS_KEY) === "true";
  if (!showSettingsSection) return;
  const cardScope = remoteSettingsScope(remoteForCard, SETTINGS_NAMESPACE);
  const disposeSection = ctx.slots.inject("settings.section", () => ctx.slots.register({
    name: "settings.section",
    // 自有 id：用宿主没有的 id 才会「并排新增一页」，复用宿主 id 会顶掉那一页。
    id: SETTINGS_SECTION_ID,
    order: 40,
    label: () => sectionLabel(locale),
    // 卡片只依赖 scope 的 get/subscribe/set 三个成员（见 settings-card.tsx 的
    // PluginSettingsScope），这里用 remote.settings 适配出同形状的最小面：
    // 0.1.7 已无 settingsScope 服务，而卡片逻辑（读快照 / 订阅变更 / 写字段）
    // 与代次无关，不必改卡片本体。
    inject: () => ({
      scope: cardScope,
      locale,
      surface: "settings",
      modelCatalog: () => officialCatalogReader?.() ?? null,
      modelCatalogDiag: () => officialCatalogDiag,
      modelCatalogSubscribe: (listener) => {
        officialCatalogListener = listener;
        return () => {
          if (officialCatalogListener === listener) officialCatalogListener = null;
        };
      }
    })
  }, SuggestGhostCard));
  {
    ctx.inject(["remote.session"], (sessionScope) => {
      const remoteRoot = sessionScope.get("remote") ?? remoteOf(ctx);
      const sessionFace = remoteRoot?.session;
      const call = sessionFace?.modelCatalog;
      officialCatalogLoader = () => {
        if (officialCatalogInflight !== null) return;
        if (typeof call !== "function") {
          officialCatalogDiag = "\u8BE5\u7248\u672C\u672A\u66B4\u9732 remote.session.modelCatalog";
          console.info("[dsh-suggest-ghost] modelCatalog: remote.session.modelCatalog unavailable");
          return;
        }
        officialCatalogInflight = (async () => {
          try {
            const response = await call.call(sessionFace);
            if (response?.ok !== true) {
              officialCatalogDiag = `\u5BBF\u4E3B\u672A\u8FD4\u56DE\u76EE\u5F55\uFF08ok=${String(response?.ok)}\uFF09`;
              console.info(`[dsh-suggest-ghost] modelCatalog: ${officialCatalogDiag}`);
              return;
            }
            const groups = mapOfficialGroups(response.value?.groups);
            officialGroups = groups;
            const withReasoning = groups.reduce((n, g) => n + g.models.filter((m) => m.reasoning !== void 0).length, 0);
            officialCatalogDiag = `${groups.length} \u7EC4 / ${groups.reduce((n, g) => n + g.models.length, 0)} \u6A21\u578B / \u5176\u4E2D ${withReasoning} \u4E2A\u5E26\u6863\u4F4D`;
            console.info(`[dsh-suggest-ghost] modelCatalog: ${officialCatalogDiag}`);
            officialCatalogListener?.();
          } catch (error) {
            officialCatalogDiag = `\u8C03\u7528\u5931\u8D25\uFF1A${String(error?.message ?? error).slice(0, 60)}`;
            console.info(`[dsh-suggest-ghost] modelCatalog failed: ${officialCatalogDiag}`);
          } finally {
            officialCatalogInflight = null;
          }
        })();
      };
      officialCatalogLoader();
      ctx.effect(() => () => {
        officialCatalogReader = null;
        officialCatalogLoader = null;
        officialCatalogListener = null;
        officialGroups = null;
        officialCatalogDiag = null;
      });
    });
    officialCatalogReader = () => officialGroups !== null ? officialGroups : (officialCatalogLoader?.(), null);
    ctx.effect(() => () => {
      officialCatalogReader = null;
      officialCatalogLoader = null;
      officialCatalogListener = null;
      officialGroups = null;
      officialCatalogDiag = null;
    });
  }
  ;
  if (typeof disposeSection === "function") {
    ctx.effect(() => () => {
      disposeSection();
      cardScope.dispose();
    });
  }
}
function remoteSettingsScope(remote, ns) {
  let snapshot = { status: "loading", value: {}, writable: false };
  let revision = -1;
  const listeners = [];
  let disposed = false;
  const notify = () => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
      }
    }
  };
  const readValue = () => {
    void (async () => {
      if (disposed) return;
      try {
        const described = await remote.settings?.describe();
        const doc = unwrapSettingsDoc(described);
        const entry = (doc?.namespaces ?? []).find((row) => row.ns === ns);
        if (entry === void 0) return;
        const rev = typeof entry.revision === "number" ? entry.revision : 0;
        if (rev === revision) return;
        revision = rev;
        snapshot = {
          status: "ready",
          value: entry.value ?? {},
          // `writable` 是 describe() 的**外层**字段（整个设置文档可否写），
          // 不是命名空间条目的字段。缺省视为可写（旧宿主不带该字段）。
          writable: doc?.writable !== false
        };
        notify();
      } catch {
      }
    })();
  };
  readValue();
  const offUpdated = remote.$on?.("settings/document-updated", (...args) => {
    const evNs = typeof args[0] === "string" ? args[0] : void 0;
    if (evNs !== void 0 && evNs !== ns) return;
    readValue();
  });
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.push(listener);
      return () => {
        const i = listeners.indexOf(listener);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    set: async (key, next) => {
      const svc = remote.settings;
      if (svc === void 0) return;
      for (let attempt = 0; ; attempt += 1) {
        const expected = revision < 0 ? 0 : revision;
        let landedOk = true;
        let refusal = null;
        try {
          const mutated = await svc.mutate(ns, [{ op: "set", path: [key], value: next }], expected);
          const outcome = unwrapMutateResult(mutated);
          if (outcome.ok === false) {
            landedOk = false;
            refusal = { code: outcome.code, message: outcome.message };
          }
        } catch (error) {
          landedOk = false;
          refusal = readRejection(error);
        }
        if (landedOk) {
          readValue();
          return;
        }
        if (refusal !== null && !isConflictRefusal(refusal.code, refusal.message)) {
          console.warn(`[suggest-ghost] settings save refused: key=${key} code=${String(refusal.code)} message=${String(refusal.message).slice(0, 140)}`);
          return;
        }
        if (!opsConflictRetryAllowed(attempt)) {
          console.warn(`[suggest-ghost] settings save conflict retries exhausted: key=${key} expectedRevision=${String(expected)} \u2014 \u8BBE\u7F6E\u672A\u6301\u4E45\u5316\uFF0C\u8BF7\u91CD\u8BD5`);
          return;
        }
        await new Promise((resolve) => {
          setTimeout(resolve, opsConflictBackoffMs(attempt));
        });
      }
    },
    dispose: () => {
      disposed = true;
      offUpdated?.();
      listeners.length = 0;
    }
  };
}
function apply(ctx) {
  applyInner(ctx);
}
var pushCellStats = {
  /** 走进解析段的次数（`rev !== lastRevision` 之后、按格判重之前）。 */
  applies: 0,
  /** 真的对 `_push` 做了 `JSON.parse` 的次数。 */
  parses: 0,
  /** 真的重跑 `resolvePayloadFrames`（含读写帧台账）的次数。 */
  frameRuns: 0,
  /** 建议格原文未变 ⇒ 整段跳过解析与帧判定的次数。 */
  cellSkips: 0,
  /**
   * 建议对象的**引用**被换掉的次数。
   *
   * 这一条才配得上「不换建议对象引用」那句收益：`parses` 归零只证明没重新 parse，
   * 引用没换才是「下游拿到的还是同一个对象」（`ghostContent` 的缓存与 `saveToCache`
   * 都按引用读它）。判据是一次纯读比较，不动任何决策分支。
   */
  suggestionRefSwaps: 0,
  /**
   * 一条建议**因为归属不是当前会话**而被隐藏的次数（#56 的观测点）。
   *
   * 这条计数存在的唯一理由：载荷里**可以**带着别的会话的建议（`suggestionFieldsFor` 的
   * 既设计），而 #56 之后它更常出现——未判定的残留就是「归属还没判」的那一种。要让
   * 「B 在场时隐藏 A 的残留、切回 A 立即可用」这条**可断言**，就得有个能数的东西；
   * 只读 `settings.suggestionSessionId` 与 `currentId` 的关系，不改判据。
   *
   * 与 `llmGhostOffered` 配对读：一场「带归属别的会话的建议」应当是
   * `ownerHidden +1 且 llmGhostOffered +0`；切到那个会话之后应当反过来。
   */
  ownerHidden: 0,
  /** 建议格真的产出一条可显示的 LLM 幽灵的次数（`ownerHidden` 的反向观测点）。 */
  llmGhostOffered: 0
};

		return module.exports;
	}
});
