<template>
  <div class="segment-time-preview" :style="rootStyle" aria-label="time preview">
    <svg class="segment-time-svg" :viewBox="`0 0 ${svgWidth} ${svgHeight}`" preserveAspectRatio="none" role="img">
      <g v-for="(glyph, index) in glyphs" :key="`${glyph.char}-${index}`" :transform="`translate(${glyph.x}, ${glyph.y})`">
        <rect
          v-for="segment in glyph.rects"
          :key="segment.id"
          :x="segment.x"
          :y="segment.y"
          :width="segment.w"
          :height="segment.h"
          :rx="segment.radius"
          :fill="color"
        />
      </g>
    </svg>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { formatPreviewTime, type PreviewTimeAlign } from "../services/templatePreview";

type SegmentRect = {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  radius: number;
};

type Glyph = {
  char: string;
  x: number;
  y: number;
  rects: SegmentRect[];
};

type Metrics = {
  fontSize: number;
  digitH: number;
  digitW: number;
  segTh: number;
  verticalH: number;
  colonW: number;
  spacing: number;
  spaceW: number;
};

const props = withDefaults(
  defineProps<{
    width?: number;
    height?: number;
    text?: string;
    format?: string;
    fontSize?: number;
    align?: PreviewTimeAlign;
    color?: string;
    background?: string;
    autoUpdate?: boolean;
  }>(),
  {
    width: 0,
    height: 0,
    text: "",
    format: "HH:mm",
    fontSize: 88,
    align: "right",
    color: "#111111",
    background: "transparent",
    autoUpdate: true,
  }
);

const now = ref(new Date());
let timer: ReturnType<typeof setInterval> | null = null;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function buildMetrics(fontSize: number): Metrics {
  const safeFont = Math.max(18, Math.round(fontSize));
  const digitH = safeFont;
  const digitW = Math.max(20, Math.round((safeFont * 3) / 5));
  let segTh = Math.max(2, Math.round(safeFont / 8));
  if (segTh * 3 >= digitH) {
    segTh = Math.max(2, Math.floor(digitH / 4));
  }
  const verticalH = Math.max(2, Math.floor((digitH - segTh * 3) / 2));
  const colonW = Math.max(8, segTh * 2);
  const spacing = Math.max(2, Math.round(safeFont / 10));
  return {
    fontSize: safeFont,
    digitH,
    digitW,
    segTh,
    verticalH,
    colonW,
    spacing,
    spaceW: spacing * 2,
  };
}

function classifyChar(ch: string): "digit" | "colon" | "space" {
  if (/^[0-9]$/.test(ch)) return "digit";
  if (ch === ":") return "colon";
  return "space";
}

function digitRects(ch: string, metrics: Metrics): SegmentRect[] {
  const x = 0;
  const y = 0;
  const { digitW, digitH, segTh, verticalH } = metrics;
  const rightX = x + digitW - segTh;
  const topY = y;
  const upperY = y + segTh;
  const middleY = y + segTh + verticalH;
  const lowerY = middleY + segTh;
  const bottomY = lowerY + verticalH;
  const radius = Math.max(1, Math.floor(segTh / 3));

  if (ch === "1") {
    let capW = Math.floor(digitW / 2);
    if (capW < segTh * 2) {
      capW = segTh * 2;
    }
    const capX = x + digitW - capW;
    return [
      { id: "bar", x: rightX, y: topY, w: segTh, h: digitH, radius },
      { id: "cap-top", x: capX, y: topY, w: capW, h: segTh, radius },
      { id: "cap-bottom", x: capX, y: bottomY, w: capW, h: segTh, radius },
    ];
  }

  const masks: Record<string, number> = {
    "0": 0x77,
    "2": 0x5d,
    "3": 0x6d,
    "4": 0x2e,
    "5": 0x6b,
    "6": 0x7b,
    "7": 0x25,
    "8": 0x7f,
    "9": 0x6f,
  };
  const mask = masks[ch] ?? 0;

  const segments: SegmentRect[] = [
    { id: "top", x, y: topY, w: digitW, h: segTh, radius },
    { id: "upper-left", x, y: upperY, w: segTh, h: verticalH, radius },
    { id: "upper-right", x: rightX, y: upperY, w: segTh, h: verticalH, radius },
    { id: "middle", x, y: middleY, w: digitW, h: segTh, radius },
    { id: "lower-left", x, y: lowerY, w: segTh, h: verticalH, radius },
    { id: "lower-right", x: rightX, y: lowerY, w: segTh, h: verticalH, radius },
    { id: "bottom", x, y: bottomY, w: digitW, h: segTh, radius },
  ];

  return segments.filter((_, index) => Boolean(mask & (1 << index)));
}

