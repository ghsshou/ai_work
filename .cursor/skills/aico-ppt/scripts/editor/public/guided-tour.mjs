const ARROW_PATH = 'M4 32 C42 29 78 28 119 31 L101 12 L119 4 L196 44 L121 87 L101 79 L119 58 C78 58 42 60 7 68 L20 52 Z';


function element(tag, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}


function buildTourSurface() {
  const root = element('div', 'onboarding-tour');
  root.hidden = true;
  root.dataset.guidedTour = '';
  root.innerHTML = `
    <div class="tour-spotlight" data-tour-spotlight aria-hidden="true"></div>
    <svg class="tour-arrow" data-tour-arrow aria-hidden="true">
      <defs>
        <clipPath id="guided-tour-arrow-clip"><path d="${ARROW_PATH}"></path></clipPath>
      </defs>
      <g data-tour-arrow-shape>
        <path class="tour-arrow-body" d="${ARROW_PATH}"></path>
        <g class="tour-arrow-hatching" clip-path="url(#guided-tour-arrow-clip)">
          ${Array.from({ length:18 }, (_, index) => (
            `<path d="M ${index * 14 - 28} 92 L ${index * 14 + 26} -6"></path>`
          )).join('')}
        </g>
      </g>
    </svg>
    <section class="tour-card" data-tour-card role="dialog" aria-modal="true"
      aria-labelledby="guided-tour-title" aria-describedby="guided-tour-copy">
      <header class="tour-card-header">
        <span data-tour-progress></span>
        <button type="button" class="tour-skip" data-tour-skip>跳过引导</button>
      </header>
      <h2 id="guided-tour-title" data-tour-title></h2>
      <p id="guided-tour-copy" data-tour-copy></p>
      <footer class="tour-card-footer">
        <div class="tour-dots" data-tour-dots aria-label="引导进度"></div>
        <div class="tour-actions">
          <button type="button" class="tour-previous" data-tour-previous>上一步</button>
          <button type="button" class="tour-step-action" data-tour-step-action hidden></button>
          <button type="button" class="tour-next" data-tour-next>下一步</button>
        </div>
      </footer>
    </section>`;
  document.body.append(root);
  return {
    root,
    spotlight:root.querySelector('[data-tour-spotlight]'),
    arrowShape:root.querySelector('[data-tour-arrow-shape]'),
    card:root.querySelector('[data-tour-card]'),
    progress:root.querySelector('[data-tour-progress]'),
    title:root.querySelector('[data-tour-title]'),
    copy:root.querySelector('[data-tour-copy]'),
    dots:root.querySelector('[data-tour-dots]'),
    previous:root.querySelector('[data-tour-previous]'),
    stepAction:root.querySelector('[data-tour-step-action]'),
    next:root.querySelector('[data-tour-next]'),
    skip:root.querySelector('[data-tour-skip]'),
  };
}


function visibleTarget(spec) {
  const selectors = Array.isArray(spec) ? spec : [spec];
  for (const selector of selectors) {
    const target = typeof selector === 'function' ? selector() : document.querySelector(selector);
    if (!target?.isConnected || target.hidden) continue;
    const rect = target.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) return target;
  }
  return null;
}


function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}


