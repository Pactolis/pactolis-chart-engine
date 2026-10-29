import type { HeatmapLayer } from "../gpuBackend.js";

export const HEATMAP_WGSL = `
struct Uniforms {
  resolution: vec2<f32>,
  rect: vec4<f32>,
  opacity: f32,
  pad: f32,
};

@group(0) @binding(0) var<uniform> u_params: Uniforms;
@group(0) @binding(1) var t_heatmap: texture_2d<f32>;
@group(0) @binding(2) var s_heatmap: sampler;

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

var<private> UNIT_QUAD: array<vec2<f32>, 6> = array<vec2<f32>, 6>(
  vec2<f32>(0.0, 0.0),
  vec2<f32>(1.0, 0.0),
  vec2<f32>(1.0, 1.0),
  vec2<f32>(0.0, 0.0),
  vec2<f32>(1.0, 1.0),
  vec2<f32>(0.0, 1.0)
);

@vertex
fn vs_main(@builtin(vertex_index) vertex_idx: u32) -> VertexOutput {
  var out: VertexOutput;
  let unit = UNIT_QUAD[vertex_idx];
  let pos = u_params.rect.xy + unit * u_params.rect.zw;
  let clip_x = (pos.x / u_params.resolution.x) * 2.0 - 1.0;
  let clip_y = 1.0 - (pos.y / u_params.resolution.y) * 2.0;
  out.position = vec4<f32>(clip_x, clip_y, 0.0, 1.0);
  out.uv = unit;
  return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
  let color = textureSample(t_heatmap, s_heatmap, in.uv);
  return vec4<f32>(color.rgb, color.a * u_params.opacity);
}
`;

export class WebGpuHeatmapLayer implements HeatmapLayer {
  readonly kind = "webgpu" as const;

  private pipeline: any;
  private sampler: any;
  private uniformBuffer: any;
  private texture: any = null;
  private textureView: any = null;
  private bindGroup: any = null;
  private bindGroupLayout: any;
  private width = 0;
  private height = 0;
  private disposed = false;
  private lastDrawParams: { rect: { x: number; y: number; w: number; h: number }; opacity: number } | null = null;

  constructor(
    private readonly device: any,
    public readonly format: string,
  ) {
    if (!device || typeof device.createShaderModule !== "function") {
      return;
    }

    try {
      const shaderModule = device.createShaderModule({
        label: "HeatmapShaderModule",
        code: HEATMAP_WGSL,
      });

      this.sampler = device.createSampler({
        label: "HeatmapSampler",
        magFilter: "linear",
        minFilter: "linear",
      });

      this.uniformBuffer = device.createBuffer({
        label: "HeatmapUniformBuffer",
        size: 32, // vec2 (8) + vec4 (16) + f32 (4) + pad (4) = 32 bytes
        usage: 0x0040 | 0x0008, // UNIFORM | COPY_DST
      });

      this.bindGroupLayout = device.createBindGroupLayout({
        label: "HeatmapBindGroupLayout",
        entries: [
          {
            binding: 0,
            visibility: 0x1 | 0x2, // VERTEX | FRAGMENT
            buffer: { type: "uniform" },
          },
          {
            binding: 1,
            visibility: 0x2, // FRAGMENT
            texture: { sampleType: "float" },
          },
          {
            binding: 2,
            visibility: 0x2, // FRAGMENT
            sampler: { type: "filtering" },
          },
        ],
      });

      const pipelineLayout = device.createPipelineLayout({
        label: "HeatmapPipelineLayout",
        bindGroupLayouts: [this.bindGroupLayout],
      });

      this.pipeline = device.createRenderPipeline({
        label: "HeatmapRenderPipeline",
        layout: pipelineLayout,
        vertex: {
          module: shaderModule,
          entryPoint: "vs_main",
        },
        fragment: {
          module: shaderModule,
          entryPoint: "fs_main",
          targets: [
            {
              format,
              blend: {
                color: {
                  srcFactor: "src-alpha",
                  dstFactor: "one-minus-src-alpha",
                  operation: "add",
                },
                alpha: {
                  srcFactor: "one",
                  dstFactor: "one-minus-src-alpha",
                  operation: "add",
                },
              },
            },
          ],
        },
        primitive: {
          topology: "triangle-list",
        },
      });
    } catch (err) {
      console.warn("[WebGpuHeatmapLayer] initialization error:", err);
    }
  }

