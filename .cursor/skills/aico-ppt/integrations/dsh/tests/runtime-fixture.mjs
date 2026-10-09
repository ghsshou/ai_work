import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/** 每个测试独占工具文件和状态目录，不访问用户安装。 */
export async function runtimeFixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'aico-ppt-runtime-')));
  t.after(() => rm(root, { recursive:true, force:true }));
  const paths = { python:join(root, 'python', 'python3') };
  for (const path of Object.values(paths)) {
    await mkdir(dirname(path), { recursive:true });
    await writeFile(path, '', { mode:0o755 });
  }
  return { root, paths };
}
