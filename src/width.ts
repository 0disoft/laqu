export interface WidthOptions {
  readonly ambiguousWidth?: 1 | 2;
  readonly tabSize?: number;
  readonly overflowMarker?: string;
}

export type AnsiToken =
  | { readonly kind: "ansi"; readonly value: string }
  | { readonly kind: "text"; readonly value: string };

// CSI, OSC, and common one-byte ESC sequences.
const ansiPattern = new RegExp(
  String.raw`\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\)|[@-Z\\-_])`,
  "g",
);

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

export function graphemes(input: string): string[] {
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  return Array.from(segmenter.segment(input), (segment) => segment.segment);
}

export function displayWidth(input: string, options: WidthOptions = {}): number {
  let width = 0;
  for (const token of tokenizeAnsi(input)) {
    if (token.kind === "ansi") {
      continue;
    }
    for (const cluster of graphemes(expandTabs(token.value, options.tabSize ?? 8))) {
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

  const marker = options.overflowMarker ?? "";
  const markerWidth = displayWidth(marker, options);
  const target = marker === "" ? columns : Math.max(0, columns - markerWidth);
  let used = 0;
  let truncated = false;
  let output = "";

  for (const token of tokenizeAnsi(input)) {
    if (token.kind === "ansi") {
      output += token.value;
      continue;
    }

    for (const cluster of graphemes(expandTabs(token.value, options.tabSize ?? 8))) {
      const width = clusterWidth(cluster, options.ambiguousWidth ?? 1);
      if (used + width > target) {
        truncated = true;
        break;
      }
      output += cluster;
      used += width;
    }

    if (truncated) {
      break;
    }
  }

  return truncated ? `${output}${marker}` : output;
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

  for (const token of tokenizeAnsi(input)) {
    if (token.kind === "ansi") {
      current += token.value;
      continue;
    }

    for (const cluster of graphemes(expandTabs(token.value, options.tabSize ?? 8))) {
      if (cluster === "\n") {
        lines.push(current);
        current = "";
        used = 0;
        continue;
      }

      const width = clusterWidth(cluster, options.ambiguousWidth ?? 1);
      if (used > 0 && used + width > columns) {
        lines.push(current);
        current = "";
        used = 0;
      }
      current += cluster;
      used += width;
    }
  }

  lines.push(current);
  return lines;
}

function expandTabs(input: string, tabSize: number): string {
  if (!input.includes("\t")) {
    return input;
  }
  return input.replaceAll("\t", " ".repeat(Math.max(1, tabSize)));
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
      (codePoint >= 0xffe0 && codePoint <= 0xffe6))
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
