import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { extractEditable } from '../../html2pptx/extract-editable.mjs';
import { loadChromium, chromiumLaunchOptions } from '../../verify/load-playwright.mjs';

test('字号按实际画布比例保留局部 zoom，并以微软雅黑统一可编辑字体', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'aico-editable-font-'));
  try {
    const source = join(directory, 'font.html');
    await writeFile(source, `<!doctype html><meta charset="utf-8"><style>
      body{margin:0}.slide-canvas{position:relative;width:1920px;height:1080px;transform:scale(.5);transform-origin:top left;font-family:Arial}
      .title{position:absolute;left:100px;top:100px;font-size:64px;font-weight:700;color:#b5333b}
      .zoomed{position:absolute;left:100px;top:200px;zoom:2;font-size:32px;letter-spacing:1px}
      .zoomed table{font-size:24px;border-collapse:collapse}td{padding:4px}
      .scaled{position:absolute;left:800px;top:300px;scale:1.5;transform-origin:top left;font-size:32px}
    </style><div class="stage"><div class="slide-canvas"><div class="title">原始标题</div><div class="zoomed"><span>放大正文</span><table><tr><td>表格文字</td></tr></table></div><div class="scaled">缩放文字</div></div></div>`);
    const manifest = await extractEditable(source, join(directory, 'scene'), { scale: 1 });
    const elements = manifest.slides[0].elements;
    const title = elements.find(e => e.type === 'text' && e.paragraphs[0].runs[0].text === '原始标题');
    const zoomed = elements.find(e => e.type === 'text' && e.paragraphs[0].runs[0].text === '放大正文');
    const scaled = elements.find(e => e.type === 'text' && e.paragraphs[0].runs[0].text === '缩放文字');
    assert.equal(title.paragraphs[0].runs[0].fontSize, 64, '外层预览缩放不改变逻辑字号');
    assert.equal(zoomed.paragraphs[0].runs[0].fontSize, 64, '32px × 局部 zoom 2，不能导出成一半大小');
    assert.equal(zoomed.paragraphs[0].runs[0].charSpacing, 2);
    assert.equal(scaled.paragraphs[0].runs[0].fontSize, 48, '编辑器 CSS scale 缩放也必须纳入字号');
    const cell = elements.find(e => e.type === 'table').rows[0].cells[0];
    assert.equal(cell.paragraphs[0].runs[0].fontSize, 48);
    assert.equal(cell.marginLeft, 8);
    for (const run of [title.paragraphs[0].runs[0], zoomed.paragraphs[0].runs[0], cell.paragraphs[0].runs[0]]) assert.equal(run.fontFamily, 'Microsoft YaHei');
    assert.equal(title.paragraphs[0].runs[0].bold, true);
    assert.equal(title.paragraphs[0].runs[0].color, 'B5333B');
    const browser = await (await loadChromium()).launch(chromiumLaunchOptions());
    try {
      const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
      await page.goto(pathToFileURL(source).href);
      const baselines = await page.evaluate(() => {
        const canvas = document.querySelector('.slide-canvas').getBoundingClientRect();
        return ['.title', '.zoomed span', '.scaled'].map(selector => {
          const marker = document.createElement('span');
          marker.style.cssText = 'display:inline-block;width:0;height:0;padding:0;vertical-align:baseline';
          document.querySelector(selector).append(marker);
          return (marker.getBoundingClientRect().top - canvas.top) * 1080 / canvas.height;
        });
      });
      for (const [index, element] of [title, zoomed, scaled].entries()) assert.ok(Math.abs(element.y + element.paragraphs[0].runs[0].fontSize - baselines[index]) < 1, '文本框应对齐真实文字基线，不能把 DOM Range 顶部当文字顶部');
    } finally { await browser.close(); }
    const pptx = join(directory, 'font.pptx');
    const python = process.env.PYTHON || (process.platform === 'win32' ? 'py' : 'python3');
    execFileSync(python, ['-S', fileURLToPath(new URL('../../html2pptx/build_editable_pptx.py', import.meta.url)), join(directory, 'scene'), pptx]);
    const fonts = JSON.parse(execFileSync(python, ['-S', '-c', `
import json, sys
from zipfile import ZipFile
from xml.etree import ElementTree as E
ns={'a':'http://schemas.openxmlformats.org/drawingml/2006/main','p':'http://schemas.openxmlformats.org/presentationml/2006/main'}
with ZipFile(sys.argv[1]) as z:
 page=E.fromstring(z.read('ppt/presentation.xml')).find('p:sldSz',ns)
 slide=E.fromstring(z.read('ppt/slides/slide1.xml'))
 result={r.find('a:t',ns).text:{'points':int(r.find('a:rPr',ns).get('sz'))/100,'font':r.find('a:rPr/a:ea',ns).get('typeface')} for r in slide.findall('.//a:r',ns)}
 result['pageWidthPoints']=int(page.get('cx'))/12700
 result['shrinks']=len(slide.findall('.//a:normAutofit',ns))
 print(json.dumps(result))
`, pptx], { encoding: 'utf8' }));
    assert.equal(fonts['原始标题'].points / fonts.pageWidthPoints, 64 / 1920, '正文和页面必须使用同一换算，不能额外缩小');
    assert.equal(fonts['放大正文'].points / fonts.pageWidthPoints, 64 / 1920);
    assert.equal(fonts['表格文字'].points / fonts.pageWidthPoints, 48 / 1920);
    assert.equal(fonts['缩放文字'].points / fonts.pageWidthPoints, 48 / 1920);
    assert.equal(fonts['原始标题'].font, 'Microsoft YaHei');
    assert.equal(fonts.shrinks, 0, '禁止 Office 自动缩小文本');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('可编辑导出保留原生文字、形状和表格，复杂图形为图片，标签展开且不修改源文件', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'aico-editable-'));
  try {
    const source = join(directory, '含 空格#课件.html');
    const html = `<!doctype html><meta charset="utf-8"><style>
      body{margin:0}.slide-canvas{width:1920px;height:1080px;background:#fff;position:relative;font-family:Arial}
      h1{position:absolute;left:100px;top:60px;margin:0;font-size:64px;letter-spacing:2px}
      .card{position:absolute;left:100px;top:200px;width:500px;height:180px;border-radius:20px;background:#b5333b}
      .card p{color:white;font-size:32px;margin:32px}
      svg{position:absolute;left:700px;top:200px;width:200px;height:180px}
      table{position:absolute;left:100px;top:450px;width:600px;border-collapse:collapse;border:4px solid #111;font-size:28px}
      td{border:2px solid #888;padding:12px;background:#eee}
      [data-layer-panel]{display:none;position:absolute;left:100px;top:800px;font-size:32px}
      [data-layer-panel][data-active]{display:block}
    </style><div id="__deck_loading_overlay" style="position:fixed;inset:0;background:#00ff00;z-index:9999"></div><div class="stage"><div class="slide-canvas"><section data-label="示例">
      <h1>Editable 标题</h1><div class="card"><p>Native text</p></div>
      <svg viewBox="0 0 200 180"><circle cx="90" cy="90" r="80" fill="#0099cc"/><text x="40" y="90">SVG 图片</text></svg>
      <table><tr><td>产品</td><td>数量</td></tr><tr><td>AICO</td><td>42</td></tr></table>
      <button data-layer-btn="a" data-layer-group="tabs" hidden>A</button><button data-layer-btn="b" data-layer-group="tabs" hidden>B</button>
      <div data-layer-panel="a" data-layer-group="tabs" data-active>第一状态</div><div data-layer-panel="b" data-layer-group="tabs">第二状态</div>
    </section></div></div>`;
    await writeFile(source, html);
    const output = join(directory, 'scene');
    await extractEditable(source, output, { scale: 1 });
    const manifest = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8'));
    assert.equal(manifest.mode, 'editable');
    assert.equal(manifest.slides.length, 2);
    const elements = manifest.slides[0].elements;
    const texts = elements.filter(e => e.type === 'text');
    const text = texts.map(e => e.paragraphs.flatMap(p => p.runs.map(r => r.text)).join('')).join('|');
    assert.match(text, /Editable 标题/);
    assert.match(text, /Native text/);
    assert.match(text, /第一状态/);
    assert.doesNotMatch(text, /第二状态|SVG 图片|产品/);
    const title = texts.find(e => e.paragraphs[0].runs.some(r => r.text.includes('Editable')));
    assert.ok(Math.abs(title.x - 100) < 1);
    assert.equal(title.paragraphs[0].runs[0].fontSize, 64);
    assert.equal(title.paragraphs[0].runs[0].charSpacing, 2);
    assert.ok(elements.some(e => e.type === 'shape' && e.geometry === 'roundRect' && e.fill === 'B5333B'));
    const table = elements.find(e => e.type === 'table');
    assert.deepEqual(table.rows.map(r => r.cells.map(c => c.paragraphs.flatMap(p => p.runs.map(r => r.text)).join(''))), [['产品', '数量'], ['AICO', '42']]);
    assert.deepEqual(table.rows[0].cells[0].borderTop, { color:'111111', width:4 }, '表格外框必须保留更粗的线');
    assert.deepEqual(table.rows[1].cells[1].borderBottom, { color:'111111', width:4 });
    const picture = elements.find(e => e.type === 'image');
    assert.ok(picture);
    assert.equal((await readFile(join(output, picture.file))).subarray(1, 4).toString(), 'PNG');
    const chromium = await loadChromium();
    const browser = await chromium.launch(chromiumLaunchOptions());
    try {
      const page = await browser.newPage();
      const pixel = await page.evaluate(async source => {
        const img = new Image(); img.src = source; await img.decode();
        const canvas = document.createElement('canvas'); canvas.width = img.width; canvas.height = img.height;
        const context = canvas.getContext('2d'); context.drawImage(img, 0, 0);
        return [...context.getImageData(100, 120, 1, 1).data];
      }, 'data:image/png;base64,' + (await readFile(join(output, picture.file))).toString('base64'));
      assert.deepEqual(pixel, [0, 153, 204, 255], '模板加载浮层不得进入图片兜底');
    } finally { await browser.close(); }
    const text2 = manifest.slides[1].elements.filter(e => e.type === 'text').flatMap(e => e.paragraphs.flatMap(p => p.runs.map(r => r.text))).join('');
    assert.match(text2, /第二状态/);
    assert.doesNotMatch(text2, /第一状态/);
    assert.equal(await readFile(source, 'utf8'), html);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('画布外的品牌保密页脚保留可编辑文字及实际显示字号', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'aico-editable-footer-'));
  try {
    const source = join(directory, 'footer.html');
    await writeFile(source, `<!doctype html><style>body{margin:0}.slide-canvas{width:1920px;height:1080px;background:white;transform:scale(.5);transform-origin:top left}</style>
      <div class="app"><div class="stage"><div class="slide-canvas"></div></div><div style="position:fixed;left:20px;top:500px;font-size:20px;color:#999">Huawei Confidential</div></div>`);
    const manifest = await extractEditable(source, join(directory, 'scene'), { scale:1 });
    const footer = manifest.slides[0].elements.find(e => e.type === 'text');
    assert.ok(footer, '页脚不在 slide-canvas 内，也必须随每页导出');
    assert.equal(footer.paragraphs[0].runs[0].text, 'Huawei Confidential');
    assert.equal(footer.paragraphs[0].runs[0].fontSize, 40, 'fixed 页脚使用屏幕到画布的比例');
    assert.equal(footer.x, 40);
  } finally { await rm(directory, { recursive:true, force:true }); }
});

