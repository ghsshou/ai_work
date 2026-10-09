import { enhanceColorInput, enhanceSelect } from './native-controls.mjs';
import { applyPill } from './pill-nav.mjs';

const KIND_LABELS = Object.freeze({
  text:'文字', shape:'图形', svg:'SVG 图形', image:'图片',
});

const STYLE_LABELS = Object.freeze({
  color:'文字颜色',
  'font-family':'字体',
  'font-size':'字号',
  'font-style':'斜体',
  'font-weight':'字重',
  'text-decoration-line':'下划线',
  'text-align':'对齐',
  'line-height':'行距',
  'list-style-type':'项目符号',
  'background-color':'填充',
  'border-color':'边框颜色',
  'border-width':'边框宽度',
  'border-style':'边框样式',
  fill:'填充',
  stroke:'描边颜色',
  'stroke-width':'描边宽度',
  opacity:'透明度',
});

const FONT_FAMILIES = Object.freeze([
  'Huawei Sans', 'HarmonyOS Sans SC', 'Noto Sans SC', 'Microsoft YaHei',
  'Arial', 'Times New Roman', 'JetBrains Mono',
]);

function element(tag, attributes = {}, children = []) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (name === 'className') node.className = value;
    else if (name === 'text') node.textContent = value;
    else if (name === 'dataset') Object.assign(node.dataset, value);
    else if (name === 'checked') node.checked = Boolean(value);
    else if (name === 'disabled') node.disabled = Boolean(value);
    else if (name === 'value') node.value = value;
    else node.setAttribute(name, value);
  }
  node.append(...children.filter(Boolean));
  return node;
}

function colorToHex(value, fallback = '#ffffff') {
  const source = String(value ?? '').trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(source)) return source;
  if (/^#[0-9a-f]{3}$/.test(source)) {
    return `#${[...source.slice(1)].map(char => char.repeat(2)).join('')}`;
  }
  const rgb = source.match(/^rgba?\(\s*(\d+(?:\.\d+)?)\D+(\d+(?:\.\d+)?)\D+(\d+(?:\.\d+)?)/);
  if (!rgb) return fallback;
  return `#${rgb.slice(1, 4).map(part => (
    Math.max(0, Math.min(255, Math.round(Number(part)))).toString(16).padStart(2, '0')
  )).join('')}`;
}

function numberFromCss(value, fallback, min, max) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

function resetButton(property, selection, busy, onApply) {
  const modified = selection.modifiedProperties?.includes(property);
  const button = element('button', {
    className:'inspector-reset', type:'button', title:`恢复原始${STYLE_LABELS[property] ?? '属性'}`,
    'aria-label':`恢复原始${STYLE_LABELS[property] ?? '属性'}`,
    dataset:{ resetProperty:property },
    disabled:busy || !modified, text:'↶',
  });
  applyPill(button, { variant:'neutral', size:'sm', kind:'icon' });
  button.addEventListener('click', () => onApply([{
    property, value:selection.resetValues?.[property] ?? '',
  }]));
  return button;
}

function fieldRow(labelText, control, reset) {
  return element('div', { className:'inspector-field' }, [
    element('span', { className:'inspector-field-label', text:labelText }),
    element('div', { className:'inspector-field-control' }, [control, reset]),
  ]);
}

function colorControl({ property, value, selection, busy, onApply, noneValue }) {
  const input = element('input', {
    className:'inspector-color-input', type:'color', value:colorToHex(value), disabled:busy,
    dataset:{ styleProperty:property },
    title:STYLE_LABELS[property], 'aria-label':STYLE_LABELS[property],
  });
  input.addEventListener('change', () => onApply([{ property, value:input.value }]));
  const swatch = element('label', { className:'inspector-color-swatch', title:STYLE_LABELS[property] }, [input]);
  enhanceColorInput(input);
  const controls = [swatch, element('code', {
    className:'inspector-color-value', dataset:{ colorValue:property },
    text:colorToHex(value).toUpperCase(),
  })];
  if (noneValue !== undefined) {
    const none = element('button', {
      className:'inspector-none-button', type:'button', text:'无', disabled:busy,
    });
    applyPill(none, { variant:'secondary', size:'sm', kind:'action' });
    none.addEventListener('click', () => onApply([{ property, value:noneValue }]));
    controls.push(none);
  }
  return fieldRow(STYLE_LABELS[property], element('div', {
    className:'inspector-color-control',
  }, controls), resetButton(property, selection, busy, onApply));
}

