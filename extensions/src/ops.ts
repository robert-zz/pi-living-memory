/**
 * 兼容层（纯 re-export）：策略层按职责拆到 time / scope / evidence / lifecycle / documents / triage / search。
 * 扩展壳、brief、extract 仍从 "./ops" 取符号——拆模块是为了让人能找到代码，不是为了让 import 变漂亮。
 * 依赖图 L4：只 re-export，不含实现；新增策略函数请放进对应模块，这里保持零逻辑。
 */
export * from "./time";
export * from "./scope";
export * from "./evidence";
export * from "./lifecycle";
export * from "./documents";
export * from "./triage";
export * from "./search";
