const NOOP_CONTROLLER = Object.freeze({
  pause() {},
  resume() {},
  destroy() {},
});

const moduleUrl = new URL(import.meta.url);
const appToken = moduleUrl.searchParams.get('token');

function assetUrl(path) {
  const url = new URL(path, moduleUrl);
  if (appToken) url.searchParams.set('token', appToken);
  return url.href;
}

function createCanvas(root) {
  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-hidden', 'true');
  root.prepend(canvas);
  return canvas;
}

class WorkerBackend {
  static create(canvas, dimensions, options, callbacks) {
    return new Promise((resolve, reject) => {
      const worker = new Worker(assetUrl('/app/liquid-ether-worker.mjs'), { type:'module' });
      const backend = new WorkerBackend(worker, callbacks);
      let settled = false;
      const fail = error => {
        if (!settled) {
          settled = true;
          worker.terminate();
          reject(error);
          return;
        }
        callbacks.onFatal(error, backend);
      };
      worker.addEventListener('error', event => {
        event.preventDefault();
        fail(new Error(event.message || '流体背景 Worker 载入失败'));
      });
      worker.addEventListener('message', event => {
        const message = event.data ?? {};
        if (message.type === 'ready' && !settled) {
          settled = true;
          callbacks.onMetrics(message);
          resolve(backend);
        } else if (message.type === 'metrics') {
          callbacks.onMetrics(message);
        } else if (message.type === 'error') {
          fail(new Error(message.message || '流体背景 Worker 运行失败'));
        }
      });

      try {
        const offscreenCanvas = canvas.transferControlToOffscreen();
        worker.postMessage({
          type:'init',
          canvas:offscreenCanvas,
          ...dimensions,
          pixelRatio:Math.min(window.devicePixelRatio || 1, 1.5),
          options,
        }, [offscreenCanvas]);
      } catch (error) {
        fail(error);
      }
    });
  }

  constructor(worker, callbacks) {
    this.worker = worker;
    this.callbacks = callbacks;
    this.destroyed = false;
  }

  setActive(value) {
    this.post({ type:'active', value });
  }

  pointer(samples) {
    this.post({ type:'pointer', samples });
  }

  resize(dimensions) {
    this.post({ type:'resize', ...dimensions });
  }

  post(message) {
    if (!this.destroyed) this.worker.postMessage(message);
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.worker.postMessage({ type:'destroy' });
    this.worker.terminate();
  }
}

class MainThreadBackend {
  static async create(canvas, dimensions, options, callbacks) {
    const { LiquidEtherEngine } = await import(assetUrl('/app/liquid-ether-engine.mjs'));
    const engine = new LiquidEtherEngine(canvas, {
      ...dimensions,
      pixelRatio:Math.min(window.devicePixelRatio || 1, 1.5),
      options,
    });
    const backend = new MainThreadBackend(engine, callbacks);
    await engine.prepare();
    callbacks.onMetrics({ paletteSamples:engine.palette.image.width, continuity:'interpolated' });
    return backend;
  }

  constructor(engine, callbacks) {
    this.engine = engine;
    this.callbacks = callbacks;
    this.active = false;
    this.destroyed = false;
    this.frameRequest = null;
    this.lastReportedSplats = 0;
  }

  loop = now => {
    this.frameRequest = null;
    if (!this.active || this.destroyed) return;
    const maxPointerSplats = this.engine.render(now);
    if (maxPointerSplats > this.lastReportedSplats) {
      this.lastReportedSplats = maxPointerSplats;
      this.callbacks.onMetrics({ maxPointerSplats });
    }
    this.frameRequest = requestAnimationFrame(this.loop);
  };

  setActive(value) {
    this.active = Boolean(value);
    if (!this.active) {
      if (this.frameRequest !== null) cancelAnimationFrame(this.frameRequest);
      this.frameRequest = null;
      return;
    }
    if (this.frameRequest !== null) return;
    this.engine.resetClock();
    this.frameRequest = requestAnimationFrame(this.loop);
  }

  pointer(samples, now) {
    this.engine.receivePointerSamples(samples, now);
  }