function subsection(title, children) {
  return element('div', { className:'inspector-subsection' }, [
    element('h4', { text:title }), ...children,
  ]);
}

function inspectorGroup(key, title, summary, children) {
  const panelId = `inspector-group-${key}-${crypto.randomUUID()}`;
  const trigger = element('button', {
    className:'inspector-group-trigger', type:'button',
    dataset:{ inspectorGroupTrigger:key },
    'aria-expanded':'false', 'aria-controls':panelId,
  }, [
    element('span', { className:'inspector-group-title', text:title }),
    element('small', { className:'inspector-group-summary', text:summary }),
    element('span', { className:'inspector-group-chevron', 'aria-hidden':'true' }),
  ]);
  applyPill(trigger, { variant:'neutral', size:'md', kind:'segment' });
  return element('section', {
    className:'inspector-section inspector-group',
    dataset:{ inspectorGroup:key, open:'false' },
  }, [
    trigger,
    element('div', {
      className:'inspector-group-panel', id:panelId,
      dataset:{ inspectorGroupPanel:key },
    }, children),
  ]);
}

function primaryFontFamily(value) {
  return String(value ?? '').split(',')[0].trim().replace(/^(["'])(.*)\1$/, '$2');
}

function toggleStyleButton({ property, active, mixed, label, text, busy, onApply }) {
  const state = mixed ? 'mixed' : String(active);
  const title = mixed ? `混合${label}，点击统一设置` : `${active ? '取消' : ''}${label}`;
  const button = element('button', {
    className:'inspector-icon-button', type:'button', disabled:busy,
    dataset:{ styleProperty:property }, title, 'aria-label':title,
    'aria-pressed':state, text,
  });
  applyPill(button, { variant:'neutral', size:'sm', kind:'segment' });
  button.addEventListener('click', () => {
    const pressed = button.getAttribute('aria-pressed') === 'true';
    const values = {
      'font-weight':pressed ? '400' : '700',
      'font-style':pressed ? 'normal' : 'italic',
      'text-decoration-line':pressed ? 'none' : 'underline',
    };
    onApply([{ property, value:values[property] }]);
  });
  return button;
}

function typographyGroups(selection, busy, onApply) {
  if (!selection.capabilities?.typography) return { text:null, paragraph:null, textColor:null };
  const computed = selection.computed;
  const mixed = new Set(selection.mixedProperties ?? []);
  const bold = Number.parseInt(computed['font-weight'], 10) >= 600;
  const italic = computed['font-style'] === 'italic';
  const underline = computed['text-decoration-line'].split(/\s+/).includes('underline');
  const boldButton = toggleStyleButton({
    property:'font-weight', active:bold, mixed:mixed.has('font-weight'),
    label:'加粗', text:'B', busy, onApply,
  });
  const italicButton = toggleStyleButton({
    property:'font-style', active:italic, mixed:mixed.has('font-style'),
    label:'斜体', text:'I', busy, onApply,
  });
  const underlineButton = toggleStyleButton({
    property:'text-decoration-line', active:underline,
    mixed:mixed.has('text-decoration-line'), label:'下划线', text:'U', busy, onApply,
  });
  const currentFamily = primaryFontFamily(computed['font-family']);
  const familyOptions = [...new Set([...FONT_FAMILIES, ...(currentFamily ? [currentFamily] : [])])];
  const fontFamily = element('select', {
    className:'inspector-select', dataset:{ valueProperty:'font-family' },
    disabled:busy, 'aria-label':'字体',
  }, [
    ...(mixed.has('font-family') ? [element('option', {
      value:'', text:'— 混合字体 —', disabled:true, selected:true, dataset:{ mixedFont:'' },
    })] : []),
    ...familyOptions.map(family => element('option', { value:family, text:family })),
  ]);
  fontFamily.value = mixed.has('font-family') ? '' : currentFamily;
  fontFamily.addEventListener('change', () => onApply([{
    property:'font-family', value:fontFamily.value,
  }]));
  const fontFamilyControl = enhanceSelect(fontFamily, { minimumMenuWidth:190 }).root;
  const fontSize = element('input', {
    className:'inspector-number-input', type:'number', min:'6', max:'240', step:'1',
    dataset:{ valueProperty:'font-size' },
    value:String(Math.round(numberFromCss(computed['font-size'], 24, 6, 240))), disabled:busy,
    'aria-label':'字号',
  });
  fontSize.addEventListener('change', () => onApply([{
    property:'font-size', value:`${numberFromCss(fontSize.value, 24, 6, 240)}px`,
  }], { coalesceKey:'font-size' }));
  const paragraph = selection.elementComputed ?? computed;
  const alignment = ['left', 'center', 'right'].map(value => {
    const labels = { left:'左对齐', center:'居中', right:'右对齐' };
    const button = element('button', {
      className:'inspector-icon-button', type:'button', disabled:busy,
      dataset:{ paragraphAlign:value }, title:labels[value], 'aria-label':labels[value],
      'aria-pressed':String(paragraph['text-align'] === value),
      text:{ left:'≡←', center:'≡', right:'→≡' }[value],
    });
    applyPill(button, { variant:'neutral', size:'sm', kind:'segment' });
    button.addEventListener('click', () => onApply([{
      property:'text-align', value,
    }], { scope:'element' }));
    return button;
  });
  const bulletActive = paragraph.display === 'list-item'
    && paragraph['list-style-type'] !== 'none';
  const bullet = element('button', {
    className:'inspector-icon-button', type:'button', disabled:busy,
    dataset:{ listToggle:'' }, title:bulletActive ? '取消项目符号' : '项目符号',
    'aria-label':bulletActive ? '取消项目符号' : '项目符号',
    'aria-pressed':String(bulletActive), text:'•',
  });
  applyPill(bullet, { variant:'neutral', size:'sm', kind:'segment' });
  bullet.addEventListener('click', () => {
    const active = bullet.getAttribute('aria-pressed') === 'true';
    onApply(active ? [
      { property:'display', value:selection.elementInline?.display ?? selection.resetValues?.display ?? '' },
      { property:'list-style-type', value:selection.elementInline?.['list-style-type'] ?? '' },
      { property:'list-style-position', value:selection.elementInline?.['list-style-position'] ?? '' },
    ] : [
      { property:'display', value:'list-item' },
      { property:'list-style-type', value:'disc' },
      { property:'list-style-position', value:'inside' },
    ], { scope:'element' });
  });
  const lineHeight = element('input', {
    className:'inspector-number-input', type:'number', min:'.5', max:'4', step:'.1',
    dataset:{ valueProperty:'line-height' },
    value:String(numberFromCss(paragraph['line-height'], 1.2, .5, 4)), disabled:busy,
    'aria-label':'行距',
  });
  lineHeight.addEventListener('change', () => onApply([{
    property:'line-height', value:String(numberFromCss(lineHeight.value, 1.2, .5, 4)),
  }], { scope:'element', coalesceKey:'line-height' }));
  const text = inspectorGroup('text', '文字', '字体 · 字形 · 字号', [
    fieldRow('字体', fontFamilyControl, resetButton('font-family', selection, busy, onApply)),
    fieldRow('字号', element('div', { className:'inspector-unit-control' }, [
      fontSize, element('span', { text:'px' }),
    ]), resetButton('font-size', selection, busy, onApply)),
    fieldRow('字重', boldButton, resetButton('font-weight', selection, busy, onApply)),
    fieldRow('斜体', italicButton, resetButton('font-style', selection, busy, onApply)),
    fieldRow('下划线', underlineButton,
      resetButton('text-decoration-line', selection, busy, onApply)),
  ]);
  const paragraphGroup = inspectorGroup('paragraph', '段落', '对齐 · 列表 · 行距', [
    fieldRow('对齐', element('div', { className:'inspector-button-group' }, alignment),
      resetButton('text-align', selection, busy, changes => onApply(changes, { scope:'element' }))),
    fieldRow('项目符号', bullet),
    fieldRow('行距', lineHeight,
      resetButton('line-height', selection, busy, changes => onApply(changes, { scope:'element' }))),
  ]);
  return {
    text,
    paragraph:paragraphGroup,
    textColor:colorControl({
      property:'color', value:computed.color, selection, busy, onApply,
    }),
  };
}

function htmlBorderSubsection(selection, busy, onApply) {
  if (!selection.capabilities?.border) return null;
  const computed = selection.computed;
  const enabled = computed['border-style'] !== 'none'
    && numberFromCss(computed['border-width'], 0, 0, 40) > 0;
  const toggle = element('input', {
    className:'inspector-switch-input', type:'checkbox', checked:enabled, disabled:busy,
    dataset:{ borderToggle:'', borderStyle:computed['border-style'], borderWidth:computed['border-width'] },
    'aria-label':'显示边框',
  });
  toggle.addEventListener('change', () => onApply(toggle.checked ? [
    { property:'border-style', value:toggle.dataset.borderStyle === 'none'
      ? 'solid' : toggle.dataset.borderStyle },
    { property:'border-width', value:numberFromCss(toggle.dataset.borderWidth, 0, 0, 40) > 0
      ? toggle.dataset.borderWidth : '1px' },
  ] : [{ property:'border-style', value:'none' }]));
  const width = element('input', {
    className:'inspector-number-input', type:'number', min:'0', max:'40', step:'1',
    dataset:{ valueProperty:'border-width' },
    value:String(numberFromCss(computed['border-width'], 0, 0, 40)), disabled:busy || !enabled,
    'aria-label':'边框宽度',
  });
  width.addEventListener('change', () => onApply([{
    property:'border-width', value:`${numberFromCss(width.value, 1, 0, 40)}px`,
  }]));
  const borderStyle = element('select', {
    className:'inspector-select', dataset:{ valueProperty:'border-style' },
    disabled:busy || !enabled, 'aria-label':'边框样式',
  }, [
    element('option', { value:'solid', text:'实线' }),
    element('option', { value:'dashed', text:'虚线' }),
    element('option', { value:'dotted', text:'点线' }),
    element('option', { value:'double', text:'双线' }),
  ]);
  borderStyle.value = ['solid', 'dashed', 'dotted', 'double'].includes(computed['border-style'])
    ? computed['border-style'] : 'solid';
  borderStyle.addEventListener('change', () => onApply([{
    property:'border-style', value:borderStyle.value,
  }]));
  const borderStyleControl = enhanceSelect(borderStyle, { minimumMenuWidth:120 }).root;
  return subsection('边框', [
    fieldRow('显示边框', element('label', { className:'inspector-switch' }, [
      toggle, element('span', { 'aria-hidden':'true' }),
    ]), resetButton('border-style', selection, busy, onApply)),
    colorControl({
      property:'border-color', value:computed['border-color'], selection, busy, onApply,
    }),
    fieldRow('宽度', element('div', { className:'inspector-unit-control' }, [
      width, element('span', { text:'px' }),
    ]), resetButton('border-width', selection, busy, onApply)),
    fieldRow('样式', borderStyleControl, resetButton('border-style', selection, busy, onApply)),
  ]);
}

function svgStrokeSubsection(selection, busy, onApply) {
  if (!selection.capabilities?.svgStyle) return null;
  const computed = selection.computed;
  const width = element('input', {
    className:'inspector-number-input', type:'number', min:'0', max:'40', step:'.5',
    dataset:{ valueProperty:'stroke-width' },
    value:String(numberFromCss(computed['stroke-width'], 0, 0, 40)), disabled:busy,
    'aria-label':'描边宽度',
  });
  width.addEventListener('change', () => onApply([{
    property:'stroke-width', value:String(numberFromCss(width.value, 1, 0, 40)),
  }]));
  return subsection('描边', [
    colorControl({
      property:'stroke', value:computed.stroke, selection, busy, onApply, noneValue:'none',
    }),
    fieldRow('宽度', width, resetButton('stroke-width', selection, busy, onApply)),
  ]);
}

function opacitySubsection(selection, busy, onApply) {
  if (!selection.capabilities?.opacity) return null;
  const opacity = Math.round(numberFromCss(selection.computed.opacity, 1, 0, 1) * 100);
  const range = element('input', {
    className:'inspector-range', type:'range', min:'0', max:'100', step:'1',
    dataset:{ valueProperty:'opacity' },
    value:String(opacity), disabled:busy, 'aria-label':'不透明度',
  });
  const output = element('output', { className:'inspector-range-value', text:`${opacity}%` });
  range.addEventListener('input', () => { output.textContent = `${range.value}%`; });
  range.addEventListener('change', () => onApply([{
    property:'opacity', value:String(Number(range.value) / 100),
  }]));
  return subsection('透明度', [
    fieldRow('不透明度', element('div', { className:'inspector-range-control' }, [range, output]),
      resetButton('opacity', selection, busy, onApply)),
  ]);
}

function fillField(selection, busy, onApply) {
  if (!selection.capabilities?.fill) return null;
  const property = selection.capabilities.svgStyle ? 'fill' : 'background-color';
  return colorControl({
    property, value:selection.computed[property], selection, busy, onApply,
    noneValue:selection.capabilities.svgStyle ? 'none' : 'transparent',
  });
}

function selectionSummary(selection) {
  const tag = String(selection.tag ?? '').toUpperCase();
  const title = selection.scope === 'text-range'
    ? `“${selection.textPreview}”` : (selection.label || selection.textPreview || tag);
  const meta = selection.scope === 'text-range'
    ? `第 ${selection.pageIndex} 页 · 已选 ${selection.textRange.end - selection.textRange.start} 个字`
    : `第 ${selection.pageIndex} 页 · ${tag}`;
  return element('div', { className:'inspector-object' }, [
    element('div', { className:'inspector-object-icon', text:selection.kind === 'text' ? 'T' : '◇' }),
    element('div', { className:'inspector-object-copy' }, [
      element('strong', {
        dataset:{ inspectorObjectTitle:'' },
        text:title || KIND_LABELS[selection.kind] || '元素', title:title,
      }),
      element('span', {
        dataset:{ inspectorObjectMeta:'' }, text:meta,
      }),
    ]),
  ]);
}

function setOpenInspectorGroup(body, key = '') {
  for (const group of body.querySelectorAll('[data-inspector-group]')) {
    const open = group.dataset.inspectorGroup === key;
    group.dataset.open = String(open);
    group.querySelector('[data-inspector-group-trigger]')
      ?.setAttribute('aria-expanded', String(open));
  }
  body.dataset.openGroup = key;
}

function syncInspectorDock(body, dock) {
  const normalized = dock === 'top' ? 'top' : 'right';
  if (body.dataset.dock === normalized) return;
  body.dataset.dock = normalized;
  const defaultGroup = normalized === 'right'
    ? (body.querySelector('[data-inspector-group="text"]') ? 'text'
      : body.querySelector('[data-inspector-group]')?.dataset.inspectorGroup ?? '')
    : '';
  setOpenInspectorGroup(body, defaultGroup);
}

function bindInspectorGroupInteractions(body) {
  const controller = new AbortController();
  const { signal } = controller;
  for (const trigger of body.querySelectorAll('[data-inspector-group-trigger]')) {
    trigger.addEventListener('click', () => {
      const key = trigger.dataset.inspectorGroupTrigger;
      const open = trigger.getAttribute('aria-expanded') === 'true';
      setOpenInspectorGroup(body, open ? '' : key);
    }, { signal });
  }
  document.addEventListener('pointerdown', event => {
    if (body.dataset.dock === 'top' && !body.contains(event.target)) {
      setOpenInspectorGroup(body, '');
    }
  }, { capture:true, signal });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !body.dataset.openGroup) return;
    const key = body.dataset.openGroup;
    const trigger = body.querySelector(`[data-inspector-group-trigger="${CSS.escape(key)}"]`);
    event.preventDefault();
    // 抽屉是更靠近用户当前操作的临时层级，先于终端处理 Escape。
    event.stopImmediatePropagation();
    setOpenInspectorGroup(body, '');
    trigger?.focus();
  }, { capture:true, signal });
  body.addEventListener('inspector-dock-change', event => {
    syncInspectorDock(body, event.detail?.dock);
  }, { signal });
  body._inspectorCleanup = () => controller.abort();
}

