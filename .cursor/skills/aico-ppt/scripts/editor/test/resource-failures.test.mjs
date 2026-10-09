import test from 'node:test';
import assert from 'node:assert/strict';
import * as helpers from './test-helpers.mjs';

test('resource abort 默认阻断且 pilot opt-in 只豁免同源 document ERR_ABORTED 一次', () => {
  assert.equal(typeof helpers.classifyResourceFailure, 'function');
  const appUrl = 'http://127.0.0.1:43210';
  const exact = {
    resourceType:'document',
    url:`blob:${appUrl}/expected-id`,
    errorText:'net::ERR_ABORTED',
  };
  assert.equal(helpers.classifyResourceFailure(exact, {
    appUrl, allowPilotDocumentBlobAbort:false, cancellationCount:0,
  }), 'problem');
  assert.equal(helpers.classifyResourceFailure(exact, {
    appUrl, allowPilotDocumentBlobAbort:true, cancellationCount:0,
  }), 'pilot-cancellation');
  assert.equal(helpers.classifyResourceFailure(exact, {
    appUrl, allowPilotDocumentBlobAbort:true, cancellationCount:1,
  }), 'problem');
  assert.equal(helpers.classifyResourceFailure(exact, {
    appUrl, maxPilotDocumentBlobAborts:2, cancellationCount:1,
  }), 'pilot-cancellation');
  assert.equal(helpers.classifyResourceFailure(exact, {
    appUrl, maxPilotDocumentBlobAborts:2, cancellationCount:2,
  }), 'problem');
  for (const failure of [
    { ...exact, resourceType:'image' },
    { ...exact, url:'blob:http://127.0.0.1:9999/other-origin' },
    { ...exact, errorText:'net::ERR_FAILED' },
  ]) {
    assert.equal(helpers.classifyResourceFailure(failure, {
      appUrl, allowPilotDocumentBlobAbort:true, cancellationCount:0,
    }), 'problem');
  }
});
