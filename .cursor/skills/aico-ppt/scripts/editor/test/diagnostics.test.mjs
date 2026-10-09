import test from 'node:test';
import assert from 'node:assert/strict';
import { compareDiagnostics } from '../bridge-service.mjs';
import { inspectInstallation, inspectEnvironment } from '../environment-doctor.mjs';

test('桌面诊断识别内置 Skill，并跳过独立 Dev Shell 和宿主注册', async () => {
  const installation = await inspectInstallation({ delivery:'desktop', runProcess:() => { throw new Error('不应检查宿主安装'); } });
  assert.equal(installation.registrations[0].host, 'dsh');
  assert.equal(installation.registrations[0].state, 'ready');
  const result = await inspectEnvironment({ delivery:'desktop', runProcess:async (_python, args) => {
    assert.equal(args.includes('full'), false);
    assert.equal(args.includes('dev-shell'), false);
    assert.equal(args.includes('pptx-export'), true);
    assert.equal(args.includes('pptx-read'), true);
    assert.equal(args.includes('materials'), true);
    return { ready:true };
  } });
  assert.equal(result.delivery, 'desktop');
  await assert.rejects(inspectEnvironment({ delivery:'desktop', repair:true }), /重新安装/);
  await assert.rejects(inspectInstallation({ delivery:'desktop', repair:true }), /重新安装/);
});

const locator = { pageKey:'page-001-a', path:'0/1', tag:'div', fingerprint:'old' };

function page({ section = { x:0, y:0 }, clips = [] } = {}) {
  return {
    pageKey:'page-001-a',
    sectionOverflow:section,
    nestedClips:clips,
  };
}

test('section 只阻断相对基线的正增量，既有值保持或改善可保存', () => {
  const baseline = { 'page-001-a':page({ section:{ x:4, y:3 } }) };
  assert.deepEqual(compareDiagnostics(
    baseline,
    { 'page-001-a':page({ section:{ x:4, y:1 } }) },
    ['page-001-a'],
  ), []);
  assert.deepEqual(compareDiagnostics(
    baseline,
    { 'page-001-a':page({ section:{ x:5, y:3 } }) },
    ['page-001-a'],
  ), [{ pageKey:'page-001-a', kind:'section', x:1, y:0 }]);
});

test('nested clip 以 pageKey/path/tag 匹配，严格大于 2px 或新 locator 才阻断', () => {
  const baseline = {
    'page-001-a':page({ clips:[{ locator, x:1, y:5 }] }),
  };
  assert.deepEqual(compareDiagnostics(
    baseline,
    { 'page-001-a':page({ clips:[{ locator:{ ...locator, fingerprint:'changed' }, x:3, y:7 }] }) },
    ['page-001-a'],
  ), []);

  const blockers = compareDiagnostics(
    baseline,
    { 'page-001-a':page({ clips:[
      { locator, x:3.01, y:5 },
      { locator:{ ...locator, path:'0/2' }, x:1, y:1 },
    ] }) },
    ['page-001-a'],
  );
  assert.equal(blockers[0].kind, 'nested-delta');
  assert.ok(blockers[0].x > 2);
  assert.equal(blockers[1].kind, 'nested-new');
});

test('缺页诊断不能被当作无问题放行', () => {
  assert.throws(
    () => compareDiagnostics(
      { 'page-001-a':page() }, {}, ['page-001-a'],
    ),
    error => error.code === 'DIAGNOSTICS_UNAVAILABLE' && error.stage === 'diagnostics',
  );
});

test('Skill 接管确认只在显式请求时传给安装器', async () => {
  let invocation;
  const result = await inspectInstallation({
    repair:true,
    adoptExisting:true,
    runProcess:async (command, args, options) => {
      invocation = { command, args, options };
      return { ready:true };
    },
  });

  assert.deepEqual(result, { ready:true });
  assert.ok(invocation.args.includes('repair'));
  assert.ok(invocation.args.includes('--adopt-existing'));
  assert.ok(invocation.args.includes('--skill-only'));
});