  resize(dimensions) {
    this.engine.resize(dimensions.width, dimensions.height);
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.setActive(false);
    this.engine.dispose();
  }
}

class LiquidEtherController {
  constructor(root, options) {
    this.root = root;
    this.options = options;
    this.canvas = createCanvas(root);
    this.backend = null;
    this.prepared = false;
    this.destroyed = false;
    this.switchingBackend = false;
    this.pointerSamples = [];
    this.pointerRequest = null;
    this.resizeRequest = null;
    this.startShell = document.querySelector('[data-start-shell]');

    this.onPointerMove = event => {
      const rect = this.root.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const coalescedEvents = event.getCoalescedEvents?.() ?? [];
      const events = coalescedEvents.length ? coalescedEvents : [event];
      for (const sample of events) {
        this.pointerSamples.push({
          x:((sample.clientX - rect.left) / rect.width) * 2 - 1,
          y:-(((sample.clientY - rect.top) / rect.height) * 2 - 1),
        });
      }
      if (this.pointerSamples.length > this.options.maxPointerEntries) {
        this.pointerSamples.splice(
          0,
          this.pointerSamples.length - this.options.maxPointerEntries,
        );
      }
      this.schedulePointerFlush();
    };
    this.onVisibilityChange = () => this.syncRunningState();
    this.onWindowResize = () => this.scheduleResize();
    window.addEventListener('pointermove', this.onPointerMove, { passive:true });
    window.addEventListener('resize', this.onWindowResize, { passive:true });
    document.addEventListener('visibilitychange', this.onVisibilityChange);

    this.resizeObserver = new ResizeObserver(() => this.scheduleResize());
    this.resizeObserver.observe(this.root);
    this.shellObserver = new MutationObserver(() => this.syncRunningState());
    if (this.startShell) {
      this.shellObserver.observe(this.startShell, { attributes:true, attributeFilter:['hidden'] });
    }

    this.root.dataset.state = 'warming';
    void this.initialize();
  }

  dimensions() {
    const rect = this.root.getBoundingClientRect();
    return {
      width:Math.max(1, Math.floor(rect.width)),
      height:Math.max(1, Math.floor(rect.height)),
    };
  }

  workerSupported() {
    return (
      typeof Worker === 'function'
      && typeof OffscreenCanvas === 'function'
      && typeof this.canvas.transferControlToOffscreen === 'function'
    );
  }

  callbacks() {
    return {
      onMetrics:metrics => this.applyMetrics(metrics),
      onFatal:(error, backend) => void this.recoverFromWorker(error, backend),
    };
  }

  async initialize() {
    try {
      if (this.workerSupported()) {
        try {
          this.backend = await WorkerBackend.create(
            this.canvas,
            this.dimensions(),
            this.options,
            this.callbacks(),
          );
          this.root.dataset.renderer = 'worker';
        } catch (error) {
          if (this.destroyed) return;
          this.root.dataset.warmup = 'main-thread-fallback';
          console.warn('启动页流体背景 Worker 不可用，改用兼容渲染。', error);
          this.replaceCanvas();
          this.backend = await MainThreadBackend.create(
            this.canvas,
            this.dimensions(),
            this.options,
            this.callbacks(),
          );
          this.root.dataset.renderer = 'main-thread';
        }
      } else {
        this.backend = await MainThreadBackend.create(
          this.canvas,
          this.dimensions(),
          this.options,
          this.callbacks(),
        );
        this.root.dataset.renderer = 'main-thread';
      }
      if (this.destroyed) {
        this.backend?.destroy();
        return;
      }
      this.prepared = true;
      this.schedulePointerFlush();
      this.syncRunningState();
    } catch (error) {
      this.useStaticFallback(error);
    }
  }

  replaceCanvas() {
    this.canvas.remove();
    this.canvas = createCanvas(this.root);
  }

