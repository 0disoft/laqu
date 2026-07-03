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
  const tokens: ThemeTokens = { ...defaultTokens, ...overrides };

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
