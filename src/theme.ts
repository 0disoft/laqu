import type { ThemeInput, ThemeTokens } from "./types.js";
import { sanitizeText } from "./width.js";

export interface RenderableSegment {
  readonly text: string;
  readonly style?: "muted" | "success" | "error" | "warning" | "accent";
  readonly rawAnsi?: boolean;
}

export interface CompiledTheme {
  readonly tokens: ThemeTokens;
  format(segment: RenderableSegment): string;
}

const defaultTokens: ThemeTokens = {
  successSymbol: "✓",
  failSymbol: "×",
  cancelSymbol: "-",
  runningSymbol: "•",
  pendingSymbol: "·",
  progressComplete: "#",
  progressIncomplete: "-",
  progressIndeterminate: "~",
  indent: "  ",
  gap: " ",
  overflowMarker: "…",
};

const styles = {
  reset: "\u001b[0m",
  muted: "\u001b[2m",
  success: "\u001b[32m",
  error: "\u001b[31m",
  warning: "\u001b[33m",
  accent: "\u001b[36m",
} as const;

export function compileTheme(input: ThemeInput = {}): CompiledTheme {
  const { useColor = true, ...overrides } = input;
  const tokens = sanitizeThemeTokens({ ...defaultTokens, ...overrides });

  return {
    tokens,
    format(segment) {
      if (segment.rawAnsi === true) {
        return segment.text;
      }
      const safeText = sanitizeText(segment.text);
      if (!useColor || segment.style === undefined) {
        return safeText;
      }
      return `${styles[segment.style]}${safeText}${styles.reset}`;
    },
  };
}

export function text(textValue: string, style?: RenderableSegment["style"]): RenderableSegment {
  return style === undefined ? { text: textValue } : { text: textValue, style };
}

export function dangerouslyRawAnsi(textValue: string): RenderableSegment {
  return { text: textValue, rawAnsi: true };
}

export function renderSegments(
  theme: CompiledTheme,
  segments: readonly RenderableSegment[],
): string {
  return segments.map((segment) => theme.format(segment)).join("");
}

function sanitizeThemeTokens(tokens: ThemeTokens): ThemeTokens {
  return {
    successSymbol: sanitizeToken(tokens.successSymbol, "successSymbol"),
    failSymbol: sanitizeToken(tokens.failSymbol, "failSymbol"),
    cancelSymbol: sanitizeToken(tokens.cancelSymbol, "cancelSymbol"),
    runningSymbol: sanitizeToken(tokens.runningSymbol, "runningSymbol"),
    pendingSymbol: sanitizeToken(tokens.pendingSymbol, "pendingSymbol"),
    progressComplete: sanitizeToken(tokens.progressComplete, "progressComplete"),
    progressIncomplete: sanitizeToken(tokens.progressIncomplete, "progressIncomplete"),
    progressIndeterminate: sanitizeToken(tokens.progressIndeterminate, "progressIndeterminate"),
    indent: sanitizeToken(tokens.indent, "indent"),
    gap: sanitizeToken(tokens.gap, "gap"),
    overflowMarker: sanitizeToken(tokens.overflowMarker, "overflowMarker"),
  };
}

function sanitizeToken(value: unknown, name: keyof ThemeTokens): string {
  if (typeof value !== "string") {
    throw new TypeError(`theme.${name} must be a string`);
  }
  return sanitizeText(value);
}