test('复杂图片真正隔离文字，跨父级层级、表格行内样式和背景不丢失', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'aico-editable-layers-'));
  try {
    const source = join(directory, 'deck.html');
    await writeFile(source, `<!doctype html><style>
      body{margin:0}.slide-canvas{width:1920px;height:1080px;background:white;position:relative;transform:scale(.5);transform-origin:top left;font-family:Arial}
      .group{position:relative}.ink{position:absolute;left:100px;top:100px;color:red;font-size:50px;z-index:10}
      .cover{position:absolute;left:100px;top:100px;width:400px;height:100px;background:#abcdef;z-index:1}
      svg{position:absolute;left:100px;top:100px;width:400px;height:100px;z-index:20}
      table{position:absolute;left:100px;top:400px;width:600px;background:navy;border-collapse:collapse;font-size:32px;color:white}
      tr{background:#990000}td{border-bottom:5px solid #ffd700;padding:12px}
      .effect{position:absolute;left:100px;top:600px;font-size:40px;color:transparent;text-shadow:0 0 0 black}
      .shadow{position:absolute;left:900px;top:400px;width:300px;height:120px;background:white;box-shadow:0 10px 20px #333}
      .shadow::before{content:"";position:absolute;bottom:0;left:0;width:100%;height:3px;background:red}
      .negative{position:absolute;left:1300px;top:100px;font-size:30px;z-index:-1}
      .phase-cover{position:absolute;left:1300px;top:200px;width:300px;height:100px;background:#fedcba;z-index:0}
      .flow{padding:200px 0 0 1300px;font-size:30px}
    </style><div class="stage"><div class="slide-canvas"><div class="group"><span class="ink">EDIT ME</span></div>
      <div class="cover"></div><svg><circle cx="350" cy="50" r="40" fill="blue"/></svg>
      <table><tr><td>CPU <b>92%</b> ready</td></tr><tr><td>Next row</td></tr></table><div class="effect">Visible effect</div><div class="shadow">Shadow caption</div>
      <div class="negative">Negative layer</div><div class="phase-cover"></div><div class="flow">Normal flow</div>
    </div></div>`);
    const output = join(directory, 'scene');
    const manifest = await extractEditable(source, output, { scale: 1 });
    const elements = manifest.slides[0].elements;
    const coverIndex = elements.findIndex(e => e.type === 'shape' && e.fill === 'ABCDEF');
    const textIndex = elements.findIndex(e => e.type === 'text' && e.paragraphs[0].runs[0].text === 'EDIT ME');
    assert.ok(textIndex > coverIndex, '跨无层叠上下文父节点的 z-index 仍然正确');
    assert.ok(Math.abs(elements[textIndex].x - 100) < 1, '画布缩放不得改变逻辑坐标');
    assert.equal(elements[textIndex].paragraphs[0].runs[0].fontSize, 50);
    const negativeIndex = elements.findIndex(e => e.type === 'text' && e.paragraphs[0].runs[0].text === 'Negative layer');
    assert.ok(negativeIndex > elements.findIndex(e => e.type === 'shape' && e.fill === 'FFFFFF'), '负层级仍在画布背景上');
    const flowIndex = elements.findIndex(e => e.type === 'text' && e.paragraphs[0].runs[0].text === 'Normal flow');
    assert.ok(flowIndex < elements.findIndex(e => e.type === 'shape' && e.fill === 'FEDCBA'), '普通流在定位零层级之下');
    const table = elements.find(e => e.type === 'table');
    const cell = table.rows[0].cells[0];
    assert.equal(cell.paragraphs.length, 1);
    assert.equal(cell.paragraphs[0].runs.map(r => r.text).join(''), 'CPU 92% ready');
    assert.ok(cell.paragraphs[0].runs.find(r => r.text === '92%').bold);
    assert.equal(cell.fill, '990000');
    assert.deepEqual(cell.borderBottom, { color: 'FFD700', width: 5 });
    assert.deepEqual(table.rows[1].cells[0].borderTop, cell.borderBottom, '共享边必须两侧一致，防止 Office 隐藏分隔线');
    assert.equal(cell.wrap, false);
    assert.ok(elements.some(e => e.type === 'image' && Math.abs(e.y - 600) < 1), '特效文字应图片兜底');
    const shadow = elements.find(e => e.type === 'image' && e.x > 700);
    assert.ok(shadow.width > 300 && shadow.height > 120, '阴影不得被元素边框裁掉');
    assert.ok(elements.some(e => e.type === 'text' && e.paragraphs[0].runs[0].text === 'Shadow caption'), '伪元素装饰只栅格化背景，正文仍可编辑');
    const svg = elements.find(e => e.type === 'image' && Math.abs(e.x - 100) < 1 && Math.abs(e.y - 100) < 1);
    const chromium = await loadChromium(); const browser = await chromium.launch(chromiumLaunchOptions());
    try {
      const page = await browser.newPage();
      const counts = await page.evaluate(async source => {
        const img = new Image(); img.src = source; await img.decode();
        const canvas = document.createElement('canvas'); canvas.width = img.width; canvas.height = img.height;
        const context = canvas.getContext('2d'); context.drawImage(img, 0, 0);
        const data = context.getImageData(0, 0, img.width, img.height).data;
        let red = 0, transparent = 0, blue = 0;
        for (let i = 0; i < data.length; i += 4) { if (data[i] > 200 && data[i + 1] < 50 && data[i + 2] < 50 && data[i + 3]) red++; if (!data[i + 3]) transparent++; if (data[i + 2] > 200 && data[i] < 50 && data[i + 3]) blue++; }
        return { red, transparent, blue };
      }, 'data:image/png;base64,' + (await readFile(join(output, svg.file))).toString('base64'));
      assert.equal(counts.red, 0, '可编辑文字不得被重复拍入 SVG 图片');
      assert.ok(counts.transparent > 0 && counts.blue > 0, 'SVG 图片须透明且保留自身图形');
    } finally { await browser.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
