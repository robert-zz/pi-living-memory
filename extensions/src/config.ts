/**
 * 注入层：Config / Clock / Logger。
 * 策略层原先把「环境变量 / 墙上时钟 / 日志」三件事隐式依赖到进程里；这里改成显式注入，行为与原先逐一对齐：
 * 默认实现仍是同一套读 env、同一套 Date.now()、同一套写盘，只是调用点不再直接摸它们，测试可以换掉。
 *
 * 本模块是依赖图的最底层（L0）：不 import 任何本地模块；IO 与路径常量归 ./paths（L1）。
 * cfg / clock / logger 都是稳定引用、内部可变：jiti 加载多文件时，`export let` 的重新赋值不会传播到
 * 别的模块，所以注入只改对象内部（Object.assign / 换活动实现），保证所有模块看到同一份状态。
 */

export interface Config {
  /** LIVING_MEMORY_AUTO_FACT：推断自动按事实的置信度门槛 */
  autoFactConf: number;
  /** LIVING_MEMORY_ACTIVITY_MAX：activity.log 轮转阈值（字节） */
  activityMaxBytes: number;
  /** LIVING_MEMORY_RECALL_2L：2 字母 ASCII 技术缩写白名单（已 split/trim/小写） */
  recall2L: string[];
  /** LIVING_MEMORY_PROMOTE_THRESHOLD：推断转正复合分门槛 */
  promoteThreshold: number;
  /** LIVING_MEMORY_NO_AUTO_REVIEW=1：不设默认复核日期 */
  noAutoReview: boolean;
  /** LIVING_MEMORY_RECOVERY_DAYS：recovery/ 保留天数 */
  recoveryRetainDays: number;
  /** LIVING_MEMORY_AUTO_TRIAGE：原样保留（"0" 强制关 / "1" 强制开 / 其它交给设置） */
  autoTriage: string | undefined;
  /** LIVING_MEMORY_AUTO_FACT_EVIDENCE=0：关证据驱动的自动转事实 */
  autoFactEvidenceOff: boolean;
  /** LIVING_MEMORY_AUTO_FACT_DAYS：证据驱动转正的最少独立天数 */
  autoFactMinDays: number;
  /** LIVING_MEMORY_AUTO_FACT_SCORE：证据驱动转正的最小分（null=用 promoteThreshold） */
  autoFactMinScore: number | null;
  /** LIVING_MEMORY_BRIEF_MAX_CHARS：简报总长硬顶 */
  briefMaxChars: number;
  /** LIVING_MEMORY_TODO_DIGEST_CHARS：简报里待办正文摘录长度 */
  todoDigestChars: number;
  /** LIVING_MEMORY_PROFILE_BRIEF："on"=注入画像 / "off"=不注入 / undefined=看 profile-brief.on 文件 */
  profileBrief: "on" | "off" | undefined;
  /** LIVING_MEMORY_SUMMARY_KEEP：summary.md 活动小节保留数 */
  summaryKeep: number;
  /** LIVING_MEMORY_MISS_LOG != 0：零命中写 miss.log */
  missLog: boolean;
  /** LIVING_MEMORY_QMD：归档检索外挂 qmd 的可执行文件 */
  qmdBin: string;
  /** LIVING_MEMORY_QMD_TIMEOUT_MS：qmd 调用超时 */
  qmdTimeoutMs: number;
  /** LIVING_MEMORY_RECALL_MAX_ROWS：召回索引行上限 */
  recallMaxRows: number;
  /** LIVING_MEMORY_RECALL != 0：简报尾部召回段开关 */
  recallEnabled: boolean;
  /** LIVING_MEMORY_DEBUG=1：调试日志落盘 */
  debug: boolean;
  /** LIVING_MEMORY_EXTRACT != 0：自动抽取开关 */
  extractEnabled: boolean;
  /** LIVING_MEMORY_EXTRACT_MODEL：抽取用的 "provider/model-id"（已 trim） */
  extractModel: string;
  /** LIVING_MEMORY_EXTRACT_TIMEOUT_MS：抽取超时 */
  extractTimeoutMs: number;
  /** LIVING_MEMORY_START_HINTS != 0：session_start 提示开关 */
  startHints: boolean;
  /** LIVING_MEMORY_AUTO_ARCHIVE_KEEP：自动归档 summary 的保留节数 */
  autoArchiveKeep: number;
  /** LIVING_MEMORY_AUTO_ARCHIVE=1：超过 autoArchiveKeep 自动归档 */
  autoArchive: boolean;
  /** LIVING_MEMORY_PROFILE_AUTO != 0：session_start 刷新画像统计块 */
  profileAuto: boolean;
  /** LIVING_MEMORY_BRIEF != 0：简报注入开关 */
  briefEnabled: boolean;
}

