/**
 * demo 帧渲染：把 capture.json 的真实行排成打字动画的 SVG 帧。
 * 只做排版与逐字揭示，不改写文案；字体是系统等宽（Noto Sans Mono + CJK 回退），白底、深色文字、细圆角边框。
 *
 * 用法：bun scripts/demo/render.ts --out <dir>
 * 输出：<dir>/frame0001.svg …（帧数写进 stdout，交给 build.sh 转 PNG 再合成 GIF）
 */
import * as fs from "node:fs";
import * as path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname);
/** 必须与 build.sh 的 ffmpeg -framerate 一致；打字速度按「帧」计而不是按毫秒 */
const FPS = 12;
const CHARS_PER_FRAME = 3;
const FINAL_HOLD_SECONDS = 1.5;
const WIDTH = 900;
const FONT_SIZE = 17;
/** Noto Sans Mono 的 ASCII 步进是 0.6em，CJK 回退（Noto Sans CJK）是全宽 1.0em——按码位估算行宽 */
const ASCII_EM = 0.6;
const WIDE_EM = 1;
const FONT_FAMILY = "Noto Sans Mono";
const INNER_X = 34;
const PAD_TOP = 36;
const LINE_H = 29;
const BORDER = {
  inset: 8,
  radius: 8,
  stroke: "#d0d7de",
};
const COLOR = {
  bg: "#ffffff",
  text: "#1f2328",
  dim: "#57606a",
  cursor: "#7d8590",
};

type Capture = {
  remember: { prompt: string; lines: string[] };
  brief: { prompt: string; heading: string; lines: string[] };
};
/** prompt 行以 `>` 起头；gap 行只占位（分段留白）；heading 是简报节标题，压暗 */
type Role = "prompt" | "result" | "heading" | "gap";
type Row = { role: Role; text: string; pause: number };

const WIDE_RE =
  /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE10-\uFE19\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/;

function measure(text: string, size = FONT_SIZE): number {
  let w = 0;
  for (const ch of text) w += size * (WIDE_RE.test(ch) ? WIDE_EM : ASCII_EM);
  return w;
}

function rowsOf(cap: Capture): Row[] {
  const out: Row[] = [
    { role: "prompt", text: cap.remember.prompt, pause: 5 },
    { role: "gap", text: "", pause: 0 },
  ];
  cap.remember.lines.forEach((text, i) => out.push({ role: "result", text, pause: i === cap.remember.lines.length - 1 ? 8 : 3 }));
  out.push({ role: "gap", text: "", pause: 0 });
  out.push({ role: "prompt", text: cap.brief.prompt, pause: 5 });
  out.push({ role: "gap", text: "", pause: 0 });
  if (cap.brief.heading) out.push({ role: "heading", text: cap.brief.heading, pause: 3 });
  cap.brief.lines.forEach((text) => out.push({ role: "result", text, pause: 4 }));
  return out;
}

/** 逐字揭示的时间表：{active, chars} = 第 active 行已显示 chars 个字，之前的行整行可见 */
function framesOf(rows: Row[]): Array<{ active: number; chars: number }> {
  const frames: Array<{ active: number; chars: number }> = [];
  rows.forEach((row, i) => {
    if (row.role === "gap") return;
    const len = [...row.text].length;
    for (let c = CHARS_PER_FRAME; c < len; c += CHARS_PER_FRAME) frames.push({ active: i, chars: c });
    frames.push({ active: i, chars: len });
    for (let p = 0; p < row.pause; p++) frames.push({ active: i, chars: len });
  });
  const last = rows.length - 1;
  for (let p = 0; p < Math.round(FINAL_HOLD_SECONDS * FPS); p++) frames.push({ active: last, chars: [...rows[last].text].length });
  return frames;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function frameSvg(rows: Row[], active: number, chars: number, height: number): string {
  const parts: string[] = [];
  const borderX = BORDER.inset;
  const borderY = BORDER.inset;
  parts.push(`<rect x="0" y="0" width="${WIDTH}" height="${height}" fill="${COLOR.bg}"/>`);
  parts.push(
    `<rect x="${borderX}" y="${borderY}" width="${WIDTH - borderX * 2}" height="${height - borderY * 2}" rx="${BORDER.radius}" fill="${COLOR.bg}" stroke="${BORDER.stroke}" stroke-width="1"/>`,
  );
  let cursorX = INNER_X;
  let cursorY = 0;
  rows.forEach((row, i) => {
    if (row.role === "gap" || i > active) return;
    const y = PAD_TOP + i * LINE_H;
    const text = i === active ? [...row.text].slice(0, chars).join("") : row.text;
    if (row.role === "prompt") {
      const prefixW = measure("> ");
      parts.push(`<text x="${INNER_X}" y="${y}" font-family="${FONT_FAMILY}" font-size="${FONT_SIZE}" fill="${COLOR.dim}">&gt;</text>`);
      if (text) parts.push(`<text x="${INNER_X + prefixW}" y="${y}" font-family="${FONT_FAMILY}" font-size="${FONT_SIZE}" fill="${COLOR.text}">${esc(text)}</text>`);
      cursorX = INNER_X + prefixW + measure(text);
    } else {
      const fill = row.role === "heading" ? COLOR.dim : COLOR.text;
      if (text) parts.push(`<text x="${INNER_X}" y="${y}" font-family="${FONT_FAMILY}" font-size="${FONT_SIZE}" fill="${fill}">${esc(text)}</text>`);
      cursorX = INNER_X + measure(text);
    }
    if (i === active) cursorY = y;
  });
  const cursorTop = cursorY - Math.round(FONT_SIZE * 0.82);
  parts.push(
    `<rect x="${Math.round(cursorX + 1)}" y="${cursorTop}" width="${Math.round(FONT_SIZE * 0.5)}" height="${FONT_SIZE}" rx="1" fill="${COLOR.cursor}"/>`,
  );
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}">\n${parts.join("\n")}\n</svg>\n`;
}

function main(argv: string[]): void {
  const at = argv.indexOf("--out");
  if (at < 0 || !argv[at + 1]) throw new Error("用法：bun scripts/demo/render.ts --out <dir>");
  const outDir = path.resolve(argv[at + 1]);
  const cap = JSON.parse(fs.readFileSync(path.join(HERE, "capture.json"), "utf8")) as Capture;
  const rows = rowsOf(cap);
  const frames = framesOf(rows);

  // 画布宽度固定 900：等宽字体下先按 15px 量整行，最长的那行放不下就整体缩小（不换行，保住原文）
  const longest = Math.max(...rows.filter((r) => r.role !== "gap").map((r) => measure(r.text) + (r.role === "prompt" ? measure("> ") : 0)));
  const innerWidth = WIDTH - INNER_X * 2;
  if (longest > innerWidth) throw new Error(`有一行宽 ${Math.round(longest)}px，超过可用宽度 ${innerWidth}px：请缩短 demo 文案`);
  const height = PAD_TOP + rows.length * LINE_H + 8;

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  frames.forEach((f, i) => {
    const name = `frame${String(i + 1).padStart(4, "0")}.svg`;
    fs.writeFileSync(path.join(outDir, name), frameSvg(rows, f.active, f.chars, height));
  });
  console.log(`frames=${frames.length} svg=${WIDTH}x${height} seconds=${(frames.length / FPS).toFixed(1)} font=${FONT_SIZE}px out=${outDir}`);
}

main(process.argv.slice(2));
