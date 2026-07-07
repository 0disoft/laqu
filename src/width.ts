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

  const requestedMarker = options.overflowMarker ?? "";
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
  return Math.max(1, tabSize ?? 8);
}

function tabWidthAtColumn(column: number, tabSize: number): number {
  return tabSize - (column % tabSize);
}

function clusterWidth(cluster: string, ambiguousWidth: 1 | 2): number {
  if (cluster.length === 0) {
    return 0;
  }
  if (/^\p{Mark}+$/u.test(cluster)) {
    return 0;
  }
  if (cluster.includes("\u200d") || /\p{Extended_Pictographic}/u.test(cluster)) {
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
    if (isCombining(codePoint)) {
      continue;
    }
    if (isFullWidth(codePoint)) {
      width += 2;
      continue;
    }
    if (isAmbiguous(codePoint)) {
      width += ambiguousWidth;
      continue;
    }
    width += 1;
  }
  return width;
}

function isCombining(codePoint: number): boolean {
  return (
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
    (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
    (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
    (codePoint >= 0xe0100 && codePoint <= 0xe01ef) ||
    (codePoint >= 0xfe20 && codePoint <= 0xfe2f)
  );
}

function isFullWidth(codePoint: number): boolean {
  return (
    codePoint >= 0x1100 &&
    (codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x20000 && codePoint <= 0x3fffd))
  );
}

function isAmbiguous(codePoint: number): boolean {
  return (
    (codePoint >= 0x00a1 && codePoint <= 0x00ff) ||
    (codePoint >= 0x2010 && codePoint <= 0x2027) ||
    (codePoint >= 0x2121 && codePoint <= 0x22ff) ||
    (codePoint >= 0x2460 && codePoint <= 0x24ff)
  );
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
