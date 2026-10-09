import { LiquidEtherEngine } from '/app/liquid-ether-engine.mjs';

let engine = null;
let active = false;
let destroyed = false;
let frameRequest = null;
let lastReportedSplats = 0;

const requestFrame = globalThis.requestAnimationFrame
  ? callback => globalThis.requestAnimationFrame(callback)
  : callback => setTimeout(() => callback(performance.now()), 16);
const cancelFrame = globalThis.cancelAnimationFrame
  ? request => globalThis.cancelAnimationFrame(request)
  : request => clearTimeout(request);

function stopLoop() {
  if (frameRequest !== null) cancelFrame(frameRequest);
  frameRequest = null;
}

function loop(now) {
  frameRequest = null;
  if (!active || destroyed || !engine) return;
  const maxPointerSplats = engine.render(now);
  if (maxPointerSplats > lastReportedSplats) {
    lastReportedSplats = maxPointerSplats;
    postMessage({ type:'metrics', maxPointerSplats });
  }
  frameRequest = requestFrame(loop);
}

function syncLoop() {
  if (!active || destroyed || !engine || frameRequest !== null) return;
  engine.resetClock();
  frameRequest = requestFrame(loop);
}

async function initialize(message) {
  try {
    engine = new LiquidEtherEngine(message.canvas, message);
    await engine.prepare();
    if (destroyed) return;
    postMessage({
      type:'ready',
      paletteSamples:engine.palette.image.width,
      continuity:'interpolated',
    });
    syncLoop();
  } catch (error) {
    engine?.dispose();
    engine = null;
    postMessage({
      type:'error',
      message:error instanceof Error ? error.message : String(error),
    });
  }
}

self.addEventListener('message', event => {
  const message = event.data ?? {};
  if (message.type === 'init') {
    void initialize(message);
    return;
  }
  if (message.type === 'active') {
    active = Boolean(message.value);
    if (active) syncLoop();
    else stopLoop();
    return;
  }
  if (message.type === 'pointer') {
    // Worker 与页面各自持有 performance 时钟，交互时间必须在渲染线程取值。
    engine?.receivePointerSamples(message.samples ?? []);
    return;
  }
  if (message.type === 'resize') {
    engine?.resize(message.width, message.height);
    return;
  }
  if (message.type === 'destroy') {
    destroyed = true;
    active = false;
    stopLoop();
    engine?.dispose();
    engine = null;
    close();
  }
});
