import type { HeatmapLayer } from "../gpuBackend.js";

const HEATMAP_VS = `#version 300 es
in vec2 a_position;
uniform vec2 u_resolution;
uniform vec4 u_rect;
out vec2 v_uv;

void main() {
  vec2 pos = u_rect.xy + a_position * u_rect.zw;
  vec2 clip = (pos / u_resolution) * 2.0 - 1.0;
  gl_Position = vec4(clip.x, 1.0 - (pos.y / u_resolution.y) * 2.0, 0.0, 1.0);
  v_uv = a_position;
}
`;

const HEATMAP_FS = `#version 300 es
precision highp float;
uniform sampler2D u_texture;
uniform float u_opacity;
in vec2 v_uv;
out vec4 fragColor;

void main() {
  vec4 col = texture(u_texture, v_uv);
  fragColor = vec4(col.rgb, col.a * u_opacity);
}
`;

export class WebGl2HeatmapLayer implements HeatmapLayer {
  readonly kind = "webgl2" as const;

  private texture: WebGLTexture | null = null;
  private width = 0;
  private height = 0;
  private program: WebGLProgram | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private vbo: WebGLBuffer | null = null;
  private uResolution: WebGLUniformLocation | null = null;
  private uRect: WebGLUniformLocation | null = null;
  private uOpacity: WebGLUniformLocation | null = null;
  private uTexture: WebGLUniformLocation | null = null;
  private disposed = false;

  constructor(private readonly gl: WebGL2RenderingContext) {}

  private ensureInitialized(): boolean {
    if (this.disposed || !this.gl) return false;
    if (this.program && this.vao) return true;

    try {
      this.initShaders();
      this.initBuffers();
      return Boolean(this.program && this.vao);
    } catch (err) {
      console.warn("[WebGl2HeatmapLayer] lazy initialization error:", err);
      return false;
    }
  }

  private initShaders(): void {
    const gl = this.gl;
    const vs = gl.createShader(gl.VERTEX_SHADER);
    if (!vs) return;
    gl.shaderSource(vs, HEATMAP_VS);
    gl.compileShader(vs);

    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    if (!fs) return;
    gl.shaderSource(fs, HEATMAP_FS);
    gl.compileShader(fs);

    const program = gl.createProgram();
    if (!program) return;
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);

    gl.deleteShader(vs);
    gl.deleteShader(fs);

    this.program = program;
    this.uResolution = gl.getUniformLocation(program, "u_resolution");
    this.uRect = gl.getUniformLocation(program, "u_rect");
    this.uOpacity = gl.getUniformLocation(program, "u_opacity");
    this.uTexture = gl.getUniformLocation(program, "u_texture");
  }

  private initBuffers(): void {
    const gl = this.gl;
    if (typeof gl.createVertexArray !== "function") return;

    this.vao = gl.createVertexArray();
    this.vbo = gl.createBuffer();

    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);

    const quadVerts = new Float32Array([
      0, 0,
      1, 0,
      1, 1,
      0, 0,
      1, 1,
      0, 1,
    ]);
    gl.bufferData(gl.ARRAY_BUFFER, quadVerts, gl.STATIC_DRAW);

    const aPosition = this.program ? gl.getAttribLocation(this.program, "a_position") : 0;
    if (aPosition >= 0) {
      gl.enableVertexAttribArray(aPosition);
      gl.vertexAttribPointer(aPosition, 2, gl.FLOAT, false, 0, 0);
    }

    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }

  upload(width: number, height: number, data: Uint8Array | Float32Array): void {
    if (this.disposed || !this.gl) return;
    if (!this.ensureInitialized()) return;
    this.width = width;
    this.height = height;

    const gl = this.gl;
    if (!this.texture && typeof gl.createTexture === "function") {
      this.texture = gl.createTexture();
    }
    if (!this.texture) return;

    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    if (data instanceof Float32Array) {
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.R32F,
        width,
        height,
        0,
        gl.RED,
        gl.FLOAT,
        data,
      );
    } else if (data.length === width * height * 4) {
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        width,
        height,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        data,
      );
    } else {
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.R8,
        width,
        height,
        0,
        gl.RED,
        gl.UNSIGNED_BYTE,
        data,
      );
    }

    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  draw(rect: { x: number; y: number; w: number; h: number }, opacity = 1.0): void {
    if (this.disposed || !this.gl || !this.texture) return;
    if (!this.ensureInitialized()) return;

    const gl = this.gl;
    if (!this.program || !this.vao) return;

    gl.useProgram(this.program);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    const canvasW = gl.canvas?.width || Math.max(rect.w, 1);
    const canvasH = gl.canvas?.height || Math.max(rect.h, 1);

    if (this.uResolution) gl.uniform2f(this.uResolution, canvasW, canvasH);
    if (this.uRect) gl.uniform4f(this.uRect, rect.x, rect.y, rect.w, rect.h);
    if (this.uOpacity) gl.uniform1f(this.uOpacity, opacity);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    if (this.uTexture) gl.uniform1i(this.uTexture, 0);

    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    gl.bindVertexArray(null);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  getDimensions(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    if (!this.gl) return;
    const gl = this.gl;

    try {
      if (this.texture) gl.deleteTexture(this.texture);
      if (this.program) gl.deleteProgram(this.program);
      if (this.vao && typeof gl.deleteVertexArray === "function") gl.deleteVertexArray(this.vao);
      if (this.vbo) gl.deleteBuffer(this.vbo);
    } catch {
      // Mock safety
    }

    this.texture = null;
    this.program = null;
    this.vao = null;
    this.vbo = null;
  }
}
