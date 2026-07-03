import { deepStrictEqual } from "node:assert";
import test from "node:test";

function applySimpleLiveOutput(chunks: readonly string[]): string[] {
  const lines: string[] = [];
  let cursor = 0;

  for (const chunk of chunks) {
    for (const part of tokenizeScreen(chunk)) {
      if (part === "" || part === "\r" || part === "\u001b[0m") {
        continue;
      }
      if (part === "\u001b[1A") {
        cursor = Math.max(0, cursor - 1);
        continue;
      }
      if (part === "\u001b[2K") {
        lines[cursor] = "";
        continue;
      }
      if (part === "\n") {
        cursor += 1;
        continue;
      }
      lines[cursor] = `${lines[cursor] ?? ""}${part}`;
    }
  }

  return lines.filter((line) => line !== "");
}

function tokenizeScreen(chunk: string): string[] {
  const tokens: string[] = [];
  let index = 0;
  while (index < chunk.length) {
    const twoByte = chunk.slice(index, index + 2);
    const fourByte = chunk.slice(index, index + 4);
    if (fourByte === "\u001b[1A" || fourByte === "\u001b[2K") {
      tokens.push(fourByte);
      index += 4;
      continue;
    }
    if (twoByte === "\r\n") {
      tokens.push("\n");
      index += 2;
      continue;
    }
    const char = chunk[index];
    if (char === "\r" || char === "\n") {
      tokens.push(char);
      index += 1;
      continue;
    }
    let text = "";
    while (index < chunk.length) {
      const maybeControl = chunk.slice(index, index + 4);
      const current = chunk[index];
      if (
        maybeControl === "\u001b[1A" ||
        maybeControl === "\u001b[2K" ||
        current === "\r" ||
        current === "\n"
      ) {
        break;
      }
      text += current;
      index += 1;
    }
    tokens.push(text);
  }
  return tokens;
}

test("virtual screen model validates clear and redraw sequence", () => {
  const screen = applySimpleLiveOutput(["first\nsecond", "\r\u001b[2K\u001b[1A\r\u001b[2Knext"]);

  deepStrictEqual(screen, ["next"]);
});
