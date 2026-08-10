import { ambiguousRanges, wideRanges } from "./unicode-width-ranges.js";

export interface WidthOptions {
  readonly ambiguousWidth?: 1 | 2;
  readonly tabSize?: number;
  readonly overflowMarker?: string;
}

export type AnsiToken =
  | { readonly kind: "ansi"; readonly value: string }
  | { readonly kind: "text"; readonly value: string };

interface SgrState {
  intensity: boolean;
  italic: boolean;
  underline: boolean;
  blink: boolean;
  inverse: boolean;
  conceal: boolean;
  strike: boolean;
  overline: boolean;
  foreground: boolean;
  background: boolean;
  underlineColor: boolean;
}

// CSI, OSC, and common one-byte ESC sequences.
const ansiPattern = new RegExp(
  String.raw`\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\)|[@-Z\\-_])`,
  "g",
);
const resetSequence = "\u001b[0m";
const unsafeControlPattern = new RegExp(String.raw`[\u0000-\u0008\u000a-\u001f\u007f-\u009f]`, "g");
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const markOnlyPattern = /^\p{Mark}+$/u;
const markPattern = /\p{Mark}/u;
const defaultIgnorablePattern = /\p{Default_Ignorable_Code_Point}/u;
const emojiPattern = /\p{Emoji}/u;
const emojiPresentationPattern = /\p{Emoji_Presentation}/u;
const extendedPictographicPattern = /\p{Extended_Pictographic}/u;
const regionalIndicatorPattern = /^\p{Regional_Indicator}{1,2}$/u;
const unifiedIdeographPattern = /\p{Unified_Ideograph}/u;
const keycapPattern = /^[#*0-9]\uFE0F?\u20E3$/u;
const textPresentationSelector = "\uFE0E";
const emojiPresentationSelector = "\uFE0F";
const zeroWidthJoiner = "\u200D";

export function tokenizeAnsi(input: string): AnsiToken[] {
  const tokens: AnsiToken[] = [];
  let lastIndex = 0;

  for (const match of input.matchAll(ansiPattern)) {
    const index = match.index ?? 0;
    if (index > lastIndex) {
      tokens.push({ kind: "text", value: input.slice(lastIndex, index) });
    }
    tokens.push({ kind: "ansi", value: match[0] });
    lastIndex = index + match[0].length;
  }

  if (lastIndex < input.length) {
    tokens.push({ kind: "text", value: input.slice(lastIndex) });
  }

  return tokens;
}

export function stripAnsi(input: string): string {
  return tokenizeAnsi(input)
    .filter((token) => token.kind === "text")
    .map((token) => token.value)
    .join("");
}

export function sanitizeText(input: string): string {
  return stripAnsi(input).replaceAll(unsafeControlPattern, (control) =>
    control === "\n" || control === "\r" ? " " : "\uFFFD",
  );
}

export function graphemes(input: string): string[] {
  return Array.from(segmenter.segment(input), (segment) => segment.segment);
}

export function displayWidth(input: string, options: WidthOptions = {}): number {
  let width = 0;
  const tabSize = normalizedTabSize(options.tabSize);
  for (const token of tokenizeAnsi(input)) {
    if (token.kind === "ansi") {
      continue;
    }
    for (const cluster of graphemes(token.value)) {
      if (cluster === "\t") {
        width += tabWidthAtColumn(width, tabSize);
        continue;
      }
      width += clusterWidth(cluster, options.ambiguousWidth ?? 1);
    }
  }
  return width;
}

export function truncateToColumns(
  input: string,
  columns: number,
  options: WidthOptions = {},
): string {
  if (columns <= 0) {
    return "";
  }

  const requestedMarker =
    displayWidth(input, options) > columns ? (options.overflowMarker ?? "") : "";
  const marker =
    displayWidth(requestedMarker, options) > columns
      ? truncateToColumns(requestedMarker, columns, { ...options, overflowMarker: "" })
      : requestedMarker;
  const markerWidth = displayWidth(marker, options);
  const target = marker === "" ? columns : Math.max(0, columns - markerWidth);
  const tabSize = normalizedTabSize(options.tabSize);
  let used = 0;
  let truncated = false;
  let output = "";

  for (const token of tokenizeAnsi(input)) {
    if (token.kind === "ansi") {
      output += token.value;
      continue;
    }

    for (const cluster of graphemes(token.value)) {
      const width =
        cluster === "\t"
          ? tabWidthAtColumn(used, tabSize)
          : clusterWidth(cluster, options.ambiguousWidth ?? 1);
      if (used + width > target) {
        truncated = true;
        break;
      }
      output += cluster === "\t" ? " ".repeat(width) : cluster;
      used += width;
    }

    if (truncated) {
      break;
    }
  }

  const result = truncated ? `${output}${marker}` : output;
  return needsSgrReset(result) ? `${result}${resetSequence}` : result;
}

export function wrapToColumns(
  input: string,
  columns: number,
  options: WidthOptions = {},
): string[] {
  if (columns <= 0) {
    return [""];
  }

  const lines: string[] = [];
  let current = "";
  let used = 0;
  const tabSize = normalizedTabSize(options.tabSize);

  for (const token of tokenizeAnsi(input)) {
    if (token.kind === "ansi") {
      current += token.value;
      continue;
    }

    for (const cluster of graphemes(token.value)) {
      if (cluster === "\n") {
        lines.push(current);
        current = "";
        used = 0;
        continue;
      }

      const width =
        cluster === "\t"
          ? tabWidthAtColumn(used, tabSize)
          : clusterWidth(cluster, options.ambiguousWidth ?? 1);
      if (used > 0 && used + width > columns) {
        lines.push(current);
        current = "";
        used = 0;
      }
      current += cluster === "\t" ? " ".repeat(width) : cluster;
      used += width;
    }
  }

  lines.push(current);
  return lines;
}

function normalizedTabSize(tabSize: number | undefined): number {
  const value = tabSize ?? 8;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError("tabSize must be a safe positive integer");
  }
  return value;
}

