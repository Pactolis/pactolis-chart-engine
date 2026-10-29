import { incrementPerformanceCounter } from "../performanceTelemetry.js";
// Batched colored-quad renderer. Accepts rectangles in CSS-pixel space
// (origin top-left) and draws them in one instanced draw call per flush.
import { createProgram, type RGBA } from "./gl.js";
import type { QuadSink } from "../gpu/gpuBackend.js";

const VERT_SRC = `#version 300 es
in vec2 a_unit;       // static unit-quad corner (0..1)
in vec4 a_rect;        // instance: x, y, w, h (pixel coords, top-left origin)
in vec4 a_color;       // instance: r, g, b, a
uniform vec2 u_resolution;  // canvas size in CSS pixels
out vec4 v_color;
void main() {
  vec2 pos = a_rect.xy + a_unit * a_rect.zw;
  vec2 clip = (pos / u_resolution) * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0); // flip Y -> top-left origin
  v_color = a_color;
}`;

const FRAG_SRC = `#version 300 es
precision mediump float;
in vec4 v_color;
out vec4 fragColor;
void main() {
  fragColor = v_color;
}`;

const FLOATS_PER_INSTANCE = 8; // rect.x, rect.y, rect.w, rect.h, r, g, b, a
const UNIT_QUAD = new Float32Array([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1]); // two triangles

export class QuadBatch implements QuadSink {
  private readonly program: WebGLProgram;
  private readonly vao: WebGLVertexArrayObject;
  private readonly unitBuffer: WebGLBuffer;
  private readonly instanceBuffer: WebGLBuffer;
  private readonly uResolution: WebGLUniformLocation;

  private data: Float32Array;
  private gpuCapacityBytes = 0;
  private count = 0; // number of instances (rects) queued
  private disposed = false;

  constructor(private readonly gl: WebGL2RenderingContext, capacityQuads = 20000) {
    let program: WebGLProgram | null = null;
    let vao: WebGLVertexArrayObject | null = null;
    let unitBuffer: WebGLBuffer | null = null;
    let instanceBuffer: WebGLBuffer | null = null;
    try {
      program = createProgram(gl, VERT_SRC, FRAG_SRC);
      const aUnit = gl.getAttribLocation(program, "a_unit");
      const aRect = gl.getAttribLocation(program, "a_rect");
      const aColor = gl.getAttribLocation(program, "a_color");
      const uResolution = gl.getUniformLocation(program, "u_resolution");
      if (!uResolution) throw new Error("Failed to locate u_resolution uniform");

      vao = gl.createVertexArray();
      if (!vao) throw new Error("Failed to create vertex array object");

      unitBuffer = gl.createBuffer();
      if (!unitBuffer) throw new Error("Failed to create buffer");

      instanceBuffer = gl.createBuffer();
      if (!instanceBuffer) throw new Error("Failed to create buffer");

      this.program = program;
      this.uResolution = uResolution;
      this.vao = vao;
      this.unitBuffer = unitBuffer;
      this.instanceBuffer = instanceBuffer;
      this.data = new Float32Array(capacityQuads * FLOATS_PER_INSTANCE);

      gl.bindVertexArray(this.vao);

      gl.bindBuffer(gl.ARRAY_BUFFER, this.unitBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, UNIT_QUAD, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(aUnit);
      gl.vertexAttribPointer(aUnit, 2, gl.FLOAT, false, 0, 0);

      gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
      this.gpuCapacityBytes = this.data.byteLength;
      gl.bufferData(gl.ARRAY_BUFFER, this.gpuCapacityBytes, gl.DYNAMIC_DRAW);
      const stride = FLOATS_PER_INSTANCE * 4;
      gl.enableVertexAttribArray(aRect);
      gl.vertexAttribPointer(aRect, 4, gl.FLOAT, false, stride, 0);
      gl.vertexAttribDivisor(aRect, 1);
      gl.enableVertexAttribArray(aColor);
      gl.vertexAttribPointer(aColor, 4, gl.FLOAT, false, stride, 4 * 4);
      gl.vertexAttribDivisor(aColor, 1);

      gl.bindVertexArray(null);
    } catch (error) {
      gl.bindVertexArray(null);
      if (instanceBuffer) gl.deleteBuffer(instanceBuffer);
      if (unitBuffer) gl.deleteBuffer(unitBuffer);
      if (vao) gl.deleteVertexArray(vao);
      if (program) gl.deleteProgram(program);
      throw error;
    }
  }

  begin(): void {
    if (this.disposed) return;
    this.count = 0;
  }

  /** Queue an axis-aligned rectangle (CSS pixels). */
  rect(x: number, y: number, w: number, h: number, c: RGBA): void {
    if (this.disposed) return;
    const need = (this.count + 1) * FLOATS_PER_INSTANCE;
    if (need > this.data.length) this.grow(need);

    const o = this.count * FLOATS_PER_INSTANCE;
    this.data[o] = x;
    this.data[o + 1] = y;
    this.data[o + 2] = w;
    this.data[o + 3] = h;
    this.data[o + 4] = c.r;
    this.data[o + 5] = c.g;
    this.data[o + 6] = c.b;
    this.data[o + 7] = c.a;
    this.count++;
  }

  private grow(min: number): void {
    let size = this.data.length * 2;
    while (size < min) size *= 2;
    const next = new Float32Array(size);
    next.set(this.data);
    this.data = next;
  }

  flush(canvasWidth: number, canvasHeight: number): void {
    const gl = this.gl;
    if (this.disposed || this.count === 0) return;

    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    if (this.data.byteLength > this.gpuCapacityBytes) {
      this.gpuCapacityBytes = this.data.byteLength;
      gl.bufferData(gl.ARRAY_BUFFER, this.gpuCapacityBytes, gl.DYNAMIC_DRAW);
    }
    const upload = this.data.subarray(0, this.count * FLOATS_PER_INSTANCE);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, upload);
    incrementPerformanceCounter("gpu.upload.bytes", upload.byteLength);

    gl.uniform2f(this.uResolution, canvasWidth, canvasHeight);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.count);

    gl.bindVertexArray(null);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.count = 0;
    this.gl.deleteVertexArray(this.vao);
    this.gl.deleteBuffer(this.unitBuffer);
    this.gl.deleteBuffer(this.instanceBuffer);
    this.gl.deleteProgram(this.program);
  }
}
