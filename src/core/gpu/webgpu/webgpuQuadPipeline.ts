export const QUAD_WGSL = `
struct Uniforms {
  resolution: vec2<f32>,
};

@group(0) @binding(0) var<uniform> u_res: Uniforms;

struct InstanceInput {
  @location(0) rect: vec4<f32>,
  @location(1) color: vec4<f32>,
};

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) color: vec4<f32>,
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
fn vs_main(@builtin(vertex_index) vertex_idx: u32, instance: InstanceInput) -> VertexOutput {
  var out: VertexOutput;
  let unit = UNIT_QUAD[vertex_idx];
  let pos = instance.rect.xy + unit * instance.rect.zw;
  let clip_x = (pos.x / u_res.resolution.x) * 2.0 - 1.0;
  let clip_y = 1.0 - (pos.y / u_res.resolution.y) * 2.0;
  out.position = vec4<f32>(clip_x, clip_y, 0.0, 1.0);
  out.color = instance.color;
  return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
  return in.color;
}
`;

export const FLOATS_PER_INSTANCE = 8;
export const BYTES_PER_INSTANCE = FLOATS_PER_INSTANCE * 4;

export class WebGpuQuadPipeline {
  readonly pipeline: any;
  readonly uniformBuffer: any;
  readonly bindGroup: any;
  private instanceBuffer: any;
  private instanceCapacityQuads: number;
  private disposed = false;

  constructor(
    private readonly device: any,
    public readonly format: string,
    initialCapacityQuads = 10000,
  ) {
    this.instanceCapacityQuads = Math.max(1024, initialCapacityQuads);

    const shaderModule = device.createShaderModule({
      label: "QuadPipelineShader",
      code: QUAD_WGSL,
    });

    this.uniformBuffer = device.createBuffer({
      label: "QuadResolutionUniform",
      size: 16, // vec2<f32> aligned to 16 bytes
      usage: 0x0040 | 0x0008, // GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });

    const bindGroupLayout = device.createBindGroupLayout({
      label: "QuadBindGroupLayout",
      entries: [
        {
          binding: 0,
          visibility: 0x1, // GPUShaderStage.VERTEX
          buffer: { type: "uniform" },
        },
      ],
    });

    this.bindGroup = device.createBindGroup({
      label: "QuadBindGroup",
      layout: bindGroupLayout,
      entries: [
        {
          binding: 0,
          resource: { buffer: this.uniformBuffer },
        },
      ],
    });

    const pipelineLayout = device.createPipelineLayout({
      label: "QuadPipelineLayout",
      bindGroupLayouts: [bindGroupLayout],
    });

    this.pipeline = device.createRenderPipeline({
      label: "QuadRenderPipeline",
      layout: pipelineLayout,
      vertex: {
        module: shaderModule,
        entryPoint: "vs_main",
        buffers: [
          {
            arrayStride: BYTES_PER_INSTANCE,
            stepMode: "instance",
            attributes: [
              {
                shaderLocation: 0,
                offset: 0,
                format: "float32x4", // rect: x, y, w, h
              },
              {
                shaderLocation: 1,
                offset: 16,
                format: "float32x4", // color: r, g, b, a
              },
            ],
          },
        ],
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

    this.instanceBuffer = this.allocateInstanceBuffer(this.instanceCapacityQuads);
  }

  private allocateInstanceBuffer(quadCount: number): any {
    return this.device.createBuffer({
      label: "QuadInstanceBuffer",
      size: quadCount * BYTES_PER_INSTANCE,
      usage: 0x0020 | 0x0008, // GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
    });
  }

  updateResolution(width: number, height: number): void {
    if (this.disposed) return;
    const res = new Float32Array([width > 0 ? width : 1, height > 0 ? height : 1, 0, 0]);
    this.device.queue.writeBuffer(this.uniformBuffer, 0, res);
  }

  uploadInstances(data: Float32Array, quadCount: number): void {
    if (this.disposed || quadCount <= 0) return;
    if (quadCount > this.instanceCapacityQuads) {
      this.instanceBuffer?.destroy?.();
      this.instanceCapacityQuads = Math.max(quadCount, this.instanceCapacityQuads * 2);
      this.instanceBuffer = this.allocateInstanceBuffer(this.instanceCapacityQuads);
    }
    const byteLength = quadCount * BYTES_PER_INSTANCE;
    this.device.queue.writeBuffer(
      this.instanceBuffer,
      0,
      data.buffer,
      data.byteOffset,
      byteLength,
    );
  }

  recordPass(passEncoder: any, instanceCount: number): void {
    if (this.disposed || instanceCount <= 0) return;
    passEncoder.setPipeline(this.pipeline);
    passEncoder.setBindGroup(0, this.bindGroup);
    passEncoder.setVertexBuffer(0, this.instanceBuffer);
    passEncoder.draw(6, instanceCount, 0, 0);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.uniformBuffer?.destroy?.();
      this.instanceBuffer?.destroy?.();
    } catch {
      // Mock safety
    }
  }
}
