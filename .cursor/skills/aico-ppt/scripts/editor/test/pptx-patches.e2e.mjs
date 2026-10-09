import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadChromium, chromiumLaunchOptions } from '../../verify/load-playwright.mjs';
import { extractEditable } from '../../html2pptx/extract-editable.mjs';
import { exportPptxSnapshot } from '../pptx-exporter.mjs';
import { startServer } from '../server.mjs';
import { PatchJournal } from '../patch-journal.mjs';

const python = process.env.PYTHON || (process.platform === 'win32' ? 'py' : 'python3');
const patchModule = fileURLToPath(new URL('../patch_bundle.py', import.meta.url));
const runtimePath = fileURLToPath(new URL('../runtime/patch-runtime.js', import.meta.url));

async function fixture(directory, { invalid = false, delayed = false } = {}) {
  const source = join(directory, 'deck.html');
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    body{margin:0}.slide-canvas{width:1920px;height:1080px;background:white;position:relative}
    h1{position:absolute;left:100px;top:100px;margin:0;font-size:40px}
    p{position:absolute;left:100px;top:250px;font-size:32px}
    .build{position:absolute;left:100px;top:400px;width:200px;height:100px;background:red;opacity:0;transform:translateY(40px)}
  </style></head><body><div class="stage"><div class="slide-canvas"><section data-page-id="page-11111111111111111111111111111111" data-label="补丁回归">
    <h1 data-editor-id="element-11111111111111111111111111111111">旧标题</h1><p>已删除的副标题</p><div class="build"></div>
  </section></div></div><script>
    const nav = [
      { i:0, code:'01', label:'补丁回归' },
    ];
    const chapters = [{name:'回归', start:0}];
  </script>${delayed ? `<script>
    // 模拟 bundle 在挂载画布后继续完成初始化；使用真实离线补丁稳定性检查。
    let tick=0;const timer=setInterval(()=>{
      document.querySelector('section').dataset.renderTick=String(++tick);
      if(tick===12)clearInterval(timer);
    },50);
  </script>` : ''}</body></html>`;
  await writeFile(source, html);
  const browser = await (await loadChromium()).launch(chromiumLaunchOptions());
  let actions;
  try {
    const page = await browser.newPage({ viewport:{ width:1920, height:1080 } });
    await page.goto(pathToFileURL(source).href);
    await page.addScriptTag({ content:await readFile(runtimePath, 'utf8') });
    actions = await page.evaluate(() => {
      const target = selector => window.HuaweiDeckPatchRuntime.makeLocator(document.querySelector(selector));
      return [
        { id:'title', target:target('h1'), kind:'setText', payload:{ text:'补丁后的新标题' } },
        { id:'font-size', target:target('h1'), kind:'setStyle', payload:{ property:'font-size', value:'64px' } },
        { id:'hide', target:target('p'), kind:'hide', payload:{} },
        { id:'move', target:target('.build'), kind:'translate', payload:{ x:80, y:20 } },
        { id:'opacity', target:target('.build'), kind:'setStyle', payload:{ property:'opacity', value:'0.5' } },
      ];
    });
  } finally { await browser.close(); }
  if (invalid) actions.push({ ...actions[0], id:'missing-target', target:{ ...actions[0].target, editorId:'element-ffffffffffffffffffffffffffffffff', path:'999' } });
  const patched = execFileSync(python, ['-S', '-c', `
import importlib.util,json,sys
spec=importlib.util.spec_from_file_location('patch_bundle',sys.argv[1])
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
request=json.load(sys.stdin)
sys.stdout.buffer.write(module.replace_block(request['html'],request['actions']).encode('utf-8'))
`, patchModule], { input:JSON.stringify({ html, actions }) });
  await writeFile(source, patched);
  return { source, patched, actions };
}

test('可编辑导出等待真实离线补丁完成，保留文案、隐藏、字号、移动和透明度', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'aico-pptx-patches-'));
  try {
    const { source, patched } = await fixture(directory, { delayed:true });
    const manifest = await extractEditable(source, join(directory, 'scene'), { scale:1 });
    const elements = manifest.slides[0].elements;
    const texts = elements.filter(e => e.type === 'text').flatMap(e => e.paragraphs.flatMap(p => p.runs));
    assert.deepEqual(texts.map(r => r.text), ['补丁后的新标题']);
    assert.equal(texts[0].fontSize, 64);
    const moved = elements.find(e => e.type === 'image');
    assert.ok(moved, '半透明补丁必须保留为图片，不能被 build 全显样式覆盖');
    assert.equal(moved.x, 180);
    assert.equal(moved.y, 420);
    assert.deepEqual(await readFile(source), patched, '导出不能修改输入 HTML');
  } finally { await rm(directory, { recursive:true, force:true }); }
});

for (const mode of ['editable', 'image']) test(`${mode} 导出补丁失败必须拒绝，不能返回回滚后的旧内容`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'aico-pptx-patches-failed-'));
  try {
    const { patched } = await fixture(directory, { invalid:true });
    await assert.rejects(exportPptxSnapshot({ htmlBytes:patched, mode, pythonExecutable:python, timeoutMs:30_000 }), /补丁.*missing-target/s);
  } finally { await rm(directory, { recursive:true, force:true }); }
});

test('编辑器 HTTP 导出同时包含内嵌补丁和未固化修改，并保持源文件与历史不变', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'aico-pptx-snapshot-'));
  let app;
  try {
    const { source, patched, actions } = await fixture(directory);
    // 最小可执行 bundle，工作副本仍经过正式 edit-bundle/patch_bundle 适配器。
    const bundled = '<script type="__bundler/manifest">\n{}\n</script>\n'
      + '<script type="__bundler/template">\n' + JSON.stringify(patched.toString('utf8')).replaceAll('</', '<\\u002F') + '\n</script>\n'
      + '<script>const template=JSON.parse(document.querySelector(\'script[type="__bundler/template"]\').textContent);document.open();document.write(template);document.close();</script>';
    await writeFile(source, bundled);
    app = await startServer({ deckPath:source, host:'127.0.0.1', port:0, openBrowser:false,
      managedWorkingDeck:true, pythonExecutable:python, autoStartAgentTerminal:false,
      createAgentTerminal:async () => null });
    const pending = { ...actions[0], id:'pending-title', before:'补丁后的新标题', after:'尚未固化的新标题', payload:{ text:'尚未固化的新标题' } };
    new PatchJournal(app.session).appendGroup(null, [pending]);
    const historyBefore = JSON.stringify(app.session.timeline);
    const workingBefore = await readFile(app.workingDeckPath);
    const response = await fetch(`${app.url}/api/export/pptx?token=${app.token}`, {
      method:'POST', headers:{ 'content-type':'application/json' },
      body:JSON.stringify({ expectedRevision:app.session.revision, mode:'editable' }),
    });
    assert.equal(response.status, 200, response.status === 200 ? '' : await response.text());
    const pptx = join(directory, 'actual.pptx');
    await writeFile(pptx, Buffer.from(await response.arrayBuffer()));
    const runs = JSON.parse(execFileSync(python, ['-S', '-c', `
import json,sys
from zipfile import ZipFile
from xml.etree import ElementTree as E
ns={'a':'http://schemas.openxmlformats.org/drawingml/2006/main'}
with ZipFile(sys.argv[1]) as z:
 slide=E.fromstring(z.read('ppt/slides/slide1.xml'))
 print(json.dumps([{'text':r.find('a:t',ns).text,'size':r.find('a:rPr',ns).get('sz')} for r in slide.findall('.//a:r',ns)]))
`, pptx], { encoding:'utf8' }));
    assert.deepEqual(runs, [{ text:'尚未固化的新标题', size:'3200' }], '64px 补丁与未固化文案必须同时进入 PPTX，隐藏副标题不得出现');
    assert.equal(await readFile(source, 'utf8'), bundled);
    assert.deepEqual(await readFile(app.workingDeckPath), workingBefore);
    assert.equal(JSON.stringify(app.session.timeline), historyBefore);
  } finally {
    await app?.close();
    await rm(directory, { recursive:true, force:true });
  }
});