/** 集中读取 LIVING_MEMORY_* ：解析式与原散读点逐一对齐（Number(...) 保留 NaN、三态开关保留原比较） */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const promoteThreshold = Number(env.LIVING_MEMORY_PROMOTE_THRESHOLD ?? 0.8);
  const autoFactScore = env.LIVING_MEMORY_AUTO_FACT_SCORE;
  return {
    autoFactConf: Number(env.LIVING_MEMORY_AUTO_FACT ?? 0.85),
    activityMaxBytes: Number(env.LIVING_MEMORY_ACTIVITY_MAX ?? 1_000_000),
    recall2L: (env.LIVING_MEMORY_RECALL_2L ?? "ai,ci,pr,ui,db,ss")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    promoteThreshold,
    noAutoReview: env.LIVING_MEMORY_NO_AUTO_REVIEW === "1",
    recoveryRetainDays: Number(env.LIVING_MEMORY_RECOVERY_DAYS ?? 180),
    autoTriage: env.LIVING_MEMORY_AUTO_TRIAGE,
    autoFactEvidenceOff: env.LIVING_MEMORY_AUTO_FACT_EVIDENCE === "0",
    autoFactMinDays: Number(env.LIVING_MEMORY_AUTO_FACT_DAYS ?? 3),
    autoFactMinScore: autoFactScore === undefined ? null : Number(autoFactScore),
    briefMaxChars: Number(env.LIVING_MEMORY_BRIEF_MAX_CHARS ?? 2400),
    todoDigestChars: Number(env.LIVING_MEMORY_TODO_DIGEST_CHARS ?? 70),
    profileBrief: env.LIVING_MEMORY_PROFILE_BRIEF === "1" ? "on" : env.LIVING_MEMORY_PROFILE_BRIEF === "0" ? "off" : undefined,
    summaryKeep: Number(env.LIVING_MEMORY_SUMMARY_KEEP ?? 60),
    missLog: env.LIVING_MEMORY_MISS_LOG !== "0",
    qmdBin: env.LIVING_MEMORY_QMD ?? "qmd",
    qmdTimeoutMs: Number(env.LIVING_MEMORY_QMD_TIMEOUT_MS ?? 30_000),
    recallMaxRows: Number(env.LIVING_MEMORY_RECALL_MAX_ROWS ?? 20000),
    recallEnabled: env.LIVING_MEMORY_RECALL !== "0",
    debug: env.LIVING_MEMORY_DEBUG === "1",
    extractEnabled: env.LIVING_MEMORY_EXTRACT !== "0",
    extractModel: (env.LIVING_MEMORY_EXTRACT_MODEL ?? "").trim(),
    extractTimeoutMs: Number(env.LIVING_MEMORY_EXTRACT_TIMEOUT_MS ?? 20000),
    startHints: env.LIVING_MEMORY_START_HINTS !== "0",
    autoArchiveKeep: Number(env.LIVING_MEMORY_AUTO_ARCHIVE_KEEP ?? 120),
    autoArchive: env.LIVING_MEMORY_AUTO_ARCHIVE === "1",
    profileAuto: env.LIVING_MEMORY_PROFILE_AUTO !== "0",
    briefEnabled: env.LIVING_MEMORY_BRIEF !== "0",
  };
}

/** setConfig 注入的覆盖：refreshConfig 重读 env 时要保留，否则注入值会被环境变量冲掉 */
export let configOverrides: Partial<Config> = {};
/** 启动时读一次 env（与原先的模块级常量同口径）；引用固定，注入只改字段，跨模块不会拿到旧对象 */
export const cfg: Config = loadConfig();
/** 测试/宿主注入：浅合并进当前 cfg 并记住，后续 refreshConfig 不会冲掉 */
export function setConfig(c: Partial<Config>): void {
  configOverrides = { ...configOverrides, ...c };
  Object.assign(cfg, c);
}
/** 重读 env 并重新叠加注入值：给原先「每次调用读 env」的点保住原语义 */
export function refreshConfig(): Config {
  Object.assign(cfg, loadConfig(), configOverrides);
  return cfg;
}

/** 策略层的唯一时间来源：now() 用毫秒，today() 用「今天」的日期串 */
export interface Clock {
  now(): number;
  today(): string;
}
/** 默认时钟 = 墙上时钟；today() 与原 today() 同口径（UTC ISO 前 10 位，不是本地日期） */
export const systemClock: Clock = {
  now: () => Date.now(),
  today: () => new Date().toISOString().slice(0, 10),
};
/** 当前活动时钟：只改这里，clock 门面引用不变 */
let activeClock: Clock = systemClock;
/** 稳定的时钟门面：所有模块 import 到的都是同一个对象，setClock 换掉内部活动实现 */
export const clock: Clock = {
  now: () => activeClock.now(),
  today: () => activeClock.today(),
};
/** 测试/宿主注入：冻结时钟后，到期分档、addDays、归档戳、锁超时判定全都走它 */
export function setClock(c: Clock): void {
  activeClock = c;
}

/** 策略层的日志出口：activity=审计事实记录，debug=排错线索，warn=异常但可继续 */
export interface Logger {
  activity(msg: string): void;
  debug(msg: string): void;
  warn(msg: string): void;
}
/** 默认落点：扩展壳在定义完 appendActivityLog/appendDebugLog 后注入（它们依赖 STORE 与轮转，IO 归壳） */
let logSink: Logger = {
  activity: () => {},
  debug: () => {},
  warn: () => {},
};
/** 稳定的日志门面：所有模块 import 到的都是同一个对象，注入只换内部落点 */
export const logger: Logger = {
  activity: (msg) => logSink.activity(msg),
  debug: (msg) => logSink.debug(msg),
  warn: (msg) => logSink.warn(msg),
};
/** 测试/宿主注入：接管日志输出（例如断言「记了哪几条审计」而不落盘） */
export function setLogger(l: Logger): void {
  logSink = l;
}

/**
 * settings.json 读取器：`pi.getSettings` 只在 default(pi) 里拿得到，模块级函数拿不到实例。
 * 这里持有的是同模块内的 `let`（不是 `export let`）：jiti 加载多文件时 `export let` 的重新赋值不跨模块传播，
 * 所以读函数与写函数必须住在同一个模块里，壳只调 setSettingsReader。
 */
let settingsReader: (() => any) | null = null;
/** 壳在 default(pi) 首行注入：() => pi.getSettings?.() ?? null */
export function setSettingsReader(fn: (() => any) | null): void {
  settingsReader = fn;
}
/** 读 settings：读器缺失/抛错一律返回 null（调用方按「设置没表态」处理） */
export function getSettings(): any {
  try {
    return settingsReader?.() ?? null;
  } catch {
    return null;
  }
}