export function createGuidedTour({
  sequences,
  storageKeyPrefix = 'aico-ppt-guided-tour',
  canStart = () => true,
} = {}) {
  if (!sequences || typeof sequences !== 'object') throw new TypeError('sequences 必须是对象');
  const ui = buildTourSurface();
  let sequenceId = null;
  let steps = [];
  let stepIndex = 0;
  let target = null;
  let frame = null;

  const position = () => {
    if (ui.root.hidden || !target?.isConnected) return;
    const targetRect = target.getBoundingClientRect();
    if (targetRect.width <= 0 || targetRect.height <= 0) return;
    const inset = 10;
    Object.assign(ui.spotlight.style, {
      left:`${targetRect.left - inset}px`,
      top:`${targetRect.top - inset}px`,
      width:`${targetRect.width + inset * 2}px`,
      height:`${targetRect.height + inset * 2}px`,
    });

    const cardRect = ui.card.getBoundingClientRect();
    const gap = 126;
    const edge = 24;
    const placement = steps[stepIndex].placement ?? 'bottom';
    const candidates = {
      right:{ left:targetRect.right + gap, top:targetRect.top + (targetRect.height - cardRect.height) / 2 },
      left:{ left:targetRect.left - cardRect.width - gap, top:targetRect.top + (targetRect.height - cardRect.height) / 2 },
      bottom:{ left:targetRect.left + (targetRect.width - cardRect.width) / 2, top:targetRect.bottom + gap },
      top:{ left:targetRect.left + (targetRect.width - cardRect.width) / 2, top:targetRect.top - cardRect.height - gap },
    };
    const preferred = candidates[placement] ?? candidates.bottom;
    const left = clamp(preferred.left, edge, window.innerWidth - cardRect.width - edge);
    const top = clamp(preferred.top, edge, window.innerHeight - cardRect.height - edge);
    ui.card.style.left = `${left}px`;
    ui.card.style.top = `${top}px`;

    const placed = { left, top, right:left + cardRect.width, bottom:top + cardRect.height };
    const cardCenter = { x:(placed.left + placed.right) / 2, y:(placed.top + placed.bottom) / 2 };
    const targetCenter = {
      x:targetRect.left + targetRect.width / 2,
      y:targetRect.top + targetRect.height / 2,
    };
    const delta = { x:targetCenter.x - cardCenter.x, y:targetCenter.y - cardCenter.y };
    let start;
    let end;
    if (Math.abs(delta.x) > Math.abs(delta.y)) {
      start = { x:delta.x > 0 ? placed.right + 8 : placed.left - 8, y:cardCenter.y };
      end = { x:delta.x > 0 ? targetRect.left - 8 : targetRect.right + 8, y:targetCenter.y };
    } else {
      start = { x:cardCenter.x, y:delta.y > 0 ? placed.bottom + 8 : placed.top - 8 };
      end = { x:targetCenter.x, y:delta.y > 0 ? targetRect.top - 8 : targetRect.bottom + 8 };
    }
    const length = Math.max(70, Math.hypot(end.x - start.x, end.y - start.y));
    const angle = Math.atan2(end.y - start.y, end.x - start.x) * 180 / Math.PI;
    const thickness = clamp(length / 180, .72, 1.05);
    ui.arrowShape.setAttribute(
      'transform',
      `translate(${start.x} ${start.y}) rotate(${angle}) scale(${length / 196} ${thickness}) translate(0 -44)`,
    );
  };

  const queuePosition = () => {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      frame = null;
      position();
    });
  };

  const close = ({ completed=false } = {}) => {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    ui.root.hidden = true;
    target = null;
    delete document.body.dataset.tourOpen;
    if (completed && sequenceId) {
      try { localStorage.setItem(`${storageKeyPrefix}:${sequenceId}`, 'completed'); }
      catch { /* 禁用本机存储不影响引导。 */ }
    }
  };

  const render = () => {
    const step = steps[stepIndex];
    target = visibleTarget(step.target);
    if (!target) {
      if (stepIndex < steps.length - 1) {
        stepIndex += 1;
        render();
      } else close();
      return;
    }
    ui.progress.textContent = `${String(stepIndex + 1).padStart(2, '0')} / ${String(steps.length).padStart(2, '0')}`;
    ui.title.textContent = step.title;
    ui.copy.textContent = step.copy;
    ui.previous.disabled = stepIndex === 0;
    ui.next.textContent = stepIndex === steps.length - 1 ? '完成' : '下一步';
    ui.stepAction.hidden = !step.action;
    ui.stepAction.textContent = step.action?.label ?? '';
    ui.dots.replaceChildren(...steps.map((_, index) => {
      const dot = element('i');
      dot.setAttribute('aria-hidden', 'true');
      dot.dataset.active = String(index === stepIndex);
      return dot;
    }));
    // 首次展示时先同步完成定位，避免对话卡片已经可见、箭头却要等到
    // 下一帧才出现；随后仍排队复算一次，以吸收 focus 等引起的布局变化。
    position();
    queuePosition();
    ui.next.focus();
  };

  const move = direction => {
    const next = stepIndex + direction;
    if (next < 0) return;
    if (next >= steps.length) {
      close({ completed:true });
      return;
    }
    stepIndex = next;
    render();
  };

  const start = id => {
    if (!canStart(id)) return false;
    const definition = typeof sequences[id] === 'function' ? sequences[id]() : sequences[id];
    if (!Array.isArray(definition) || definition.length === 0) return false;
    sequenceId = id;
    steps = definition;
    stepIndex = 0;
    ui.root.hidden = false;
    document.body.dataset.tourOpen = 'true';
    render();
    return true;
  };

  ui.previous.addEventListener('click', () => move(-1));
  ui.next.addEventListener('click', () => move(1));
  ui.skip.addEventListener('click', () => close());
  ui.stepAction.addEventListener('click', async () => {
    const action = steps[stepIndex]?.action;
    if (!action?.run) return;
    ui.stepAction.disabled = true;
    try { await action.run({ close, setCopy:value => { ui.copy.textContent = value; } }); }
    finally { ui.stepAction.disabled = false; }
  });
  window.addEventListener('resize', queuePosition);
  window.addEventListener('scroll', queuePosition, true);
  document.addEventListener('keydown', event => {
    if (ui.root.hidden) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      move(1);
      return;
    }
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      move(-1);
      return;
    }
    if (event.key === 'Tab') {
      const controls = [ui.skip, ui.previous, ui.stepAction, ui.next]
        .filter(button => !button.hidden && !button.disabled);
      const current = controls.indexOf(document.activeElement);
      const offset = event.shiftKey ? -1 : 1;
      event.preventDefault();
      controls[(current + offset + controls.length) % controls.length].focus();
    }
  });

  return { start, close, isOpen:() => !ui.root.hidden, root:ui.root };
}
