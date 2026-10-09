import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const STATE_ROOT_ENV = 'AICO_PPT_EDITOR_STATE_ROOT';
const LEGACY_STATE_ROOT_ENV = 'HUAWEI_DECK_EDITOR_STATE_ROOT';

export function resolveEditorStateRoot({
  environment = process.env,
  homeDirectory = homedir(),
  processId = process.pid,
} = {}) {
  const override = environment?.[STATE_ROOT_ENV] ?? environment?.[LEGACY_STATE_ROOT_ENV];
  if (typeof override === 'string' && override.trim()) return resolve(override);
  if (environment?.NODE_TEST_CONTEXT) {
    return join(tmpdir(), `aico-ppt-editor-tests-${processId}`);
  }
  const home = resolve(homeDirectory);
  const current = join(home, '.aico-ppt-editor');
  const legacy = join(home, '.huawei-deck-editor');
  return existsSync(current) || !existsSync(legacy) ? current : legacy;
}
