<template>
  <div class="segment-time-preview" :style="rootStyle" aria-label="time preview">
    <svg
      class="segment-time-svg"
      :viewBox="`0 0 ${svgWidth} ${svgHeight}`"
      preserveAspectRatio="none"
      role="img"
    >
      <rect v-if="background !== 'transparent'" x="0" y="0" :width="svgWidth" :height="svgHeight" :fill="background" />
      <g v-for="(glyph, index) in glyphs" :key="`${glyph.char}-${index}`" :transform="`translate(${glyph.x}, ${glyph.y})`">
        <g v-if="glyph.kind === 'digit'">
          <rect
            v-for="segment in glyph.segments"
            :key="segment.id"
            :x="segment.x"
            :y="segment.y"
            :width="segment.w"
            :height="segment.h"
            :rx="segment.radius"
            :fill="color"
          />
        </g>
        <g v-else-if="glyph.kind === 'colon'">
          <rect
            v-for="dot in glyph.dots"
            :key="dot.id"
            :x="dot.x"
            :y="dot.y"
            :width="dot.w"
            :height="dot.h"
            :rx="dot.radius"
            :fill="color"
          />
        </g>
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
  kind: "digit" | "colon" | "space";
  x: number;
  y: number;
  segments: SegmentRect[];
  dots: SegmentRect[];
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

function digitSegments(x: number, y: number, digitW: number, digitH: number, thick: number): SegmentRect[] {
  const innerW = Math.max(1, digitW - thick * 2);
  const vH = Math.max(1, Math.floor((digitH - thick * 3) / 2));
  const bottomY = digitH - thick;
  const middleY = thick + vH;
  const lowerY = thick * 2 + vH;
  const radius = Math.max(1, Math.floor(thick / 3));

  return [
    { id: "a", x: x + thick, y: y, w: innerW, h: thick, radius },
    { id: "b", x: x, y: y + thick, w: thick, h: vH, radius },
    { id: "c", x: x + digitW - thick, y: y + thick, w: thick, h: vH, radius },
    { id: "d", x: x + thick, y: y + middleY, w: innerW, h: thick, radius },
    { id: "e", x: x, y: y + lowerY, w: thick, h: vH, radius },
    { id: "f", x: x + digitW - thick, y: y + lowerY, w: thick, h: vH, radius },
    { id: "g", x: x + thick, y: y + bottomY, w: innerW, h: thick, radius },
  ];
}

function colonDots(x: number, y: number, digitH: number, thick: number): SegmentRect[] {
  const dot = Math.max(2, Math.round(thick * 1.15));
  const radius = Math.max(1, Math.floor(dot / 4));
  const topY = y + Math.floor(digitH / 3) - Math.floor(dot / 2);
  const bottomY = y + Math.floor((digitH * 2) / 3) - Math.floor(dot / 2);
  return [
    { id: "top", x: x, y: topY, w: dot, h: dot, radius },
    { id: "bottom", x: x, y: bottomY, w: dot, h: dot, radius },
  ];
}

function classifyChar(ch: string): Glyph["kind"] {
  if (/^[0-9]$/.test(ch)) return "digit";
  if (ch === ":") return "colon";
  return "space";
}

const displayText = computed(() => {
  const fixed = String(props.text || "").trim();
  if (fixed) return fixed;
  return formatPreviewTime(props.format, now.value);
});

const boxWidth = computed(() => Math.max(1, Number(props.width || 0) || 0));
const boxHeight = computed(() => Math.max(1, Number(props.height || 0) || 0));

const layout = computed(() => {
  const rawText = displayText.value;
  const baseFont = clamp(Number(props.fontSize || 88), 16, Math.max(16, boxHeight.value || 88));
  const baseThick = Math.max(3, Math.round(baseFont / 7));
  const baseDigitW = Math.max(18, Math.round(baseFont * 0.62));
  const baseColonW = Math.max(8, Math.round(baseThick * 1.5));
  const baseSpaceW = Math.max(8, Math.round(baseThick * 1.2));
  const baseGap = Math.max(3, Math.round(baseThick * 0.6));
  const padX = Math.max(6, Math.round(baseFont / 6));
  const padY = Math.max(4, Math.round(baseFont / 6));

  const measure = [...rawText].reduce((sum, ch) => {
    const kind = classifyChar(ch);
    if (kind === "digit") return sum + baseDigitW;
    if (kind === "colon") return sum + baseColonW;
    return sum + baseSpaceW;
  }, 0);
  const gapCount = Math.max(0, rawText.length - 1);
  const needW = measure + gapCount * baseGap;
  const needH = baseFont;
  const availW = Math.max(1, boxWidth.value - padX * 2);
  const availH = Math.max(1, boxHeight.value - padY * 2);
  const ratioW = needW > 0 ? availW / needW : 1;
  const ratioH = needH > 0 ? availH / needH : 1;
  const scale = clamp(Math.min(1, ratioW, ratioH), 0.35, 1);

  const fontSize = Math.max(16, Math.round(baseFont * scale));
  const thick = Math.max(3, Math.round(baseThick * scale));
  const digitW = Math.max(16, Math.round(baseDigitW * scale));
  const colonW = Math.max(8, Math.round(baseColonW * scale));
  const spaceW = Math.max(8, Math.round(baseSpaceW * scale));
  const gap = Math.max(2, Math.round(baseGap * scale));
  const contentW = [...rawText].reduce((sum, ch) => {
    const kind = classifyChar(ch);
    if (kind === "digit") return sum + digitW;
    if (kind === "colon") return sum + colonW;
    return sum + spaceW;
  }, 0) + Math.max(0, rawText.length - 1) * gap;

  const innerH = Math.max(fontSize, 16);
  const align = props.align;
  const startX = align === "left" ? padX : align === "center" ? Math.max(padX, Math.round((boxWidth.value - contentW) / 2)) : Math.max(padX, boxWidth.value - padX - contentW);
  const startY = Math.max(padY, Math.round((boxHeight.value - innerH) / 2));

  return {
    text: rawText,
    fontSize,
    thick,
    digitW,
    colonW,
    spaceW,
    gap,
    startX,
    startY,
    innerH,
  };
});

const glyphs = computed<Glyph[]>(() => {
  const items: Glyph[] = [];
  let cx = layout.value.startX;
  const y = layout.value.startY;
  const text = layout.value.text;
  for (const ch of text) {
    const kind = classifyChar(ch);
    if (kind === "digit") {
      const masks: Record<string, number> = {
        "0": 0x77,
        "1": 0x24,
        "2": 0x5d,
        "3": 0x6d,
        "4": 0x2e,
        "5": 0x6b,
        "6": 0x7b,
        "7": 0x25,
        "8": 0x7f,
        "9": 0x6f,
      };
      const mask = masks[ch] || 0;
      const segments = digitSegments(cx, y, layout.value.digitW, layout.value.innerH, layout.value.thick).filter((seg, idx) => Boolean(mask & (1 << idx)));
      items.push({ char: ch, kind, x: cx, y, segments, dots: [] });
      cx += layout.value.digitW;
    } else if (kind === "colon") {
      items.push({ char: ch, kind, x: cx, y, segments: [], dots: colonDots(cx, y, layout.value.innerH, layout.value.thick) });
      cx += layout.value.colonW;
    } else {
      items.push({ char: ch, kind, x: cx, y, segments: [], dots: [] });
      cx += layout.value.spaceW;
    }
    cx += layout.value.gap;
  }
  return items;
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