function tabWidthAtColumn(column: number, tabSize: number): number {
  return tabSize - (column % tabSize);
}

function clusterWidth(cluster: string, ambiguousWidth: 1 | 2): number {
  if (cluster.length === 0) {
    return 0;
  }
  if (markOnlyPattern.test(cluster)) {
    return 0;
  }
  if (keycapPattern.test(cluster) || regionalIndicatorPattern.test(cluster)) {
    return 2;
  }
  const textPresentation = cluster.includes(textPresentationSelector);
  if (
    !textPresentation &&
    (emojiPresentationPattern.test(cluster) ||
      (cluster.includes(emojiPresentationSelector) && emojiPattern.test(cluster)) ||
      (cluster.includes(zeroWidthJoiner) && extendedPictographicPattern.test(cluster)))
  ) {
    return 2;
  }

  let width = 0;
  for (const char of Array.from(cluster)) {
    const codePoint = char.codePointAt(0);
    if (codePoint === undefined) {
      continue;
    }
    if (codePoint === 0 || codePoint < 32 || (codePoint >= 0x7f && codePoint < 0xa0)) {
      continue;
    }
    if (markPattern.test(char) || defaultIgnorablePattern.test(char)) {
      continue;
    }
    if (unifiedIdeographPattern.test(char) || isInRanges(codePoint, wideRanges)) {
      width += 2;
      continue;
    }
    if (isInRanges(codePoint, ambiguousRanges)) {
      width += ambiguousWidth;
      continue;
    }
    width += 1;
  }
  return width;
}

function isInRanges(codePoint: number, ranges: readonly number[]): boolean {
  let low = 0;
  let high = ranges.length / 2 - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const start = ranges[middle * 2];
    const end = ranges[middle * 2 + 1];
    if (start === undefined || end === undefined) {
      return false;
    }
    if (codePoint < start) {
      high = middle - 1;
    } else if (codePoint > end) {
      low = middle + 1;
    } else {
      return true;
    }
  }
  return false;
}

