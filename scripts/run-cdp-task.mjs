#!/usr/bin/env node
// 独立 CDP 任务入口：普通 Node 进程里跑同一套决策层编排，浏览器由外部 Chrome（CDP endpoint）提供。
//
// 定位（ROADMAP P1 去宿主化）：ego lite 之外的第二宿主。这里**只做编排**：
//   * 观测 / 决策 / 执行 / 校验 / 护栏 / 缓存 / 批量 / 抽取全部仍由 scripts/decider-loop.mjs 负责；
//   * 浏览器连接与页面归属由宿主适配器负责（默认 scripts/hosts/cdp-host.mjs，可覆盖）；
//   * 本文件不改引擎导出、不改 ego 默认入口、不起服务、不刷新路由（路由状态由调用方算好传 routeFile）。
//
// 两条用法：
//   1) 命令：node scripts/run-cdp-task.mjs --config <file>   （日志走 stderr，结果 JSON 走 stdout）
//   2) 库：  import { runCdpTask } from "./run-cdp-task.mjs"; await runCdpTask(cfg, deps)
//
// 适配器契约（共享接口，变更需先与主控对齐）：
//   connectCdpHost({ endpoint, signal, timeoutMs }) -> { page, metadata, close({ keepPage }) }
//   * 默认创建专属 target；close 只清理自己拥有的页面与连接，绝不关闭用户的浏览器进程；
//   * close({ keepPage: true }) = 保留页面供排查，但仍释放连接；keepPage: false = 连页面一起清理。
//   * page 需要满足引擎实际消费的 API：evaluate(fn, arg)、url()、title()、cdp(method, params)、
//     waitForLoadState(state, { timeout })，以及导航用的 goto(url, { waitUntil, timeout })（必需）。
//     waitForTimeout(ms) 可选（没有就不做那 800ms 额外等待）。
//     runner 不自己实现导航：只有一份有界导航/异常处理逻辑，全在适配器里。
//
// 配置字段（与 scripts/ego-decision-layer 现有 cfg 兼容，新增 cdpEndpoint）：
//   cdpEndpoint(必需) cdpTimeoutMs goal url until texts steps cache cacheFile cacheContext
//   batch visualFallback deciderConfig apiKey baseUrl fallbackBaseUrl
//   forceViewport("1280x900@1" 字符串，原样透传引擎) strictViewport
//   extractInstruction extractSchema extractionModel routeFile keepSpace keepPage
//   宿主/引擎覆盖：hostModule、engineModule（路径或 file:// URL；也可用环境变量
//   EGO_JEV_CDP_HOST / EGO_JEV_LIB，或在 deps 里直接注入）。
//   CDP 模式不接受 spaceId / keep：页面归属是本进程的专属 target，不复用也不按 label 保留。
//
// 结论语义：
//   * verified = 确定性退出条件（until）在**最终 URL** 上复核通过；jev_done 只是模型 done，verified=false；
//   * 配了 until 且最终 URL 未命中 → 绝不 success（reason=until_not_matched）；
//   * 已执行动作与决策意图分开报告：dispatched 只在有证据时给 true/false，其余为 null（未知）；
//     outcomeUnknown 标记「可能已产生副作用但未核实」（取消、引擎报 action_outcome_unknown 等）。
//
// 退出码：0 成功 / 1 未达成 / 2 参数或配置错误 / 3 缺凭证 / 130 取消(SIGINT) / 143 取消(SIGTERM)

import { readFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_HOST_MODULE = resolve(HERE, "hosts", "cdp-host.mjs");
const DEFAULT_ENGINE_MODULE = resolve(HERE, "decider-loop.mjs");
const DEFAULT_CONNECT_TIMEOUT_MS = 15000;
const NAV_TIMEOUT_MS = 25000;
const LOG_PREFIX = "[cdp-task]";
// 取消 / 控制停止的错误码：EGO_ABORTED 是本入口自己的取消码，其余来自宿主适配器。
const ABORT_CODES = new Set(["EGO_ABORTED", "EGO_HOST_ABORTED", "HOST_ABORTED"]);

/** 参数 / 配置 / 环境错误：带退出码，CLI 直接照用。 */
export class CdpTaskError extends Error {
  constructor(message, exitCode = 2) {
    super(message);
    this.name = "CdpTaskError";
    this.exitCode = exitCode;
  }
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
function toModuleUrl(target) {
  const raw = String(target);
  if (/^file:\/\//i.test(raw) || /^[a-z]+:\/\//i.test(raw)) return raw;
  return pathToFileURL(isAbsolute(raw) ? raw : resolve(process.cwd(), raw)).href;
}

function abortError(reason) {
  // code 用 EGO_ 前缀：引擎的 rethrowBrowserStop 把它当「控制停止」，不会被当成导航噪声吞掉，
  // 因此 check() 里抛它一定中断整个循环（不执行后续派发、不重试）。
  const err = new Error("任务已取消" + (reason ? `（${reason}）` : ""));
  err.name = "AbortError";
  err.code = "EGO_ABORTED";
  err.cancelled = true;
  return err;
}

/**
 * 任何“控制被中止”形态的错误。
 * 与 cdp-host 对齐（docs/HOST-ADAPTER.md）：宿主取回控制权 / 主动中止时抛 `EGO_HOST_ABORTED`
 * （EGO_ 前缀 → 引擎 rethrowBrowserStop 直接上抛，不会被当导航噪声吞掉）。
 * 只有 **本次 signal 已取消** 才算用户取消；否则是宿主控制停止，两者不能混。
 */
function isAbortLike(err) {
  if (!err) return false;
  const code = String(err.code || "");
  return ABORT_CODES.has(code) || /_ABORTED$/.test(code) || err.cancelled === true || err.name === "AbortError";
}

function isVerifiedReason(reason) {
  return String(reason || "").startsWith("check_passed");
}

function errorText(err) {
  return String((err && (err.message || err)) || "unknown_error");
}

function normalizeConfig(cfg) {
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) {
    throw new CdpTaskError("配置必须是 JSON 对象");
  }
  const goal = typeof cfg.goal === "string" && cfg.goal.trim() ? cfg.goal.trim() : null;
  const extractInstruction =
    typeof cfg.extractInstruction === "string" && cfg.extractInstruction.trim() ? cfg.extractInstruction.trim() : null;
  if (!goal && !extractInstruction) {
    throw new CdpTaskError("配置缺少 goal 或 extractInstruction（至少要有操作目标或抽取指令）");
  }

  const rawSteps = cfg.steps === undefined || cfg.steps === null || cfg.steps === "" ? 10 : Number(cfg.steps);
  if (!Number.isSafeInteger(rawSteps) || rawSteps < 1 || rawSteps > 200) {
    throw new CdpTaskError(`steps 必须是 1..200 的整数（得到 ${JSON.stringify(cfg.steps)}）`);
  }

  // CDP 模式的页面归属：专属 target，不复用 ego taskSpace，也不按 label 保留页面。
  if (cfg.spaceId !== undefined && cfg.spaceId !== null && cfg.spaceId !== "") {
    throw new CdpTaskError("CDP 模式不复用 ego taskSpace：请去掉 spaceId（外部 Chrome 用的是本进程专属 target）");
  }
  if (cfg.keep !== undefined && cfg.keep !== null && cfg.keep !== "") {
    throw new CdpTaskError("CDP 模式不支持 keep（按页面 label 保留）：请改用 keepSpace / keepPage");
  }

  const cdpEndpoint = typeof cfg.cdpEndpoint === "string" ? cfg.cdpEndpoint.trim() : "";
  if (!cdpEndpoint) {
    throw new CdpTaskError("配置缺少 cdpEndpoint（外部 Chrome 的 CDP browser endpoint，如 ws://127.0.0.1:9222/devtools/browser/…）");
  }
  if (!/^(wss?|https?):\/\//i.test(cdpEndpoint)) {
    throw new CdpTaskError(`cdpEndpoint 需要 ws:// / wss:// / http:// / https:// 形式（得到 ${JSON.stringify(cdpEndpoint)}）`);
  }

  const connectTimeoutMs =
    cfg.cdpTimeoutMs === undefined || cfg.cdpTimeoutMs === null || cfg.cdpTimeoutMs === ""
      ? DEFAULT_CONNECT_TIMEOUT_MS
      : Number(cfg.cdpTimeoutMs);
  if (!Number.isSafeInteger(connectTimeoutMs) || connectTimeoutMs < 1) {
    throw new CdpTaskError(`cdpTimeoutMs 必须是正整数（得到 ${JSON.stringify(cfg.cdpTimeoutMs)}）`);
  }

  return {
    goal,
    extractInstruction,
    steps: rawSteps,
    cdpEndpoint,
    connectTimeoutMs,
    url: typeof cfg.url === "string" && cfg.url ? cfg.url : null,
    until: typeof cfg.until === "string" && cfg.until ? cfg.until : null,
    texts: Array.isArray(cfg.texts) ? cfg.texts.filter((t) => typeof t === "string") : [],
    cache: cfg.cache !== false,
    cacheFile: typeof cfg.cacheFile === "string" && cfg.cacheFile ? cfg.cacheFile : null,
    cacheContext: cfg.cacheContext && typeof cfg.cacheContext === "object" ? cfg.cacheContext : null,
    batch: cfg.batch !== false,
    visualFallback: cfg.visualFallback !== false,
    deciderConfig: cfg.deciderConfig && typeof cfg.deciderConfig === "object" ? cfg.deciderConfig : null,
    apiKey: typeof cfg.apiKey === "string" && cfg.apiKey ? cfg.apiKey : null,
    baseUrl: typeof cfg.baseUrl === "string" && cfg.baseUrl ? cfg.baseUrl : null,
    fallbackBaseUrl: typeof cfg.fallbackBaseUrl === "string" && cfg.fallbackBaseUrl ? cfg.fallbackBaseUrl : null,
    forceViewport: typeof cfg.forceViewport === "string" && cfg.forceViewport ? cfg.forceViewport : null,
    strictViewport: cfg.strictViewport === true,
    extractSchema: cfg.extractSchema ?? null,
    extractionModel: cfg.extractionModel ?? null,
    routeFile: typeof cfg.routeFile === "string" && cfg.routeFile ? cfg.routeFile : null,
    keepPage: cfg.keepPage === true || cfg.keepSpace === true,
    hostModule: cfg.hostModule ?? null,
    engineModule: cfg.engineModule ?? null,
  };
}

async function loadEngine(config, deps) {
  if (deps.engine) {
    if (typeof deps.engine.runJevAutonomousLoop !== "function") {
      throw new CdpTaskError("注入的引擎缺少 runJevAutonomousLoop");
    }
    return deps.engine;
  }
  const target = deps.enginePath || config.engineModule || process.env.EGO_JEV_LIB || DEFAULT_ENGINE_MODULE;
  let mod;
  try {
    mod = await import(toModuleUrl(target));
  } catch (err) {
    throw new CdpTaskError(`无法加载引擎 ${target}：${errorText(err)}`);
  }
  if (typeof mod.runJevAutonomousLoop !== "function") {
    throw new CdpTaskError(`引擎 ${target} 没有导出 runJevAutonomousLoop`);
  }
  return mod;
}

/** 适配器延迟动态导入：只有真要连浏览器时才加载，路径可覆盖（跨 worktree 验证用）。 */
async function resolveHostConnector(config, deps) {
  if (typeof deps.connectCdpHost === "function") return deps.connectCdpHost;
  const injected = deps.hostModule || null;
  const explicit = injected || config.hostModule || process.env.EGO_JEV_CDP_HOST || null;
  const target = explicit || DEFAULT_HOST_MODULE;
  let mod;
  if (typeof target === "object" && target !== null) {
    mod = target;
  } else {
    try {
      mod = await import(toModuleUrl(target));
    } catch (err) {
      throw new CdpTaskError(
        `无法加载宿主适配器 ${target}：${errorText(err)}。` +
          "适配器由 scripts/hosts/cdp-host.mjs 提供；未就绪时可用配置字段 hostModule、" +
          "环境变量 EGO_JEV_CDP_HOST 或 deps.connectCdpHost 指向已有的实现。"
      );
    }
  }
  if (typeof mod === "function") return mod;
  if (typeof mod.connectCdpHost === "function") return mod.connectCdpHost;
  if (typeof mod.default === "function") return mod.default;
  if (mod.default && typeof mod.default.connectCdpHost === "function") return mod.default.connectCdpHost;
  throw new CdpTaskError("宿主适配器没有导出 connectCdpHost({ endpoint, signal, timeoutMs })");
}

/**
 * 连浏览器之前的 fail-closed 预检：错误配置 / 缺凭证都在启动浏览器之前失败（退出码 2 / 3）。
 * 只有引擎真的导出对应函数时才检查，方便测试注入精简引擎。
 */
function preflight(config, engine) {
  if (config.extractSchema !== null && typeof engine.normalizeExtractionSchema === "function") {
    try {
      engine.normalizeExtractionSchema(config.extractSchema);
    } catch (err) {
      throw new CdpTaskError(`extractSchema 非法：${errorText(err)}`);
    }
  }

  let deciderLocal = config.deciderConfig?.kind === "openai-compatible";
  if (!deciderLocal && typeof engine.loadDeciderConfig === "function") {
    try {
      deciderLocal = engine.loadDeciderConfig()?.kind === "openai-compatible";
    } catch {
      deciderLocal = false;
    }
  }
  if (config.goal && !config.apiKey && !deciderLocal && typeof engine.loadApiKey === "function") {
    let key;
    try {
      key = engine.loadApiKey();
    } catch {
      key = undefined;
    }
    if (!key) {
      throw new CdpTaskError(
        "未找到 Jev 凭证。写入 ~/.config/typesafe/api_key（一行 API Key），或在 " +
          "~/.config/ego-decision-layer/credentials 写 export TYPESAFE_API_KEY=…，或用配置字段 apiKey；" +
          "本地后端请配 deciderConfig.kind=openai-compatible。",
        3
      );
    }
  }

  if (config.extractInstruction && !config.extractionModel && typeof engine.resolveExtractionModel === "function") {
    let model = null;
    try {
      model = engine.resolveExtractionModel({ deciderConfig: config.deciderConfig || undefined });
    } catch {
      model = null;
    }
    let usable = Boolean(model && model.baseUrl && model.model);
    if (usable && model.kind !== "openai-compatible") {
      const textKey = typeof engine.resolveTextApiKey === "function" ? engine.resolveTextApiKey(model) : null;
      const deciderKey = typeof engine.resolveDeciderApiKey === "function" ? engine.resolveDeciderApiKey(model) : null;
      usable = Boolean(textKey || deciderKey);
    }
    if (!usable) {
      throw new CdpTaskError(
        "未找到文本生成模型配置（extractInstruction 需要）。请配置 ~/.config/typesafe/text_model.json，" +
          "或在 deciderConfig 里给出本地 openai-compatible 后端，或直接传 extractionModel。",
        3
      );
    }
  }
}

/** 读当前 URL：优先 page.url()，退化为页内 location.href。读不到返回 null（未知 ≠ 未命中）。 */
async function readUrl(page) {
  if (!page) return null;
  try {
    if (typeof page.url === "function") {
      const value = await page.url();
      if (typeof value === "string" && value) return value;
    }
  } catch {
    // 换连接 / 上下文销毁时 url() 可能失败，继续退路
  }
  try {
    if (typeof page.evaluate === "function") {
      const value = await page.evaluate(() => location.href);
      if (typeof value === "string" && value) return value;
    }
  } catch {
    // 同上
  }
  return null;
}

/**
 * 导航到起始页。统一消费适配器的 goto：不在 runner 里再实现一份有界导航
 * （两份等待/异常吞掉逻辑会互相矛盾，也容易把控制停止当导航噪声吞掉）。
 */
async function navigate(page, url) {
  if (typeof page.goto !== "function") {
    throw new CdpTaskError("宿主适配器缺少 page.goto(url, { waitUntil, timeout })，无法导航到起始页");
  }
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
}


/**
 * 把引擎的单步结果整理成「意图 / 已执行 / 观测」三段。
 * 关键：不把决策意图当已执行动作。只有引擎给出证据时才敢写 dispatched=true/false，
 * 其余一律 null（未知），并单独标 outcomeUnknown。
 */
function actionRecord(entry, index) {
  const skipped = {};

  const signals = {
    guardRejected: entry?.guardRejected ?? null,
    staleTarget: entry?.staleTarget ?? null,
    targetMissing: entry?.targetMissing === true,
    optionStale: entry?.optionStale ?? null,
    invalidResponse: entry?.invalidResponse ?? null,
  };
  const noDispatchProof =
    Boolean(signals.guardRejected) ||
    Boolean(signals.staleTarget) ||
    signals.targetMissing ||
    Boolean(signals.optionStale) ||
    Boolean(signals.invalidResponse) ||
    ["wait", "done", "blocked"].includes(entry?.action);
  const subActions = Array.isArray(entry?.executedSubActions) ? entry.executedSubActions : null;

  // 子动作已派发过就是已派发：批次中途被拦（例如后续子动作命中危险词表）不能退成「确认未派发」。
  const batchPartial = Boolean(subActions && Number.isSafeInteger(entry?.batchSize) && subActions.length < entry.batchSize);
  let dispatched;
  if (subActions) dispatched = subActions.length > 0;
  else if (noDispatchProof) dispatched = false;
  else if (entry?.changed === true) dispatched = true;
  else dispatched = null; // 引擎没给可核对的派发证据

  const outcomeUnknown =
    entry?.cacheRecovery === "action_outcome_unknown" ||
    batchPartial ||
    (dispatched !== false && Boolean(entry?.error) && entry?.changed === false) ||
    (dispatched === null && Boolean(entry?.action) && entry?.action !== "wait" && Boolean(entry?.error));

  return {
    // 决策意图（模型/缓存决定了什么，不代表已经派发）
    intent: {
      action: entry?.action ?? null,
      target: entry?.target ?? null,
      targetLabel: entry?.targetLabel ?? entry?.label ?? null,
      text: entry?.text ?? null,
      option: entry?.option ?? null,
      batchSize: entry?.batchSize ?? null,
    },
    // 已执行证据：true 已派发 / false 确认未派发 / null 未知
    dispatched,
    batchPartial,
    executedSubActions: subActions ? subActions.map((sub) => ({ action: sub?.action ?? null, target: sub?.target ?? null })) : null,
    failedSubActionIndex: entry?.failedSubActionIndex ?? null,
    // 观测到的页面效果
    observed: {
      changed: entry?.changed ?? null,
      progressed: entry?.progressed ?? null,
      urlAfter: entry?.urlAfter ?? null,
      scrollMoved: entry?.scrollMoved ?? null,
    },
    skipped: signals,
    cacheHit: entry?.cacheHit === true,
    cacheRecovery: entry?.cacheRecovery ?? null,
    outcomeUnknown,
    error: entry?.error ?? null,
    durationMs: entry?.stepDurationMs ?? null,
    step: Number.isSafeInteger(entry?.step) ? entry.step : index + 1,
  };
}

function summarizeActions(history) {
  if (!Array.isArray(history)) return null; // null = 引擎没给 history，动作未知
  return history.map((entry, index) => actionRecord(entry, index));
}

async function readRoute(routeFile) {
  if (!routeFile) return null;
  try {
    return JSON.parse(await readFile(routeFile, "utf8"));
  } catch {
    return null;
  }
}

/**
 * 跑一次外部 CDP 任务。
 *
 * @param {object} cfg  见文件头「配置字段」
 * @param {object} [deps] 注入点：
 *   connectCdpHost(args)  适配器（最高优先级）
 *   hostModule            适配器路径或模块命名空间
 *   engine / enginePath   引擎模块或路径
 *   signal                外部取消信号（测试与调用方取消都走它）
 *   installSignalHandlers 是否接管 SIGINT/SIGTERM（CLI 显式打开；库调用默认不接管）
 *   onLog(msg)            日志回调（CLI 默认写 stderr）
 * @returns {Promise<object>} 结果对象（含 exitCode），不抛业务失败；配置/凭证错误抛 CdpTaskError。
 */
export async function runCdpTask(cfg, deps = {}) {
  const startedAt = Date.now();
  const log = typeof deps.onLog === "function" ? deps.onLog : (message) => console.log(`${LOG_PREFIX} ${message}`);
  const config = normalizeConfig(cfg);
  const engine = await loadEngine(config, deps);
  preflight(config, engine);
  const route = await readRoute(config.routeFile);

  // ── 取消：外部 signal + SIGINT/SIGTERM。取消只“停止派发新动作”，不强行杀掉在飞的一步。 ──
  const controller = new AbortController();
  const listeners = [];
  let cancelSignal = null;
  const cancel = (source) => {
    if (controller.signal.aborted) return;
    cancelSignal = source;
    controller.abort();
  };
  const throwIfAborted = () => {
    if (controller.signal.aborted) throw abortError(cancelSignal);
  };
  const cancelResult = () => {
    result.cancelled = true;
    result.cancelSignal = cancelSignal || "external";
    result.reason = "cancelled";
    result.exitCode = cancelSignal === "SIGTERM" ? 143 : 130;
    result.stepLog = [...stepLog];
    result.steps = null; // 取消时步数未知：日志只是“已知的部分”
    result.outcomeUnknown = true; // 在飞的一步可能已经产生副作用
  };
  if (deps.signal) {
    if (deps.signal.aborted) cancel("external");
    else {
      const onExternalAbort = () => cancel("external");
      deps.signal.addEventListener("abort", onExternalAbort);
      listeners.push(() => deps.signal.removeEventListener("abort", onExternalAbort));
    }
  }
  if (deps.installSignalHandlers === true) {
    for (const signal of ["SIGINT", "SIGTERM"]) {
      const handler = () => {
        cancel(signal);
        log(`收到 ${signal}：停止派发新动作，收尾释放连接…`);
      };
      process.on(signal, handler);
      listeners.push(() => process.removeListener(signal, handler));
    }
  }

  const result = {
    success: false,
    exitCode: 1,
    verified: false,
    reason: "not_started",
    stopReason: null,
    modelDone: false,
    cancelled: false,
    cancelSignal: null,
    outcomeUnknown: false,
    goal: config.goal,
    texts: config.texts,
    startUrl: config.url,
    until: config.until,
    untilMatched: null,
    untilVerification: null,
    url: null,
    title: null,
    steps: null,
    actions: null,
    stepLog: [],
    extracted: false,
    extractSkipped: false,
    data: null,
    instruction: config.extractInstruction,
    schema: null,
    error: null,
    phases: null,
    cacheHits: 0,
    cacheHeals: 0,
    serverModels: null,
    serverEndpoints: null,
    usage: null,
    viewport: null,
    viewportOverride: null,
    hint: null,
    metadata: null,
    route,
    connection: { endpoint: config.cdpEndpoint, connected: false, released: false, keepPage: false, closeError: null },
    elapsedMs: 0,
  };

  let page = null;
  let closeFn = null;
  let wantKeepPage = config.keepPage;
  // 引擎的步骤日志本来是 console.log（会污染 stdout 的结果 JSON，且取消时 history 拿不到）。
  // 统一收进 stepLog + 写 stderr：日志是“已知的部分”，与结构化 actions 分开报告。
  const stepLog = [];
  const recordStep = (message) => {
    const line = String(message);
    stepLog.push(line);
    if (stepLog.length > 200) stepLog.shift();
    log(line);
  };

  const finish = async () => {
    // 收尾必须在 finally 里：失败、异常、取消都要释放连接（keepPage 只影响页面，不阻止释放）。
    if (typeof closeFn !== "function") return;
    result.connection.keepPage = Boolean(wantKeepPage);
    try {
      const receipt = await closeFn({ keepPage: Boolean(wantKeepPage) });
      result.connection.released = true;
      if (receipt && typeof receipt === "object") result.connection.receipt = receipt;
      log(`连接已释放（keepPage=${Boolean(wantKeepPage)}）`);
    } catch (err) {
      result.connection.closeError = errorText(err);
      log(`释放连接失败：${result.connection.closeError}`);
    }
  };

  try {
    throwIfAborted();

    let connectCdpHost;
    try {
      connectCdpHost = await resolveHostConnector(config, deps);
      throwIfAborted();
      log(`连接外部 Chrome CDP：${config.cdpEndpoint}`);
      const connection = await connectCdpHost({
        endpoint: config.cdpEndpoint,
        signal: controller.signal,
        timeoutMs: config.connectTimeoutMs,
      });
      if (!connection || typeof connection.close !== "function" || !connection.page) {
        throw new CdpTaskError("宿主适配器违反了共享契约：需要返回 { page, metadata, close({ keepPage }) }");
      }
      page = connection.page;
      closeFn = connection.close.bind(connection);
      result.metadata = connection.metadata ?? null;
      result.connection.connected = true;
    } catch (err) {
      if (controller.signal.aborted) {
        cancelResult();
        return result;
      }
      if (err instanceof CdpTaskError) throw err;
      if (isAbortLike(err)) {
        result.reason = "host_control_stop";
        result.error = errorText(err);
        result.outcomeUnknown = true;
        log(`宿主中止：${result.error}`);
        return result;
      }
      result.reason = "connect_failed";
      result.error = errorText(err);
      log(`连接失败：${result.error}`);
      return result;
    }

    // ── 导航 ────────────────────────────────────────────────────────────────
    if (config.url) {
      log(`导航至：${config.url}`);
      try {
        throwIfAborted();
        await navigate(page, config.url);
        if (typeof page.waitForTimeout === "function") await page.waitForTimeout(800);
      } catch (err) {
        if (controller.signal.aborted) {
          cancelResult();
          return result;
        }
        if (err instanceof CdpTaskError) throw err;
        if (isAbortLike(err)) {
          result.reason = "host_control_stop";
          result.error = errorText(err);
          result.outcomeUnknown = true;
          return result;
        }
        result.reason = "navigation_failed";
        result.error = errorText(err);
        log(`导航失败：${result.error}`);
        return result;
      }
    }

    // ── 操作闭环：观测/决策/判重/护栏/缓存/批处理都由引擎负责 ─────────────────
    let loopResult = null;
    if (config.goal) {
      const loopOptions = {
        maxSteps: config.steps,
        text: config.texts,
        cache: config.cache,
        batch: config.batch,
        visualFallback: config.visualFallback,
        // check 同时承担两件事：确定性退出条件（until）+ 取消闸门（取消后不再有任何派发）。
        check: async (p) => {
          throwIfAborted();
          if (!config.until) return false;
          const href = await readUrl(p);
          return Boolean(href && href.includes(config.until));
        },
        onStep: recordStep,
      };
      if (config.apiKey) loopOptions.apiKey = config.apiKey;
      if (config.baseUrl) loopOptions.baseUrl = config.baseUrl;
      if (config.fallbackBaseUrl) loopOptions.fallbackBaseUrl = config.fallbackBaseUrl;
      if (config.deciderConfig) loopOptions.deciderConfig = config.deciderConfig;
      if (config.cacheFile) loopOptions.cacheFile = config.cacheFile;
      // 缓存身份与 CLI 保持一致：until 与后端配置参与 cacheContext（换条件不复用旧回放）。
      loopOptions.cacheContext = config.cacheContext || { until: config.until, decider: config.deciderConfig };
      if (config.forceViewport) loopOptions.forceViewport = config.forceViewport;
      if (config.strictViewport) loopOptions.strictViewport = true;

      try {
        loopResult = await engine.runJevAutonomousLoop(page, config.goal, loopOptions);
      } catch (err) {
        if (controller.signal.aborted) {
          cancelResult();
          return result;
        }
        if (isAbortLike(err)) {
          result.reason = "host_control_stop";
          result.error = errorText(err);
          result.stepLog = [...stepLog];
          result.actions = null;
          result.outcomeUnknown = true;
          log(`宿主中止（控制权丢失）：${result.error}`);
          return result;
        }
        throw err;
      }
      if (typeof engine.renderJevSummary === "function") log(engine.renderJevSummary(loopResult));
    }

    // ── 结论：确定性 verified 与模型 done 分开，有 until 未命中绝不 success ────
    const loopReason = loopResult ? loopResult.reason ?? null : null;
    const verified = isVerifiedReason(loopReason);
    const untilMissed = Boolean(loopResult && config.until && !verified);
    const modelDone = loopReason === "jev_done";
    let operationSuccess = loopResult ? loopResult.success === true : true;
    if (untilMissed) operationSuccess = false;

    // ── 抽取：操作没达成就不抽取（不拿未达成的页面当结果）────────────────────
    let extractResult = null;
    let extractSkipped = false;
    if (config.extractInstruction) {
      if (!operationSuccess) {
        extractSkipped = true;
        log("目标操作未成功达成，跳过数据抽取。");
      } else {
        const extractOptions = {};
        if (config.extractSchema !== null) extractOptions.schema = config.extractSchema;
        if (config.extractionModel !== null) extractOptions.textModel = config.extractionModel;
        if (config.deciderConfig) extractOptions.deciderConfig = config.deciderConfig;
        try {
          throwIfAborted();
          log(`执行数据抽取：${config.extractInstruction}`);
          extractResult = await engine.extract(page, config.extractInstruction, extractOptions);
          if (typeof engine.renderExtractSummary === "function") log(engine.renderExtractSummary(extractResult));
        } catch (err) {
          if (controller.signal.aborted) {
            cancelResult();
            return result;
          }
          // 宿主自己的中止（EGO_HOST_ABORTED）不是用户取消：交给外层按 host_control_stop 分类。
          if (isAbortLike(err)) throw err;
          extractResult = { success: false, reason: "extract_error", error: errorText(err) };
        }
      }
    }

    let success;
    let reason;
    if (config.extractInstruction) {
      if (extractSkipped) {
        success = false;
        reason = untilMissed ? "until_not_matched" : loopReason || "operation_not_successful";
      } else if (!extractResult) {
        success = false;
        reason = "extract_not_run";
      } else if (extractResult.success !== true) {
        success = false;
        reason = extractResult.reason || "extract_failed";
      } else {
        success = operationSuccess;
        reason = success ? "extracted" : untilMissed ? "until_not_matched" : loopReason || "operation_not_successful";
      }
    } else {
      success = operationSuccess;
      reason = untilMissed ? "until_not_matched" : loopReason || "no_operation";
    }

    result.success = Boolean(success);
    result.verified = Boolean(verified);
    result.exitCode = result.success ? 0 : 1;
    result.reason = reason;
    result.stopReason = loopReason;
    result.modelDone = Boolean(modelDone);
    result.steps = loopResult ? loopResult.steps ?? null : config.goal ? null : 0;
    result.actions = summarizeActions(loopResult?.history);
    result.extracted = Boolean(extractResult);
    result.extractSkipped = extractSkipped;
    result.data = extractResult?.data ?? null;
    result.schema = extractResult?.schema ?? null;
    result.error = extractResult?.error ?? null;
    result.phases = extractResult?.phases || loopResult?.phases || null;
    result.cacheHits = loopResult?.cacheHits ?? 0;
    result.cacheHeals = loopResult?.cacheHeals ?? 0;
    result.serverModels = loopResult?.serverModels ?? null;
    result.serverEndpoints = loopResult?.serverEndpoints ?? null;
    result.usage = extractResult?.usage || loopResult?.usage || null;
    result.viewport = loopResult?.viewport ?? null;
    result.viewportOverride = loopResult?.viewportOverride ?? null;
    result.hint = loopResult?.hint ?? null;
    result.outcomeUnknown =
      loopReason === "action_outcome_unknown" ||
      loopReason === "cache_replay_unverified" ||
      Boolean(loopResult?.history?.some?.((entry) => entry?.cacheRecovery === "action_outcome_unknown"));

    // 取消发生在收尾阶段（引擎已返回确定性结论）：保留确定性结论，但显式标记取消。
    if (controller.signal.aborted) {
      result.cancelled = true;
      result.cancelSignal = cancelSignal || "external";
      if (!result.verified) {
        result.success = false;
        result.exitCode = cancelSignal === "SIGTERM" ? 143 : 130;
        result.reason = "cancelled";
        result.outcomeUnknown = true;
      }
    }
    return result;
  } catch (err) {
    // 外层也看 signal：取消可能在抽取/收尾阶段炸出一个普通错误，不能当成 runner_error。
    if (controller.signal.aborted) {
      cancelResult();
      return result;
    }
    if (isAbortLike(err)) {
      result.reason = "host_control_stop";
      result.error = errorText(err);
      result.stepLog = [...stepLog];
      result.outcomeUnknown = true;
      return result;
    }
    if (err instanceof CdpTaskError) throw err;
    result.reason = "runner_error";
    result.error = errorText(err);
    result.stepLog = [...stepLog];
    result.outcomeUnknown = true;
    log(`编排异常：${result.error}`);
    return result;
  } finally {
    // 最终 URL / 标题必须在释放连接之前读：连接释放后 page 可能不可用。
    // 而 until 只能用**最终 URL**复核 —— 不能只信引擎报的 check_passed。
    const finalUrl = await readUrl(page);
    if (finalUrl) result.url = finalUrl;
    if (page) {
      try {
        if (typeof page.title === "function") result.title = await page.title();
      } catch {
        // 标题只是辅助证据，读不到就不写
      }
    }
    if (config.until && result.stopReason !== null) {
      const matched = typeof result.url === "string" && result.url.includes(config.until);
      result.untilMatched = matched;
      result.untilVerification = "final_url";
      if (!matched) {
        result.verified = false;
        result.success = false;
        if (!result.cancelled) {
          result.reason = "until_not_matched";
          result.exitCode = 1;
        }
        log(`最终 URL 未命中 until（${config.until}）：实际 ${result.url ?? "未知"}；不判成功`);
      }
    }

    // 保留页面的策略统一在这里决定：失败、取消、显式 keepSpace/keepPage 都保留页面（但仍释放连接）。
    wantKeepPage = Boolean(config.keepPage || result.cancelled || !result.success);
    await finish();
    for (const off of listeners) {
      try {
        off();
      } catch {
        // 监听器清理失败不影响结果
      }
    }
    result.elapsedMs = Date.now() - startedAt;
  }
}

// ── CLI ─────────────────────────────────────────────────────────────────────
const USAGE = `用法: node scripts/run-cdp-task.mjs --config <file>

在普通 Node 进程里用外部 Chrome（CDP）跑一次决策层任务。
配置是 JSON 文件；现有 scripts/ego-decision-layer 的 cfg 字段全部可用，另加 cdpEndpoint。
日志写 stderr，结果 JSON 写 stdout。退出码：0 成功 / 1 未达成 / 2 参数或配置错误 / 3 缺凭证 / 130|143 取消。

主要配置字段:
  cdpEndpoint        外部 Chrome 的 CDP browser endpoint（必需）
  cdpTimeoutMs       连接超时（默认 15000）
  goal               操作目标（与 extractInstruction 至少给一个）
  url / until / texts / steps
  cache / cacheFile / cacheContext / batch / visualFallback
  deciderConfig / apiKey / baseUrl / fallbackBaseUrl
  forceViewport ("1280x900@1") / strictViewport
  extractInstruction / extractSchema / extractionModel / routeFile
  keepSpace / keepPage   完成后保留页面（仍会释放 CDP 连接）
  hostModule / engineModule  适配器与引擎模块路径覆盖（也可用 EGO_JEV_CDP_HOST / EGO_JEV_LIB）

CDP 模式不支持 spaceId / keep。
`;

async function main(argv) {
  const args = argv.slice(2);
  let configPath = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(USAGE);
      return 0;
    }
    if (arg === "--config" || arg === "-c") {
      configPath = args[i + 1];
      if (!configPath) {
        process.stderr.write(`错误: --config 需要文件路径\n${USAGE}`);
        return 2;
      }
      i += 1;
      continue;
    }
    process.stderr.write(`错误: 未知参数 ${arg}\n${USAGE}`);
    return 2;
  }
  if (!configPath) {
    process.stderr.write(`错误: 请用 --config <file> 指定配置文件\n${USAGE}`);
    return 2;
  }

  let cfg;
  try {
    cfg = JSON.parse(await readFile(configPath, "utf8"));
  } catch (err) {
    process.stderr.write(`错误: 无法读取或解析配置文件 ${configPath}：${errorText(err)}\n`);
    return 2;
  }

  const result = await runCdpTask(cfg, {
    onLog: (message) => process.stderr.write(`${LOG_PREFIX} ${message}\n`),
    installSignalHandlers: true,
  });
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  return result.exitCode;
}

function invokedAsScript() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return pathToFileURL(realpathSync(entry)).href === pathToFileURL(realpathSync(fileURLToPath(import.meta.url))).href;
  } catch {
    return pathToFileURL(entry).href === import.meta.url;
  }
}

if (invokedAsScript()) {
  main(process.argv)
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      const code = Number.isSafeInteger(err?.exitCode) ? err.exitCode : 1;
      process.stderr.write(`错误: ${errorText(err)}\n`);
      process.exitCode = code;
    });
}
