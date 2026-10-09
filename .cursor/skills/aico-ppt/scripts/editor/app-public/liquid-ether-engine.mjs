import * as THREE from '/app/three.module.min.js';

const FULLSCREEN_VERTEX = `
precision highp float;
attribute vec3 position;
uniform vec2 boundarySpace;
varying vec2 vUv;

void main() {
  vec3 nextPosition = position;
  nextPosition.xy *= 1.0 - boundarySpace * 2.0;
  vUv = 0.5 + nextPosition.xy * 0.5;
  gl_Position = vec4(nextPosition, 1.0);
}
`;

const POINTER_VERTEX = `
precision highp float;
attribute vec3 position;
attribute vec2 uv;
uniform vec2 center;
uniform vec2 scale;
uniform vec2 pixelSize;
varying vec2 vUv;

void main() {
  vec2 nextPosition = position.xy * scale * 2.0 * pixelSize + center;
  vUv = uv;
  gl_Position = vec4(nextPosition, 0.0, 1.0);
}
`;

const ADVECTION_FRAGMENT = `
precision highp float;
uniform sampler2D velocity;
uniform float dt;
uniform float velocityRetention;
uniform bool useBFECC;
uniform vec2 bufferSize;
varying vec2 vUv;

void main() {
  vec2 ratio = max(bufferSize.x, bufferSize.y) / bufferSize;
  vec2 currentVelocity = texture2D(velocity, vUv).xy;
  vec2 previousPosition = vUv - currentVelocity * dt * ratio;

  if (!useBFECC) {
    gl_FragColor = vec4(texture2D(velocity, previousPosition).xy * velocityRetention, 0.0, 1.0);
    return;
  }

  vec2 firstVelocity = texture2D(velocity, previousPosition).xy;
  vec2 forwardPosition = previousPosition + firstVelocity * dt * ratio;
  vec2 error = forwardPosition - vUv;
  vec2 correctedPosition = vUv - error * 0.5;
  vec2 correctedVelocity = texture2D(velocity, correctedPosition).xy;
  vec2 correctedPreviousPosition = correctedPosition - correctedVelocity * dt * ratio;
  gl_FragColor = vec4(texture2D(velocity, correctedPreviousPosition).xy * velocityRetention, 0.0, 1.0);
}
`;

const FORCE_FRAGMENT = `
precision highp float;
uniform vec2 force;
varying vec2 vUv;

void main() {
  vec2 circle = (vUv - 0.5) * 2.0;
  float strength = 1.0 - min(length(circle), 1.0);
  strength *= strength;
  gl_FragColor = vec4(force * strength, 0.0, 1.0);
}
`;

const DIVERGENCE_FRAGMENT = `
precision highp float;
uniform sampler2D velocity;
uniform vec2 pixelSize;
uniform float dt;
varying vec2 vUv;

void main() {
  float left = texture2D(velocity, vUv - vec2(pixelSize.x, 0.0)).x;
  float right = texture2D(velocity, vUv + vec2(pixelSize.x, 0.0)).x;
  float bottom = texture2D(velocity, vUv - vec2(0.0, pixelSize.y)).y;
  float top = texture2D(velocity, vUv + vec2(0.0, pixelSize.y)).y;
  gl_FragColor = vec4((right - left + top - bottom) / (2.0 * dt));
}
`;

const POISSON_FRAGMENT = `
precision highp float;
uniform sampler2D pressure;
uniform sampler2D divergence;
uniform vec2 pixelSize;
varying vec2 vUv;

void main() {
  float right = texture2D(pressure, vUv + vec2(pixelSize.x * 2.0, 0.0)).r;
  float left = texture2D(pressure, vUv - vec2(pixelSize.x * 2.0, 0.0)).r;
  float top = texture2D(pressure, vUv + vec2(0.0, pixelSize.y * 2.0)).r;
  float bottom = texture2D(pressure, vUv - vec2(0.0, pixelSize.y * 2.0)).r;
  float div = texture2D(divergence, vUv).r;
  gl_FragColor = vec4((right + left + top + bottom) * 0.25 - div);
}
`;