  async recoverFromWorker(error, backend) {
    if (this.destroyed || this.switchingBackend || backend !== this.backend) return;
    this.switchingBackend = true;
    this.prepared = false;
    this.root.dataset.state = 'warming';
    this.root.dataset.warmup = 'main-thread-fallback';
    backend.destroy();
    this.backend = null;
    this.replaceCanvas();
    try {
      this.backend = await MainThreadBackend.create(
        this.canvas,
        this.dimensions(),
        this.options,
        this.callbacks(),
      );
      if (this.destroyed) {
        this.backend.destroy();
        return;
      }
      this.root.dataset.renderer = 'main-thread';
      this.prepared = true;
      this.syncRunningState();
      console.warn('启动页流体背景 Worker 中断，已恢复为兼容渲染。', error);
    } catch (fallbackError) {
      this.useStaticFallback(fallbackError);
    } finally {
      this.switchingBackend = false;
    }
  }

  useStaticFallback(error) {
    if (this.destroyed) return;
    this.backend?.destroy();
    this.backend = null;
    this.canvas.remove();
    this.root.dataset.state = 'fallback';
    console.warn('启动页流体背景不可用，已切换为静态柔光背景。', error);
  }

  applyMetrics(metrics) {
    if (metrics.paletteSamples) {
      this.root.dataset.paletteSamples = String(metrics.paletteSamples);
    }
    if (metrics.continuity) this.root.dataset.continuity = metrics.continuity;
    if (metrics.maxPointerSplats) {
      this.root.dataset.maxPointerSplats = String(metrics.maxPointerSplats);
    }
  }

  schedulePointerFlush() {
    if (this.destroyed || this.pointerRequest !== null) return;
    this.pointerRequest = requestAnimationFrame(now => {
      this.pointerRequest = null;
      if (!this.backend || !this.prepared || !this.pointerSamples.length) return;
      const samples = this.pointerSamples.splice(0);
      this.backend.pointer(samples, now);
    });
  }

  scheduleResize() {
    if (this.destroyed || this.resizeRequest !== null) return;
    this.resizeRequest = requestAnimationFrame(() => {
      this.resizeRequest = null;
      this.backend?.resize(this.dimensions());
    });
  }

  shouldRun() {
    return !document.hidden && !this.startShell?.hidden && !this.destroyed;
  }

  syncRunningState() {
    if (!this.prepared || !this.backend) return;
    const active = this.shouldRun();
    this.backend.setActive(active);
    this.root.dataset.state = active ? 'running' : 'paused';
  }

  pause() {
    this.backend?.setActive(false);
    if (!this.destroyed) this.root.dataset.state = 'paused';
  }

  resume() {
    this.syncRunningState();
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.pointerRequest !== null) cancelAnimationFrame(this.pointerRequest);
    if (this.resizeRequest !== null) cancelAnimationFrame(this.resizeRequest);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('resize', this.onWindowResize);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    this.resizeObserver.disconnect();
    this.shellObserver.disconnect();
    this.backend?.destroy();
    this.backend = null;
    this.canvas.remove();
    this.root.dataset.state = 'destroyed';
  }
}

export function createLiquidEtherBackground(root, overrides = {}) {
  if (!root) return NOOP_CONTROLLER;
  root.dataset.palette = 'huawei-red';
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  if (reducedMotion.matches) {
    root.dataset.state = 'reduced';
    return NOOP_CONTROLLER;
  }

  const isWindows = /Windows/i.test(navigator.userAgent);
  root.dataset.qualityProfile = isWindows ? 'windows-balanced' : 'full';
  const options = {
    colors:['#fffdfd', '#feecee', '#f9c5c9', '#ec7d85', '#c7000b'],
    mouseForce:18,
    // 按屏幕 CSS 像素定义笔触，避免窄面板降低渲染分辨率后反而变粗。
    cursorSize:128,
    velocityHalfLife:1.2,
    dt:0.014,
    useBFECC:true,
    poissonIterations:isWindows ? 12 : 24,
    resolution:window.innerWidth < 1100
      ? (isWindows ? 0.28 : 0.32)
      : (isWindows ? 0.34 : 0.42),
    maxPointerEntries:24,
    autoSpeed:0.18,
    autoIntensity:0.55,
    takeoverDuration:0.25,
    autoResumeDelay:5000,
    autoRampDuration:0.65,
    ...overrides,
  };

  return new LiquidEtherController(root, options);
}
