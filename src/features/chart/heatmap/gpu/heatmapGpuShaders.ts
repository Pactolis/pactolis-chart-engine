// GLSL sources for the private, default-off GPU orderbook heatmap density
// prototype. The fragment stage reproduces the CPU canvas cell color contract
// (heatmapModel.ts): log-scale intensity, rounded palette channels and the
// 3-decimal alpha quantization, so GPU density matches the annotation oracle.
// No extension, no dependency and no public API surface; see heatmapGpuRenderer.ts.
import { buildHeatmapPaletteGlslBranch } from "../../../orderbook/heatmapModel.js";

export const HEATMAP_GPU_VERT_SRC = `#version 300 es
in vec4 a_rect; // per run (repeated on its 6 vertices): x, y, w, h in CSS pixels (top-left origin)
in vec3 a_run;  // per run: first cell index, signed cell count (+ indices grow downward, - upward), alpha scale
uniform vec2 u_resolution; // canvas size in CSS pixels
uniform float u_panOffsetX;
out float v_row;           // 0..count across the run, top to bottom
flat out vec3 v_run;
const vec2 QUAD_CORNERS[6] = vec2[6](
  vec2(0.0, 0.0), vec2(1.0, 0.0), vec2(1.0, 1.0),
  vec2(0.0, 0.0), vec2(1.0, 1.0), vec2(0.0, 1.0)
); // two triangles, same order as the former instanced unit quad
void main() {
  vec2 unit = QUAD_CORNERS[gl_VertexID % 6];
  vec2 pos = a_rect.xy + vec2(u_panOffsetX, 0.0) + unit * a_rect.zw;
  vec2 clip = (pos / u_resolution) * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0); // flip Y -> top-left origin
  v_row = unit.y * abs(a_run.y);
  v_run = a_run;
}`;

export const HEATMAP_GPU_FRAG_SRC = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D u_density;  // R32F: per-cell value in the active unit
uniform sampler2D u_validity; // R8: present-cell mask (absent buckets discard)
uniform float u_floor;
uniform float u_logSpan; // log10(max(ceiling, 2 * floor) / floor) when u_floor > 0; ceiling when u_floor <= 0
uniform float u_opacity;
uniform int u_palette;
in float v_row;
flat in vec3 v_run;
out vec4 fragColor;
void main() {
  // A run is a vertical stack of equal-height cells with consecutive grid
  // indices; the fragment's row inside the run selects its own cell, so it
  // paints exactly the pixels that cell's own quad would.
  int runCount = int(abs(v_run.y));
  int runRow = clamp(int(floor(v_row)), 0, runCount - 1);
  int cellIndex = int(v_run.x) + (v_run.y > 0.0 ? runRow : runCount - 1 - runRow);
  int gridWidth = textureSize(u_density, 0).x;
  ivec2 texel = ivec2(cellIndex % gridWidth, cellIndex / gridWidth);
  if (texelFetch(u_validity, texel, 0).r < 0.5) discard;
  float value = texelFetch(u_density, texel, 0).r;
  // Condition order matches the CPU heatmapIntensity contract exactly:
  // a non-positive value is never intense, even when the floor is 0,
  // so a present zero stays distinct from an absent bucket.
  float k = 0.0;
  if (!(value > 0.0)) {
    k = 0.0;
  } else if (u_floor > 0.0 && u_logSpan > 0.0) {
    k = clamp(log2(value / u_floor) * 0.30102999566398120 / u_logSpan, 0.0, 1.0);
  } else if (u_logSpan > 0.0) {
    k = clamp(log2(1.0 + (value / u_logSpan) * 100.0) * 0.30102999566398120 / 2.0043213737826426, 0.0, 1.0);
  } else {
    k = clamp(log2(1.0 + value) * 0.30102999566398120 / 8.0, 0.0, 1.0);
  }
  vec3 c0;
  vec3 c1;
  float a0;
  float a1;
  float t;
${buildHeatmapPaletteGlslBranch()}
  vec3 rgb = floor(c0 + (c1 - c0) * t + 0.5) / 255.0;
  float alpha = (a0 + (a1 - a0) * t) * v_run.z * clamp(u_opacity, 0.0, 1.0);
  fragColor = vec4(rgb, floor(alpha * 1000.0 + 0.5) / 1000.0);
}`;