function updateColor(body, selection, property) {
  const input = body.querySelector(`[data-style-property="${CSS.escape(property)}"]`);
  if (!input || input.type !== 'color') return;
  const value = colorToHex(selection.computed[property]);
  input.value = value;
  const output = body.querySelector(`[data-color-value="${CSS.escape(property)}"]`);
  if (output) output.textContent = value.toUpperCase();
}

function updateInspectorBody(body, { selection, busy, notice }) {
  body.dataset.busy = String(busy);
  body.dataset.selectionId = selection.selectionId;
  const title = selection.scope === 'text-range'
    ? `“${selection.textPreview}”`
    : (selection.label || selection.textPreview
      || String(selection.tag ?? '').toUpperCase()
      || KIND_LABELS[selection.kind] || '元素');
  const titleNode = body.querySelector('[data-inspector-object-title]');
  if (titleNode) {
    titleNode.textContent = title;
    titleNode.title = title;
  }
  const meta = body.querySelector('[data-inspector-object-meta]');
  if (meta) meta.textContent = selection.scope === 'text-range'
    ? `第 ${selection.pageIndex} 页 · 已选 ${selection.textRange.end - selection.textRange.start} 个字`
    : `第 ${selection.pageIndex} 页 · ${String(selection.tag ?? '').toUpperCase()}`;

  const noticeNode = body.querySelector('.inspector-notice');
  noticeNode.hidden = !notice;
  noticeNode.textContent = notice;
  noticeNode.dataset.state = notice.startsWith('失败') ? 'error' : 'info';

  for (const control of body.querySelectorAll('button,input,select')) control.disabled = busy;
  const modified = new Set(selection.modifiedProperties ?? []);
  for (const reset of body.querySelectorAll('[data-reset-property]')) {
    reset.disabled = busy || !modified.has(reset.dataset.resetProperty);
  }
  for (const resetAll of body.querySelectorAll('.inspector-reset-all')) {
    resetAll.hidden = modified.size === 0;
    resetAll.disabled = busy;
  }

  const borderEnabled = selection.computed['border-style'] !== 'none'
    && numberFromCss(selection.computed['border-width'], 0, 0, 40) > 0;
  const borderToggle = body.querySelector('[data-border-toggle]');
  const borderWidth = body.querySelector('[data-value-property="border-width"]');
  const borderStyle = body.querySelector('[data-value-property="border-style"]');
  if (borderWidth) borderWidth.disabled = busy || !borderEnabled;
  if (borderStyle) borderStyle.disabled = busy || !borderEnabled;

  // 提交开始时 selection 仍是旧快照；保留用户刚刚操作的控件值，避免视觉回跳。
  if (!busy) {
    const mixedProperties = new Set(selection.mixedProperties ?? []);
    const updateToggle = (property, active, label) => {
      const button = body.querySelector(`[data-style-property="${CSS.escape(property)}"]`);
      if (button?.tagName !== 'BUTTON') return;
      const mixed = mixedProperties.has(property);
      const title = mixed ? `混合${label}，点击统一设置` : `${active ? '取消' : ''}${label}`;
      button.setAttribute('aria-pressed', mixed ? 'mixed' : String(active));
      button.setAttribute('aria-label', title);
      button.title = title;
    };
    updateToggle('font-weight', Number.parseInt(selection.computed['font-weight'], 10) >= 600, '加粗');
    updateToggle('font-style', selection.computed['font-style'] === 'italic', '斜体');
    updateToggle('text-decoration-line',
      selection.computed['text-decoration-line'].split(/\s+/).includes('underline'), '下划线');
    const family = body.querySelector('[data-value-property="font-family"]');
    if (family) {
      const currentFamily = primaryFontFamily(selection.computed['font-family']);
      const mixed = mixedProperties.has('font-family');
      let mixedOption = family.querySelector('option[data-mixed-font]');
      if (mixed && !mixedOption) {
        mixedOption = element('option', {
          value:'', text:'— 混合字体 —', disabled:true, dataset:{ mixedFont:'' },
        });
        family.prepend(mixedOption);
      }
      if (mixedOption) mixedOption.hidden = !mixed;
      if (!mixed && currentFamily && ![...family.options].some(option => option.value === currentFamily)) {
        family.append(element('option', { value:currentFamily, text:currentFamily }));
      }
      family.value = mixed ? '' : currentFamily;
    }
    const setNumber = (property, value) => {
      const input = body.querySelector(`[data-value-property="${CSS.escape(property)}"]`);
      if (input) input.value = String(value);
    };
    setNumber('font-size', Math.round(numberFromCss(selection.computed['font-size'], 24, 6, 240)));
    const paragraph = selection.elementComputed ?? selection.computed;
    setNumber('line-height', numberFromCss(paragraph['line-height'], 1.2, .5, 4));
    setNumber('border-width', numberFromCss(selection.computed['border-width'], 0, 0, 40));
    setNumber('stroke-width', numberFromCss(selection.computed['stroke-width'], 0, 0, 40));
    for (const property of ['color', 'background-color', 'border-color', 'fill', 'stroke']) {
      updateColor(body, selection, property);
    }
    for (const align of body.querySelectorAll('[data-paragraph-align]')) {
      align.setAttribute('aria-pressed', String(paragraph['text-align'] === align.dataset.paragraphAlign));
    }
    const bullet = body.querySelector('[data-list-toggle]');
    if (bullet) {
      const active = paragraph.display === 'list-item' && paragraph['list-style-type'] !== 'none';
      bullet.setAttribute('aria-pressed', String(active));
      bullet.setAttribute('aria-label', active ? '取消项目符号' : '项目符号');
      bullet.title = active ? '取消项目符号' : '项目符号';
    }
    if (borderToggle) {
      borderToggle.checked = borderEnabled;
      borderToggle.dataset.borderStyle = selection.computed['border-style'];
      borderToggle.dataset.borderWidth = selection.computed['border-width'];
    }
    if (borderStyle) {
      borderStyle.value = ['solid', 'dashed', 'dotted', 'double']
        .includes(selection.computed['border-style']) ? selection.computed['border-style'] : 'solid';
    }
    const opacity = Math.round(numberFromCss(selection.computed.opacity, 1, 0, 1) * 100);
    const opacityRange = body.querySelector('[data-value-property="opacity"]');
    if (opacityRange) opacityRange.value = String(opacity);
    const opacityOutput = body.querySelector('.inspector-range-value');
    if (opacityOutput) opacityOutput.textContent = `${opacity}%`;
  }
}