function needsSgrReset(input: string): boolean {
  const state = emptySgrState();
  for (const token of tokenizeAnsi(input)) {
    if (token.kind !== "ansi" || !token.value.startsWith("\u001b[") || !token.value.endsWith("m")) {
      continue;
    }
    applySgrSequence(state, token.value);
  }
  return isSgrActive(state);
}

function applySgrSequence(state: SgrState, sequence: string): void {
  const body = sequence.slice(2, -1);
  const params = body === "" ? [0] : body.split(/[;:]/).map((part) => Number(part || 0));
  for (let index = 0; index < params.length; index += 1) {
    const param = params[index] ?? 0;
    if (param === 38 || param === 48 || param === 58) {
      applySgrParam(state, param);
      index += sgrExtendedColorParamCount(params, index + 1);
      continue;
    }
    applySgrParam(state, param);
  }
}

function sgrExtendedColorParamCount(params: readonly number[], modeIndex: number): number {
  const mode = params[modeIndex];
  if (mode === 2) {
    return 4;
  }
  if (mode === 5) {
    return 2;
  }
  return 0;
}

function applySgrParam(state: SgrState, param: number): void {
  if (param === 0) {
    resetSgrState(state);
    return;
  }
  if (param === 1 || param === 2) {
    state.intensity = true;
    return;
  }
  if (param === 3) {
    state.italic = true;
    return;
  }
  if (param === 4 || param === 21) {
    state.underline = true;
    return;
  }
  if (param === 5 || param === 6) {
    state.blink = true;
    return;
  }
  if (param === 7) {
    state.inverse = true;
    return;
  }
  if (param === 8) {
    state.conceal = true;
    return;
  }
  if (param === 9) {
    state.strike = true;
    return;
  }
  if (param === 53) {
    state.overline = true;
    return;
  }
  if (param === 38 || (param >= 30 && param <= 37) || (param >= 90 && param <= 97)) {
    state.foreground = true;
    return;
  }
  if (param === 48 || (param >= 40 && param <= 47) || (param >= 100 && param <= 107)) {
    state.background = true;
    return;
  }
  if (param === 58) {
    state.underlineColor = true;
    return;
  }
  if (param === 22) {
    state.intensity = false;
    return;
  }
  if (param === 23) {
    state.italic = false;
    return;
  }
  if (param === 24) {
    state.underline = false;
    return;
  }
  if (param === 25) {
    state.blink = false;
    return;
  }
  if (param === 27) {
    state.inverse = false;
    return;
  }
  if (param === 28) {
    state.conceal = false;
    return;
  }
  if (param === 29) {
    state.strike = false;
    return;
  }
  if (param === 39) {
    state.foreground = false;
    return;
  }
  if (param === 49) {
    state.background = false;
    return;
  }
  if (param === 55) {
    state.overline = false;
    return;
  }
  if (param === 59) {
    state.underlineColor = false;
  }
}

function emptySgrState(): SgrState {
  return {
    intensity: false,
    italic: false,
    underline: false,
    blink: false,
    inverse: false,
    conceal: false,
    strike: false,
    overline: false,
    foreground: false,
    background: false,
    underlineColor: false,
  };
}

function resetSgrState(state: SgrState): void {
  state.intensity = false;
  state.italic = false;
  state.underline = false;
  state.blink = false;
  state.inverse = false;
  state.conceal = false;
  state.strike = false;
  state.overline = false;
  state.foreground = false;
  state.background = false;
  state.underlineColor = false;
}

function isSgrActive(state: SgrState): boolean {
  return (
    state.intensity ||
    state.italic ||
    state.underline ||
    state.blink ||
    state.inverse ||
    state.conceal ||
    state.strike ||
    state.overline ||
    state.foreground ||
    state.background ||
    state.underlineColor
  );
}