const PRESSURE_FRAGMENT = `
precision highp float;
uniform sampler2D pressure;
uniform sampler2D velocity;
uniform vec2 pixelSize;
uniform float dt;
varying vec2 vUv;

void main() {
  float right = texture2D(pressure, vUv + vec2(pixelSize.x, 0.0)).r;
  float left = texture2D(pressure, vUv - vec2(pixelSize.x, 0.0)).r;
  float top = texture2D(pressure, vUv + vec2(0.0, pixelSize.y)).r;
  float bottom = texture2D(pressure, vUv - vec2(0.0, pixelSize.y)).r;
  vec2 gradient = vec2(right - left, top - bottom) * 0.5;
  vec2 nextVelocity = texture2D(velocity, vUv).xy - gradient * dt;
  gl_FragColor = vec4(nextVelocity, 0.0, 1.0);
}
`;

const COLOR_FRAGMENT = `
precision highp float;
uniform sampler2D velocity;
uniform sampler2D palette;
varying vec2 vUv;

void main() {
  vec2 flow = texture2D(velocity, vUv).xy;
  float energy = 1.0 - exp(-length(flow) * 3.2);
  float palettePosition = smoothstep(0.015, 0.52, energy);
  vec3 color = texture2D(palette, vec2(palettePosition, 0.5)).rgb;
  float presence = smoothstep(0.008, 0.76, energy);
  vec3 graduatedColor = mix(vec3(1.0), color, smoothstep(0.015, 0.55, energy));
  gl_FragColor = vec4(graduatedColor, presence * 0.76);
}
`;

function createPaletteTexture(colors, sampleCount = 256) {
  const stops = colors.length === 1 ? [colors[0], colors[0]] : colors;
  const parsedStops = stops.map(stop => new THREE.Color(stop));
  const width = Math.max(2, sampleCount);
  const data = new Uint8Array(width * 4);
  const color = new THREE.Color();
  for (let index = 0; index < width; index += 1) {
    const position = (index / (width - 1)) * (parsedStops.length - 1);
    const leftIndex = Math.min(Math.floor(position), parsedStops.length - 2);
    color.lerpColors(
      parsedStops[leftIndex],
      parsedStops[leftIndex + 1],
      position - leftIndex,
    );
    data[index * 4] = Math.round(color.r * 255);
    data[index * 4 + 1] = Math.round(color.g * 255);
    data[index * 4 + 2] = Math.round(color.b * 255);
    data[index * 4 + 3] = 255;
  }
  const texture = new THREE.DataTexture(data, width, 1, THREE.RGBAFormat);
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

function disposeScene(scene) {
  scene.traverse(object => {
    object.geometry?.dispose?.();
    if (Array.isArray(object.material)) {
      object.material.forEach(material => material.dispose?.());
    } else {
      object.material?.dispose?.();
    }
  });
  scene.clear();
}

class FullscreenPass {
  constructor(renderer, { fragmentShader, uniforms, output = null }) {
    this.renderer = renderer;
    this.output = output;
    this.scene = new THREE.Scene();
    this.camera = new THREE.Camera();
    this.material = new THREE.RawShaderMaterial({
      vertexShader:FULLSCREEN_VERTEX,
      fragmentShader,
      uniforms,
      depthWrite:false,
      depthTest:false,
    });
    this.scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material));
  }

  render(output = this.output) {
    this.renderer.setRenderTarget(output);
    this.renderer.render(this.scene, this.camera);
    this.renderer.setRenderTarget(null);
  }

  dispose() {
    disposeScene(this.scene);
  }
}