function colonRects(metrics: Metrics): SegmentRect[] {
  const dot = Math.max(3, metrics.segTh);
  const radius = Math.max(1, Math.floor(dot / 4));
  const topY = Math.floor(metrics.digitH / 3) - Math.floor(dot / 2);
  const bottomY = Math.floor((metrics.digitH * 2) / 3) - Math.floor(dot / 2);
  return [
    { id: "dot-top", x: 0, y: topY, w: dot, h: dot, radius },
    { id: "dot-bottom", x: 0, y: bottomY, w: dot, h: dot, radius },
  ];
}

const displayText = computed(() => {
  const fixed = String(props.text || "").trim();
  if (fixed) return fixed;
  return formatPreviewTime(props.format, now.value);
});

const boxWidth = computed(() => Math.max(1, Number(props.width || 0) || 1));
const boxHeight = computed(() => Math.max(1, Number(props.height || 0) || 1));

const layout = computed(() => {
  const text = displayText.value;
  const safeTarget = clamp(Number(props.fontSize || 88), 18, Math.max(18, boxHeight.value));
  const base = buildMetrics(safeTarget);
  const padX = Math.max(4, Math.round(base.fontSize / 10));
  const padY = Math.max(2, Math.round(base.fontSize / 10));

  const baseWidth = [...text].reduce((sum, ch) => {
    const kind = classifyChar(ch);
    if (kind === "digit") return sum + base.digitW;
    if (kind === "colon") return sum + base.colonW;
    return sum + base.spaceW;
  }, 0) + Math.max(0, text.length - 1) * base.spacing;

  const availW = Math.max(1, boxWidth.value - padX * 2);
  const availH = Math.max(1, boxHeight.value - padY * 2);
  const ratioW = baseWidth > 0 ? availW / baseWidth : 1;
  const ratioH = base.digitH > 0 ? availH / base.digitH : 1;
  const scale = clamp(Math.min(1, ratioW, ratioH), 0.35, 1);

  const metrics = buildMetrics(Math.max(18, Math.round(base.fontSize * scale)));
  const contentW = [...text].reduce((sum, ch) => {
    const kind = classifyChar(ch);
    if (kind === "digit") return sum + metrics.digitW;
    if (kind === "colon") return sum + metrics.colonW;
    return sum + metrics.spaceW;
  }, 0) + Math.max(0, text.length - 1) * metrics.spacing;

  const startX =
    props.align === "left"
      ? padX
      : props.align === "center"
      ? Math.max(padX, Math.round((boxWidth.value - contentW) / 2))
      : Math.max(padX, boxWidth.value - padX - contentW);
  const startY = Math.max(padY, Math.round((boxHeight.value - metrics.digitH) / 2));

  return {
    text,
    metrics,
    startX,
    startY,
  };
});

const glyphs = computed<Glyph[]>(() => {
  const list: Glyph[] = [];
  const text = layout.value.text;
  const metrics = layout.value.metrics;
  let cx = layout.value.startX;

  for (const ch of text) {
    const kind = classifyChar(ch);
    if (kind === "digit") {
      list.push({ char: ch, x: cx, y: layout.value.startY, rects: digitRects(ch, metrics) });
      cx += metrics.digitW;
    } else if (kind === "colon") {
      list.push({ char: ch, x: cx, y: layout.value.startY, rects: colonRects(metrics) });
      cx += metrics.colonW;
    } else {
      list.push({ char: ch, x: cx, y: layout.value.startY, rects: [] });
      cx += metrics.spaceW;
    }
    cx += metrics.spacing;
  }

  return list;
});

const svgWidth = computed(() => Math.max(1, boxWidth.value));
const svgHeight = computed(() => Math.max(1, boxHeight.value));

const rootStyle = computed(() => ({
  width: "100%",
  height: "100%",
  background: props.background,
}));

onMounted(() => {
  if (!props.autoUpdate) return;
  timer = setInterval(() => {
    now.value = new Date();
  }, 1000);
});

onBeforeUnmount(() => {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
});
</script>

<style scoped>
.segment-time-preview {
  display: block;
  overflow: hidden;
}

.segment-time-svg {
  width: 100%;
  height: 100%;
  display: block;
}
</style>