  upload(width: number, height: number, data: Uint8Array | Float32Array): void {
    if (this.disposed || !this.device) return;
    this.width = width;
    this.height = height;

    const device = this.device;

    if (this.texture && (this.texture.width !== width || this.texture.height !== height)) {
      try {
        this.texture.destroy?.();
      } catch {
        // mock safety
      }
      this.texture = null;
    }

    if (!this.texture && typeof device.createTexture === "function") {
      this.texture = device.createTexture({
        label: "HeatmapTexture",
        size: [width, height, 1],
        format: "rgba8unorm",
        usage: 0x0004 | 0x0008, // TEXTURE_BINDING | COPY_DST
      });
      this.texture.width = width;
      this.texture.height = height;
    }

    if (!this.texture) return;

    let uploadData: Uint8Array;
    if (data instanceof Uint8Array) {
      if (data.length === width * height * 4) {
        uploadData = data;
      } else {
        uploadData = new Uint8Array(width * height * 4);
        for (let i = 0; i < width * height; i++) {
          const val = data[i];
          const offset = i * 4;
          uploadData[offset] = val;
          uploadData[offset + 1] = val;
          uploadData[offset + 2] = val;
          uploadData[offset + 3] = 255;
        }
      }
    } else {
      uploadData = new Uint8Array(width * height * 4);
      for (let i = 0; i < width * height; i++) {
        const val = Math.max(0, Math.min(255, Math.round(data[i] * 255)));
        const offset = i * 4;
        uploadData[offset] = val;
        uploadData[offset + 1] = val;
        uploadData[offset + 2] = val;
        uploadData[offset + 3] = 255;
      }
    }

    try {
      device.queue?.writeTexture(
        { texture: this.texture },
        uploadData.buffer,
        {
          offset: uploadData.byteOffset,
          bytesPerRow: width * 4,
          rowsPerImage: height,
        },
        [width, height, 1],
      );
    } catch {
      // Mock safety
    }

    try {
      this.textureView = this.texture.createView ? this.texture.createView() : this.texture;
      if (this.bindGroupLayout && device.createBindGroup) {
        this.bindGroup = device.createBindGroup({
          label: "HeatmapBindGroup",
          layout: this.bindGroupLayout,
          entries: [
            {
              binding: 0,
              resource: { buffer: this.uniformBuffer },
            },
            {
              binding: 1,
              resource: this.textureView,
            },
            {
              binding: 2,
              resource: this.sampler,
            },
          ],
        });
      }
    } catch {
      // Mock safety
    }
  }

  draw(rect: { x: number; y: number; w: number; h: number }, opacity = 1.0): void {
    if (this.disposed) return;
    this.lastDrawParams = { rect, opacity };
  }

  recordPass(
    passEncoder: any,
    canvasWidth: number,
    canvasHeight: number,
    rect?: { x: number; y: number; w: number; h: number },
    opacity = 1.0,
  ): void {
    if (this.disposed || !this.pipeline || !this.bindGroup || !passEncoder) return;

    const targetRect = rect ?? this.lastDrawParams?.rect;
    if (!targetRect) return;
    const targetOpacity = rect ? opacity : (this.lastDrawParams?.opacity ?? opacity);

    const uniformData = new Float32Array([
      canvasWidth > 0 ? canvasWidth : 1,
      canvasHeight > 0 ? canvasHeight : 1,
      targetRect.x,
      targetRect.y,
      targetRect.w,
      targetRect.h,
      targetOpacity,
      0, // padding
    ]);

    try {
      this.device?.queue?.writeBuffer(this.uniformBuffer, 0, uniformData);
      passEncoder.setPipeline(this.pipeline);
      passEncoder.setBindGroup(0, this.bindGroup);
      passEncoder.draw(6, 1, 0, 0);
    } catch {
      // Mock safety
    }
  }

  getDimensions(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }

  getLastDrawParams(): { rect: { x: number; y: number; w: number; h: number }; opacity: number } | null {
    return this.lastDrawParams;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    try {
      this.uniformBuffer?.destroy?.();
      this.texture?.destroy?.();
    } catch {
      // Mock safety
    }

    this.texture = null;
    this.textureView = null;
    this.bindGroup = null;
  }
}