export class LiquidEtherEngine {
  constructor(canvas, { width, height, pixelRatio, options }) {
    this.options = options;
    this.pointer = new THREE.Vector2(-0.42, 0.12);
    this.pointerQueue = [];
    this.autoTarget = new THREE.Vector2(0.44, -0.18);
    this.autoActive = false;
    this.autoActivationTime = 0;
    this.takeoverActive = false;
    this.takeoverFrom = this.pointer.clone();
    this.takeoverTo = this.pointer.clone();
    this.takeoverStartTime = 0;
    this.maxPointerSplatsObserved = 0;
    this.lastFrameTime = performance.now();
    this.lastInteractionTime = this.lastFrameTime - options.autoResumeDelay;
    this.destroyed = false;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      alpha:true,
      // 流体最终输出本身是连续纹理，全屏 MSAA 不改善边缘，却会增加
      // Windows ANGLE 的首次管线创建和每帧带宽成本。
      antialias:false,
      powerPreference:'high-performance',
    });
    this.renderer.autoClear = false;
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setPixelRatio(Math.min(pixelRatio || 1, 1.5));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.palette = createPaletteTexture(options.colors);
    this.resize(width, height);
    this.createPipeline();
  }

  createTarget() {
    return new THREE.WebGLRenderTarget(this.bufferWidth, this.bufferHeight, {
      type:/(iPad|iPhone|iPod)/i.test(globalThis.navigator?.userAgent ?? '')
        ? THREE.HalfFloatType : THREE.FloatType,
      depthBuffer:false,
      stencilBuffer:false,
      minFilter:THREE.LinearFilter,
      magFilter:THREE.LinearFilter,
      wrapS:THREE.ClampToEdgeWrapping,
      wrapT:THREE.ClampToEdgeWrapping,
    });
  }

  createPipeline() {
    this.pixelSize = new THREE.Vector2(1 / this.bufferWidth, 1 / this.bufferHeight);
    this.bufferSize = new THREE.Vector2(this.bufferWidth, this.bufferHeight);
    this.boundarySpace = this.pixelSize.clone();
    this.velocityA = this.createTarget();
    this.velocityB = this.createTarget();
    this.divergenceTarget = this.createTarget();
    this.pressureA = this.createTarget();
    this.pressureB = this.createTarget();

    for (const target of this.targets()) {
      this.renderer.setRenderTarget(target);
      this.renderer.clear();
    }
    this.renderer.setRenderTarget(null);

    this.advection = new FullscreenPass(this.renderer, {
      fragmentShader:ADVECTION_FRAGMENT,
      uniforms:{
        boundarySpace:{ value:this.boundarySpace },
        velocity:{ value:this.velocityA.texture },
        dt:{ value:this.options.dt },
        velocityRetention:{ value:1 },
        useBFECC:{ value:this.options.useBFECC },
        bufferSize:{ value:this.bufferSize },
      },
      output:this.velocityB,
    });

    this.forceScene = new THREE.Scene();
    this.forceCamera = new THREE.Camera();
    this.forceMaterial = new THREE.RawShaderMaterial({
      vertexShader:POINTER_VERTEX,
      fragmentShader:FORCE_FRAGMENT,
      transparent:true,
      blending:THREE.AdditiveBlending,
      depthWrite:false,
      depthTest:false,
      uniforms:{
        center:{ value:new THREE.Vector2() },
        scale:{ value:new THREE.Vector2(
          this.options.cursorSize * this.bufferWidth / this.width,
          this.options.cursorSize * this.bufferHeight / this.height,
        ) },
        pixelSize:{ value:this.pixelSize },
        force:{ value:new THREE.Vector2() },
      },
    });
    this.forceScene.add(new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.forceMaterial));

    this.divergence = new FullscreenPass(this.renderer, {
      fragmentShader:DIVERGENCE_FRAGMENT,
      uniforms:{
        boundarySpace:{ value:this.boundarySpace },
        velocity:{ value:this.velocityB.texture },
        pixelSize:{ value:this.pixelSize },
        dt:{ value:this.options.dt },
      },
      output:this.divergenceTarget,
    });

    this.poisson = new FullscreenPass(this.renderer, {
      fragmentShader:POISSON_FRAGMENT,
      uniforms:{
        boundarySpace:{ value:this.boundarySpace },
        pressure:{ value:this.pressureA.texture },
        divergence:{ value:this.divergenceTarget.texture },
        pixelSize:{ value:this.pixelSize },
      },
    });

    this.pressure = new FullscreenPass(this.renderer, {
      fragmentShader:PRESSURE_FRAGMENT,
      uniforms:{
        boundarySpace:{ value:this.boundarySpace },
        pressure:{ value:this.pressureA.texture },
        velocity:{ value:this.velocityB.texture },
        pixelSize:{ value:this.pixelSize },
        dt:{ value:this.options.dt },
      },
      output:this.velocityA,
    });

    this.output = new FullscreenPass(this.renderer, {
      fragmentShader:COLOR_FRAGMENT,
      uniforms:{
        boundarySpace:{ value:new THREE.Vector2() },
        velocity:{ value:this.velocityA.texture },
        palette:{ value:this.palette },
      },
    });
  }

  targets() {
    return [
      this.velocityA,
      this.velocityB,
      this.divergenceTarget,
      this.pressureA,
      this.pressureB,
    ].filter(Boolean);
  }

  disposePipeline() {
    this.advection?.dispose();
    this.divergence?.dispose();
    this.poisson?.dispose();
    this.pressure?.dispose();
    this.output?.dispose();
    if (this.forceScene) disposeScene(this.forceScene);
    for (const target of this.targets()) target.dispose();
  }

  resize(width, height) {
    const previousWidth = this.bufferWidth;
    const previousHeight = this.bufferHeight;
    this.width = Math.max(1, Math.floor(width));
    this.height = Math.max(1, Math.floor(height));
    this.bufferWidth = Math.max(2, Math.round(this.width * this.options.resolution));
    this.bufferHeight = Math.max(2, Math.round(this.height * this.options.resolution));
    this.renderer.setSize(this.width, this.height, false);
    if (
      this.advection
      && (previousWidth !== this.bufferWidth || previousHeight !== this.bufferHeight)
    ) {
      this.disposePipeline();
      this.createPipeline();
    }
  }

  async prepare() {
    const pipelines = [
      [this.advection.scene, this.advection.camera],
      [this.forceScene, this.forceCamera],
      [this.divergence.scene, this.divergence.camera],
      [this.poisson.scene, this.poisson.camera],
      [this.pressure.scene, this.pressure.camera],
      [this.output.scene, this.output.camera],
    ];
    for (const [scene, camera] of pipelines) {
      if (this.destroyed) return;
      await this.renderer.compileAsync(scene, camera);
    }
  }

  receivePointerSamples(samples, now = performance.now()) {
    if (!samples.length || this.destroyed) return;
    const points = samples.map(sample => new THREE.Vector2(sample.x, sample.y));
    const finalPoint = points.at(-1);
    this.lastInteractionTime = now;
    if (this.autoActive || this.takeoverActive) {
      if (!this.takeoverActive) {
        this.takeoverActive = true;
        this.takeoverFrom.copy(this.pointer);
        this.takeoverStartTime = now;
        this.pointerQueue.length = 0;
      }
      this.takeoverTo.copy(finalPoint);
      this.autoActive = false;
      return;
    }
    for (const point of points) this.enqueuePointer(point, 1);
  }

  updateAutoPointer(now, elapsedSeconds) {
    if (this.takeoverActive || now - this.lastInteractionTime < this.options.autoResumeDelay) {
      this.autoActive = false;
      return;
    }
    if (!this.autoActive) {
      this.autoActive = true;
      this.autoActivationTime = now;
    }
    const current = this.pointerQueue.at(-1)?.point ?? this.pointer;
    const direction = this.autoTarget.clone().sub(current);
    const distance = direction.length();
    if (distance < 0.035) {
      const margin = 0.18;
      this.autoTarget.set(
        (Math.random() * 2 - 1) * (1 - margin),
        (Math.random() * 2 - 1) * (1 - margin),
      );
      return;
    }
    const rampProgress = Math.min(
      1,
      (now - this.autoActivationTime) / (this.options.autoRampDuration * 1000),
    );
    const ramp = rampProgress * rampProgress * (3 - 2 * rampProgress);
    const step = Math.min(distance, this.options.autoSpeed * elapsedSeconds * ramp);
    this.enqueuePointer(
      current.clone().addScaledVector(direction.normalize(), step),
      this.options.autoIntensity,
    );
  }

  enqueuePointer(point, intensity) {
    const lastPoint = this.pointerQueue.at(-1)?.point ?? this.pointer;
    if (lastPoint.distanceToSquared(point) < 0.0000001) return;
    this.pointerQueue.push({ point:point.clone(), intensity });
    if (this.pointerQueue.length > this.options.maxPointerEntries) {
      this.pointerQueue.splice(0, this.pointerQueue.length - this.options.maxPointerEntries);
    }
  }

  updatePointerPath(now, elapsedSeconds) {
    if (this.takeoverActive) {
      const duration = Math.max(0.001, this.options.takeoverDuration) * 1000;
      const progress = Math.min(1, (now - this.takeoverStartTime) / duration);
      const eased = progress * progress * (3 - 2 * progress);
      this.enqueuePointer(this.takeoverFrom.clone().lerp(this.takeoverTo, eased), 1);
      if (progress >= 1) this.takeoverActive = false;
      return;
    }
    this.updateAutoPointer(now, elapsedSeconds);
  }

  injectPointerSegment(from, to, intensity) {
    const delta = to.clone().sub(from);
    const distanceInPixels = Math.hypot(
      delta.x * this.width * 0.5,
      delta.y * this.height * 0.5,
    );
    if (distanceInPixels < 0.01) return 0;
    const spacing = Math.max(8, this.options.cursorSize * 0.2);
    const steps = THREE.MathUtils.clamp(Math.ceil(distanceInPixels / spacing), 1, 32);
    const force = delta.multiplyScalar(
      (this.options.mouseForce * 0.5 * intensity) / steps,
    );
    const cursorX = this.options.cursorSize / this.width;
    const cursorY = this.options.cursorSize / this.height;

    for (let stepIndex = 1; stepIndex <= steps; stepIndex += 1) {
      const center = from.clone().lerp(to, stepIndex / steps);
      this.forceMaterial.uniforms.center.value.set(
        THREE.MathUtils.clamp(center.x, -1 + cursorX, 1 - cursorX),
        THREE.MathUtils.clamp(center.y, -1 + cursorY, 1 - cursorY),
      );
      this.forceMaterial.uniforms.force.value.copy(force);
      this.renderer.render(this.forceScene, this.forceCamera);
    }
    return steps;
  }

  injectPointerPath() {
    if (!this.pointerQueue.length) return;
    let from = this.pointer.clone();
    let splatCount = 0;
    this.renderer.setRenderTarget(this.velocityB);
    for (const entry of this.pointerQueue) {
      splatCount += this.injectPointerSegment(from, entry.point, entry.intensity);
      from = entry.point;
    }
    this.renderer.setRenderTarget(null);
    this.pointer.copy(from);
    this.pointerQueue.length = 0;
    this.maxPointerSplatsObserved = Math.max(this.maxPointerSplatsObserved, splatCount);
  }

  render(now = performance.now()) {
    if (this.destroyed) return this.maxPointerSplatsObserved;
    const frameSeconds = Math.max(0, (now - this.lastFrameTime) / 1000);
    const elapsedSeconds = Math.min(frameSeconds, 0.05);
    this.lastFrameTime = now;
    this.updatePointerPath(now, elapsedSeconds);
    // 按经过时间衰减，两次移动之间让旧笔迹自然消散，不随帧率累积铺满屏幕。
    this.advection.material.uniforms.velocityRetention.value = Math.pow(
      0.5, frameSeconds / this.options.velocityHalfLife,
    );
    this.advection.render();
    this.injectPointerPath();
    this.divergence.render();
    let pressureInput = this.pressureA;
    let pressureOutput = this.pressureB;
    for (let index = 0; index < this.options.poissonIterations; index += 1) {
      this.poisson.material.uniforms.pressure.value = pressureInput.texture;
      this.poisson.render(pressureOutput);
      [pressureInput, pressureOutput] = [pressureOutput, pressureInput];
    }
    this.pressure.material.uniforms.pressure.value = pressureInput.texture;
    this.pressure.render();
    this.output.render(null);
    return this.maxPointerSplatsObserved;
  }

  resetClock(now = performance.now()) {
    this.lastFrameTime = now;
  }

  dispose() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.disposePipeline();
    this.palette.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }
}
