#!/usr/bin/env bash
# demo GIF 合成：capture（真实输出，可选）→ SVG 帧 → rsvg-convert 转 PNG → ffmpeg 调色板合成。
# 可重跑；帧目录建在临时目录里，跑完即清，仓内不留中间产物。
#
#   bun scripts/demo/capture.ts     # 改了 demo 文案或扩展输出时先跑一次（capture.json 会进 git）
#   bash scripts/demo/build.sh      # → docs/img/08-demo.gif（900px 宽、12fps、≤15s、≤1.5MB）
#
# 环境没有 vhs/agg/gifsicle/ImageMagick，所以走 rsvg-convert + ffmpeg 这条现成链路。
set -euo pipefail
cd "$(dirname "$0")/../.."

FRAMES="$(mktemp -d "${TMPDIR:-/tmp}/pi-lm-demo-frames-XXXXXX")"
trap 'rm -rf "$FRAMES"' EXIT

bun scripts/demo/render.ts --out "$FRAMES"

for svg in "$FRAMES"/frame*.svg; do
  rsvg-convert -w 900 "$svg" -o "${svg%.svg}.png"
done

mkdir -p docs/img
ffmpeg -v error -y -framerate 12 -i "$FRAMES/frame%04d.png" \
  -vf "split[s0][s1];[s0]palettegen=max_colors=64[p];[s1][p]paletteuse" \
  -loop 0 docs/img/08-demo.gif

ls -l docs/img/08-demo.gif