function emptyState() {
  return element('div', { className:'inspector-empty' }, [
    element('div', { className:'selection-frame', 'aria-hidden':'true' }),
    element('h3', { text:'选择文字或画面元素开始编辑' }),
    element('p', { text:'双击文字直接修改；拖动元素移动，拖动右下角控制点缩放；Cmd/Ctrl+Enter 提交，Escape 取消。' }),
  ]);
}

export function renderInspectorPanel(root, {
  selection = null, busy = false, notice = '', onApply = () => {}, onResetAll = () => {},
} = {}) {
  const dock = root.closest('.editor-shell')?.dataset.inspectorDock ?? 'right';
  if (!selection) {
    root.querySelector(':scope > .inspector-body')?._inspectorCleanup?.();
    root.replaceChildren(emptyState());
    return;
  }
  const currentBody = root.querySelector(':scope > .inspector-body');
  if (currentBody?.dataset.selectionId === selection.selectionId) {
    syncInspectorDock(currentBody, dock);
    updateInspectorBody(currentBody, { selection, busy, notice });
    return;
  }
  const noticeNode = element('p', {
    className:'inspector-notice', dataset:{ state:'info' }, role:'status', 'aria-live':'polite',
  });
  noticeNode.hidden = true;
  const typography = typographyGroups(selection, busy, onApply);
  const appearanceFields = [
    typography.textColor,
    fillField(selection, busy, onApply),
  ].filter(Boolean);
  const moreSections = [
    htmlBorderSubsection(selection, busy, onApply),
    svgStrokeSubsection(selection, busy, onApply),
    opacitySubsection(selection, busy, onApply),
  ].filter(Boolean);
  const drawerResetAll = element('button', {
    className:'inspector-reset-all inspector-reset-all-drawer',
    type:'button', disabled:busy, text:'恢复全部原始样式',
  });
  applyPill(drawerResetAll, { variant:'secondary', size:'md', kind:'action' });
  drawerResetAll.addEventListener('click', onResetAll);
  const groups = [
    typography.text,
    typography.paragraph,
    appearanceFields.length
      ? inspectorGroup('appearance', '外观', '文字色 · 填充', appearanceFields) : null,
    moreSections.length
      ? inspectorGroup('more', '更多', '边框 · 透明度 · 恢复', [
        ...moreSections, drawerResetAll,
      ]) : null,
  ].filter(Boolean);
  const body = element('div', {
    className:'inspector-body', dataset:{ busy:String(busy), selectionId:selection.selectionId },
  }, [
    selectionSummary(selection),
    noticeNode,
    element('div', { className:'inspector-sections inspector-groups' }, groups),
  ]);
  const footerResetAll = element('button', {
    className:'inspector-reset-all inspector-reset-all-footer',
    type:'button', disabled:busy, text:'恢复全部原始样式',
  });
  applyPill(footerResetAll, { variant:'secondary', size:'md', kind:'action' });
  footerResetAll.addEventListener('click', onResetAll);
  body.append(element('div', { className:'inspector-footer' }, [footerResetAll]));
  currentBody?._inspectorCleanup?.();
  root.replaceChildren(body);
  bindInspectorGroupInteractions(body);
  syncInspectorDock(body, dock);
  updateInspectorBody(body, { selection, busy, notice });
}

export { colorToHex };
