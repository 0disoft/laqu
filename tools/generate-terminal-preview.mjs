import { writeFileSync } from "node:fs";

import { AnsiLiveRenderer } from "../dist/renderer.js";
import { TaskStore } from "../dist/task-store.js";
import { compileTheme } from "../dist/theme.js";
import { displayWidth, stripAnsi, tokenizeAnsi } from "../dist/width.js";

// Run after `bun run build`; the renderer owns spacing, bars, and the package version.
const store = new TaskStore();
store.createTask("install packages", { total: 100, completed: 76, message: "downloading" });
store.createTask("build artifacts", { total: 100, completed: 49, message: "bundling" });
store.createTask("publish preview", { total: 100, completed: 0, message: "waiting" });
const frame = new AnsiLiveRenderer(compileTheme(), 100, 8).render(store.snapshot());
if (frame.kind !== "live") throw new Error("Expected the live renderer's preview frame");

const foreground = "#e6edf5";
const muted = "#71869e";
const colors = { 31: "#ff7b72", 32: "#7ee787", 33: "#e3b341", 36: "#25dceb" };
const cellWidth = 11;
function escapeXml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

const rows = frame.lines.map((line, row) => {
  let column = 0;
  let color = foreground;
  const elements = [];
  const y = 100 + row * 30;
  for (const token of tokenizeAnsi(line)) {
    if (token.kind === "ansi") {
      for (const code of token.value.slice(2, -1).split(";").map(Number)) {
        if (code === 0) color = foreground;
        else if (code === 2) color = muted;
        else if (colors[code] !== undefined) color = colors[code];
      }
      continue;
    }
    // Position non-space runs independently: SVG whitespace collapsing cannot move a bracket.
    for (const match of token.value.matchAll(/\S+/gu)) {
      let x = 36 + (column + displayWidth(token.value.slice(0, match.index))) * cellWidth;
      const width = displayWidth(match[0]) * cellWidth;
      if (/^(?:█+|─+)$/u.test(match[0])) {
        const rule = match[0][0] === "─";
        elements.push(
          `<rect x="${x}" y="${y - (rule ? 6 : 17)}" width="${width}" height="${rule ? 1 : 20}" fill="${color}"/>`,
        );
      } else {
        for (const glyph of match[0]) {
          elements.push(`<text x="${x}" y="${y}" fill="${color}">${escapeXml(glyph)}</text>`);
          x += displayWidth(glyph) * cellWidth;
        }
      }
    }
    column += displayWidth(token.value);
  }
  return `    <g>${elements.join("")}</g>`;
});

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="340" viewBox="0 0 1200 340" role="img" aria-labelledby="title description">
  <title id="title">Laqu live column ledger</title>
  <desc id="description">Generated from the live renderer at 100 terminal columns. All three progress bars and their opening brackets align with the PROGRESS header. Terminal colors depend on the caller's theme.</desc>
  <rect width="1200" height="340" rx="12" fill="#0c1520"/>
  <g font-family="Consolas, ui-monospace, monospace" font-size="18">
    <text x="36" y="44" fill="#9bafc5">$ node examples/basic.mjs</text>
${rows.join("\n")}
  </g>
</svg>
`;
writeFileSync(new URL("../media/terminal-preview.svg", import.meta.url), svg);
console.log(frame.lines.map(stripAnsi).join("\n"));
