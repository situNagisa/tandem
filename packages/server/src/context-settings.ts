// 上下文自动管理设置的读取与范围收敛：config.json 可能被手动改写或来自旧版本。
import { DEFAULT_CONTEXT_SETTINGS, type ContextSettings } from '@tandem/protocol';

function pickBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function pickNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

export function normalizeContextSettings(input?: Partial<ContextSettings> | null): ContextSettings {
  if (!input || typeof input !== 'object') return { ...DEFAULT_CONTEXT_SETTINGS };
  return {
    autoCompact: pickBoolean(input.autoCompact, DEFAULT_CONTEXT_SETTINGS.autoCompact),
    // 阈值按百分数存储为 0.5–0.95，避免用户配成 0 或 1 造成永不压缩/每轮压缩
    autoCompactThreshold: pickNumber(
      input.autoCompactThreshold,
      DEFAULT_CONTEXT_SETTINGS.autoCompactThreshold,
      0.5,
      0.95,
    ),
    autoCompactKeepTurns: Math.round(
      pickNumber(input.autoCompactKeepTurns, DEFAULT_CONTEXT_SETTINGS.autoCompactKeepTurns, 1, 20),
    ),
    trimLargeToolResults: pickBoolean(
      input.trimLargeToolResults,
      DEFAULT_CONTEXT_SETTINGS.trimLargeToolResults,
    ),
    trimToolResultTokens: Math.round(
      pickNumber(
        input.trimToolResultTokens,
        DEFAULT_CONTEXT_SETTINGS.trimToolResultTokens,
        500,
        200_000,
      ),
    ),
    trimKeepTurns: Math.round(
      pickNumber(input.trimKeepTurns, DEFAULT_CONTEXT_SETTINGS.trimKeepTurns, 1, 100),
    ),
  };
}
