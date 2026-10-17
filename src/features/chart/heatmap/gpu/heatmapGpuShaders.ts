// GLSL sources for the private, default-off GPU orderbook heatmap density
// prototype. The fragment stage reproduces the CPU canvas cell color contract
// (heatmapModel.ts): log-scale intensity, rounded palette channels and the
// 3-decimal alpha quantization, so GPU density matches the annotation oracle.
// No extension, no dependency and no public API surface; see heatmapGpuRenderer.ts.
export const HEATMAP_GPU_VERT_SRC = `#version 300 es
in vec2 a_unit;        // static unit-quad corner (0..1)
in vec4 a_rect;        // instance: x, y, w, h in CSS pixels (top-left origin)
in vec2 a_texel;       // instance: density/validity grid coordinate [0..1]
in float a_alphaScale; // instance: 1.0 main column, 0.45 live-bar extension
uniform vec2 u_resolution; // canvas size in CSS pixels
out vec2 v_texel;
out float v_alphaScale;
void main() {
  vec2 pos = a_rect.xy + a_unit * a_rect.zw;
  vec2 clip = (pos / u_resolution) * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0); // flip Y -> top-left origin
  v_texel = a_texel;
  v_alphaScale = a_alphaScale;
}`;

export const HEATMAP_GPU_FRAG_SRC = `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D u_density;  // R32F: per-cell value in the active unit
uniform sampler2D u_validity; // R8: present-cell mask (absent buckets discard)
uniform float u_threshold;
uniform float u_logSpan; // log10(max(ceiling, 2 * threshold) / threshold)
in vec2 v_texel;
in float v_alphaScale;
out vec4 fragColor;
void main() {
  if (texture(u_validity, v_texel).r < 0.5) discard;
  float value = texture(u_density, v_texel).r;
  // Condition order matches the CPU heatmapIntensity contract exactly:
  // a non-positive value is never intense, even when the threshold is 0,
  // so a present zero stays distinct from an absent bucket.
  float k = 0.0;
  if (!(value > 0.0)) {
    k = 0.0;
  } else if (!(u_threshold > 0.0)) {
    k = 1.0; // heatmapIntensity: positive value, no threshold -> full intensity
  } else if (u_logSpan > 0.0) {
    k = clamp(log2(value / u_threshold) * 0.30102999566398120 / u_logSpan, 0.0, 1.0);
  }
  float r = floor(125.0 + (29.0 - 125.0) * k + 0.5) / 255.0;
  float g = floor(211.0 + (78.0 - 211.0) * k + 0.5) / 255.0;
  float b = floor(252.0 + (216.0 - 252.0) * k + 0.5) / 255.0;
  float alpha = (0.28 + (0.95 - 0.28) * k) * v_alphaScale;
  fragColor = vec4(r, g, b, floor(alpha * 1000.0 + 0.5) / 1000.0);
}`;