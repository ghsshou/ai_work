import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectDesktopRenderer } from '../../verify/desktop-renderer.mjs';

test('桌面渲染大截图分块接收不重复扫描整个累计响应', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'aico-renderer-stream-'));
  const image = Buffer.alloc(2 * 1024 * 1024, 97);
  const sockets = new Set();
  const server = createServer(socket => {
    sockets.add(socket); socket.once('close', () => sockets.delete(socket));
    socket.setEncoding('utf8'); let buffer = '';
    socket.on('data', async chunk => {
      buffer += chunk;
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      const request = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      const value = request.method === 'newPage' ? 'page-1' : request.method === 'screenshot' ? image.toString('base64') : null;
      const bytes = Buffer.from(JSON.stringify({id:request.id,value})+'\n');
      for (let offset=0; offset<bytes.length; offset+=32768) {
        socket.write(bytes.subarray(offset, offset+32768));
        await new Promise(resolve => setTimeout(resolve, 2));
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  const original = Buffer.byteLength;
  let scanned=0;
  try {
    await writeFile(join(directory,'desktop-renderer.json'),JSON.stringify({schema:1,host:'127.0.0.1',port:server.address().port,token:'1'.repeat(64)}),{mode:0o600});
    browser=await connectDesktopRenderer(directory);
    const page=await browser.newPage();
    Buffer.byteLength=(value,...args)=>{if(typeof value==='string')scanned+=value.length;return original(value,...args);};
    assert.deepEqual(await page.screenshot(),image);
    assert.ok(scanned<image.length*8,`实际图片 ${image.length}，累计扫描 ${scanned}`);
  } finally {
    Buffer.byteLength=original;
    await browser?.close();
    for(const socket of sockets)socket.destroy();
    await new Promise(resolve=>server.close(resolve));
    await rm(directory,{recursive:true,force:true});
  }
});

for (const supported of [false, true]) test(`桌面透明截图${supported ? '透传新能力' : '明确拒绝旧 Host，保留普通截图'}`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'aico-renderer-feature-'));
  const messages = [];
  const server = createServer(socket => {
    socket.setEncoding('utf8'); let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const request = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1); messages.push(request);
        socket.write(JSON.stringify({ id: request.id, value: request.method === 'newPage' ? 'page-1' : request.method === 'screenshot' ? 'cGljdHVyZQ==' : null }) + '\n');
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    await writeFile(join(directory, 'desktop-renderer.json'), JSON.stringify({ schema: 1, host: '127.0.0.1', port: server.address().port, token: '1'.repeat(64), ...(supported ? { features: { screenshotOmitBackground: 1 } } : {}) }), { mode: 0o600 });
    browser = await connectDesktopRenderer(directory);
    const page = await browser.newPage();
    if (supported) {
      assert.equal((await page.screenshot({ omitBackground: true })).toString(), 'picture');
      assert.equal(messages.at(-1).args.options.omitBackground, true);
    } else {
      await assert.rejects(page.screenshot({ omitBackground: true }), /升级.*桌面|桌面.*升级/);
      assert.equal(messages.filter(m => m.method === 'screenshot').length, 0);
    }
    assert.equal((await page.screenshot({ type: 'png' })).toString(), 'picture');
    await assert.rejects(page.waitForFunction(() => false, undefined, { timeout:1 }), { name:'TimeoutError' });
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
