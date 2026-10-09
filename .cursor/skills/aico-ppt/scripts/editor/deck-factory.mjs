import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import {
  copyFile, lstat, mkdir, readFile, realpath, stat, unlink, writeFile,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncDirectory, syncFile } from './durable-fs.mjs';
import { pythonUtf8Environment } from './python-utf8.mjs';

const EDITOR_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = resolve(EDITOR_DIR, '../..');

function factoryError(code, statusCode, message, details) {
  return Object.assign(new Error(message), { code, statusCode, ...(details ? { details } : {}) });
}

function contains(parent, child) {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

function portableRelative(parent, child) {
  return relative(parent, child).replaceAll('\\', '/');
}

async function sha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

export function runFactoryCommand(command, args, {
  cwd = PROJECT_DIR,
  maximumBytes = 4 * 1024 * 1024,
  env = process.env,
} = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd, env, stdio:['ignore', 'pipe', 'pipe'], windowsHide:true,
    });
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    const collect = target => chunk => {
      bytes += chunk.length;
      if (bytes > maximumBytes) {
        child.kill();
        reject(factoryError('GENERATION_VERIFY_FAILED', 422, '验证工具输出过大'));
        return;
      }
      target.push(chunk);
    };
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    child.once('error', reject);
    child.once('close', code => {
      const result = {
        code,
        stdout:Buffer.concat(stdout).toString('utf8'),
        stderr:Buffer.concat(stderr).toString('utf8'),
      };
      if (code === 0) resolvePromise(result);
      else reject(factoryError(
        'GENERATION_VERIFY_FAILED', 422,
        result.stderr.trim() || result.stdout.trim() || `${command} 验证失败`, result,
      ));
    });
  });
}

function planMarkdown(snapshot, template) {
  const lines = [
    `# ${snapshot.brief.title}`,
    '',
    `- Draft：${snapshot.draftId}`,
    `- 场景：${snapshot.brief.scene}`,
    `- 听众：${snapshot.brief.audience}`,
    `- 时长：${snapshot.brief.durationMinutes} 分钟`,
    `- 目标：${snapshot.brief.objective}`,
    `- 模板：${template.name}（${template.templateId}）`,
    '',
    '## 章节大纲',
    '',
  ];
  snapshot.outline.sections.forEach((section, index) => {
    lines.push(`${index + 1}. **${section.title}**（\`${section.chapterId}\`）— ${section.objective}（${section.pageBudget} 页 / ${section.timeBudgetMinutes} 分钟）`);
  });
  lines.push('', '## 页面规划', '');
  snapshot.pagePlan.pages.forEach((page, index) => {
    lines.push(
      `### ${index + 1}. ${page.label}`,
      '',
      `- pageId：\`${page.pageId}\``,
      `- 章节：\`${page.chapterId}\``,
      `- 页型：\`${page.pageTypeId}\``,
      `- 核心观点：${page.coreClaim}`,
      `- 页型理由：${page.layoutRationale || '—'}`,
      `- 配图：${page.artwork || '—'}`,
      `- 建议讲解拍数：${page.steps}`,
      '',
    );
  });
  return `${lines.join('\n').trim()}\n`;
}

function tocContract(snapshot) {
  return `${JSON.stringify({
    version:1,
    chapters:snapshot.outline.sections.map(section => ({
      chapterId:section.chapterId,
      title:section.title,
      objective:section.objective,
    })),
  }, null, 2)}\n`;
}

function pagePlanContract(snapshot) {
  return `${JSON.stringify({
    version:1,
    templateId:snapshot.output.templateId,
    pages:snapshot.pagePlan.pages.map(page => ({
      pageId:page.pageId,
      chapterId:page.chapterId,
      pageTypeId:page.pageTypeId,
      label:page.label,
    })),
  }, null, 2)}\n`;
}

export class DeckFactory {
  static async create({ projectRoot, draftDir, catalog, ...options } = {}) {
    const root = await realpath(projectRoot);
    const rootInfo = await stat(root, { bigint:true });
    const draft = await realpath(draftDir);
    if (!rootInfo.isDirectory() || !contains(root, draft)) {
      throw factoryError('STAGING_UNSAFE', 409, 'Draft staging 不在绑定项目目录内');
    }
    return new DeckFactory({
      projectRoot:root,
      projectIdentity:{ dev:String(rootInfo.dev), ino:String(rootInfo.ino) },
      draftDir:draft,
      stagingRoot:join(draft, 'staging'),
      catalog,
      ...options,
    });
  }

  constructor({
    projectRoot, projectIdentity, draftDir, stagingRoot, catalog,
    pythonExecutable = 'python3', commandRunner = runFactoryCommand,
  }) {
    if (!catalog?.resolve) throw new TypeError('DeckFactory 缺少 TemplateCatalog');
    this.projectRoot = projectRoot;
    this.projectIdentity = projectIdentity;
    this.draftDir = draftDir;
    this.stagingRoot = stagingRoot;
    this.catalog = catalog;
    this.pythonExecutable = pythonExecutable;
    this.commandRunner = commandRunner;
  }

  async #assertProjectIdentity() {
    const canonical = await realpath(this.projectRoot);
    const info = await stat(canonical, { bigint:true });
    if (canonical !== this.projectRoot || !info.isDirectory()
      || String(info.dev) !== this.projectIdentity.dev
      || String(info.ino) !== this.projectIdentity.ino) {
      throw factoryError('PROJECT_ROOT_CHANGED', 409, '项目目录在确认后发生变化');
    }
  }

  async #resolveStaging(relativePath) {
    if (typeof relativePath !== 'string' || isAbsolute(relativePath)) {
      throw factoryError('STAGING_UNSAFE', 409, 'staging 路径无效');
    }
    const candidate = resolve(this.draftDir, relativePath);
    const canonical = await realpath(candidate).catch(() => null);
    const stagingRoot = await realpath(this.stagingRoot);
    if (!canonical || !contains(stagingRoot, canonical)) {
      throw factoryError('STAGING_UNSAFE', 409, 'staging 路径逃逸 Draft');
    }
    const info = await lstat(canonical);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw factoryError('STAGING_UNSAFE', 409, 'staging 目标不是可信常规文件');
    }
    return canonical;
  }

  async #resolveTocContract(snapshot, deckPath) {
    if (snapshot.generation.stagingTocContract) {
      return this.#resolveStaging(snapshot.generation.stagingTocContract);
    }
    const fileName = basename(deckPath).replace(/\.html$/i, '');
    const candidate = join(dirname(deckPath), `${fileName}.toc-contract.json`);
    try {
      await writeFile(candidate, tocContract(snapshot), { encoding:'utf8', mode:0o600, flag:'wx' });
      await syncFile(candidate);
      await syncDirectory(dirname(candidate));
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const info = await lstat(candidate).catch(() => null);
      if (!info?.isFile() || info.isSymbolicLink()
        || await readFile(candidate, 'utf8') !== tocContract(snapshot)) {
        throw factoryError(
          'STAGING_UNSAFE', 409,
          '旧 Draft 的目录契约与当前大纲冲突，请重试生成',
        );
      }
    }
    return this.#resolveStaging(portableRelative(this.draftDir, candidate));
  }

  async #resolvePagePlanContract(snapshot, deckPath) {
    const expected = pagePlanContract(snapshot);
    if (snapshot.generation.stagingPagePlanContract) {
      const contractPath = await this.#resolveStaging(
        snapshot.generation.stagingPagePlanContract,
      );
      if (await readFile(contractPath, 'utf8') !== expected) {
        throw factoryError(
          'STAGING_UNSAFE', 409,
          '页面规划发布契约已被改动，请重试生成',
        );
      }
      return contractPath;
    }
    const fileName = basename(deckPath).replace(/\.html$/i, '');
    const candidate = join(dirname(deckPath), `${fileName}.page-plan-contract.json`);
    try {
      await writeFile(candidate, expected, { encoding:'utf8', mode:0o600, flag:'wx' });
      await syncFile(candidate);
      await syncDirectory(dirname(candidate));
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const info = await lstat(candidate).catch(() => null);
      if (!info?.isFile() || info.isSymbolicLink()
        || await readFile(candidate, 'utf8') !== expected) {
        throw factoryError(
          'STAGING_UNSAFE', 409,
          '旧 Draft 的页面规划契约与当前确认方案冲突，请重试生成',
        );
      }
    }
    return this.#resolveStaging(portableRelative(this.draftDir, candidate));
  }

  async prepare(snapshot) {
    if (snapshot.phase !== 'generating' || snapshot.generation?.status !== 'preparing'
      || snapshot.pagePlanStatus !== 'confirmed' || !snapshot.output) {
      throw factoryError('CREATION_GATE_UNMET', 409, 'Draft 尚未满足生成条件');
    }
    await this.#assertProjectIdentity();
    const template = this.catalog.resolve(snapshot.output.templateId);
    const beforeFingerprint = await sha256(template.sourcePath);
    const runName = `run-${snapshot.generation.runId.replace(/[^A-Za-z0-9_-]/g, '') || randomUUID()}`;
    const runDir = join(this.stagingRoot, runName);
    await mkdir(runDir, { mode:0o700 });
    const stagingDeck = join(runDir, snapshot.output.fileName);
    const stagingPlan = join(runDir, `${basename(snapshot.output.fileName, '.html')}.plan.md`);
    const stagingTocContract = join(runDir, `${basename(snapshot.output.fileName, '.html')}.toc-contract.json`);
    const stagingPagePlanContract = join(
      runDir,
      `${basename(snapshot.output.fileName, '.html')}.page-plan-contract.json`,
    );
    await copyFile(template.sourcePath, stagingDeck, constants.COPYFILE_EXCL);
    await this.commandRunner(
      this.pythonExecutable,
      [
        join(EDITOR_DIR, 'deck_factory.py'), 'stamp', stagingDeck,
        '--catalog', this.catalog.catalogPath,
        '--template-id', template.templateId,
      ],
      { cwd:PROJECT_DIR, env:pythonUtf8Environment() },
    );
    await writeFile(stagingPlan, planMarkdown(snapshot, template), { encoding:'utf8', mode:0o600, flag:'wx' });
    await writeFile(stagingTocContract, tocContract(snapshot), { encoding:'utf8', mode:0o600, flag:'wx' });
    await writeFile(
      stagingPagePlanContract,
      pagePlanContract(snapshot),
      { encoding:'utf8', mode:0o600, flag:'wx' },
    );
    await syncFile(stagingDeck);
    await syncFile(stagingPlan);
    await syncFile(stagingTocContract);
    await syncFile(stagingPagePlanContract);
    await syncDirectory(runDir);
    if (await sha256(template.sourcePath) !== beforeFingerprint) {
      throw factoryError('TEMPLATE_CHANGED', 409, '内置模板在准备 staging 时发生变化');
    }
    return {
      stagingDeck:portableRelative(this.draftDir, stagingDeck),
      stagingPlan:portableRelative(this.draftDir, stagingPlan),
      stagingTocContract:portableRelative(this.draftDir, stagingTocContract),
      stagingPagePlanContract:portableRelative(this.draftDir, stagingPagePlanContract),
      templateId:template.templateId,
      templateFingerprint:beforeFingerprint,
      stagingFingerprint:await sha256(stagingDeck),
    };
  }

  async verify(snapshot) {
    if (snapshot.phase !== 'generating' || snapshot.generation?.status !== 'verifying') {
      throw factoryError('CREATION_GATE_UNMET', 409, '生成任务尚未进入验证阶段');
    }
    const deckPath = await this.#resolveStaging(snapshot.generation.stagingDeck);
    const tocContractPath = await this.#resolveTocContract(snapshot, deckPath);
    const pagePlanContractPath = await this.#resolvePagePlanContract(snapshot, deckPath);
    const template = this.catalog.resolve(snapshot.output.templateId);
    const diagnostics = [];
    const bundle = await this.commandRunner(
      this.pythonExecutable,
      [
        join(EDITOR_DIR, 'deck_factory.py'), 'verify', deckPath,
        '--catalog', this.catalog.catalogPath,
        '--template-id', snapshot.output.templateId,
        '--page-plan-contract', pagePlanContractPath,
      ],
      { cwd:PROJECT_DIR, env:pythonUtf8Environment() },
    );
    diagnostics.push({ check:'template-contract', ok:true, output:bundle.stdout.trim() });
    const toc = await this.commandRunner(
      this.pythonExecutable,
      [
        join(PROJECT_DIR, 'scripts/verify/toc_contract.py'), deckPath,
        '--contract', tocContractPath,
        '--template', template.sourcePath,
      ],
      { cwd:PROJECT_DIR, env:pythonUtf8Environment() },
    );
    diagnostics.push({ check:'toc-animation', ok:true, output:toc.stdout.trim() });
    const overflow = await this.commandRunner(
      process.execPath,
      [join(PROJECT_DIR, 'scripts/verify/measure_overflow.mjs'), deckPath, '--all'],
      { cwd:PROJECT_DIR },
    );
    diagnostics.push({ check:'overflow', ok:true, output:overflow.stdout.trim() });
    if (snapshot.output.trialPptx) {
      const pptxPath = join(dirname(deckPath), `${basename(deckPath, '.html')}.trial.pptx`);
      const conversion = await this.commandRunner(
        this.pythonExecutable,
        [join(PROJECT_DIR, 'scripts/html2pptx/convert.py'), deckPath, pptxPath],
        { cwd:PROJECT_DIR, env:pythonUtf8Environment() },
      );
      diagnostics.push({ check:'pptx-trial', ok:true, output:conversion.stdout.trim() });
    }
    return { diagnostics, stagingFingerprint:await sha256(deckPath) };
  }

  async publish(snapshot) {
    if (snapshot.phase !== 'generating' || snapshot.generation?.status !== 'verifying') {
      throw factoryError('CREATION_GATE_UNMET', 409, '生成任务尚未通过发布闸门');
    }
    await this.#assertProjectIdentity();
    const stagingDeck = await this.#resolveStaging(snapshot.generation.stagingDeck);
    const stagingPlan = await this.#resolveStaging(snapshot.generation.stagingPlan);
    const outputDeck = join(this.projectRoot, snapshot.output.fileName);
    const outputPlan = join(
      this.projectRoot,
      `${basename(snapshot.output.fileName, '.html')}.plan.md`,
    );
    const created = [];
    try {
      if (snapshot.output.includePlan) {
        await copyFile(stagingPlan, outputPlan, constants.COPYFILE_EXCL);
        created.push(outputPlan);
      }
      await copyFile(stagingDeck, outputDeck, constants.COPYFILE_EXCL);
      created.push(outputDeck);
      for (const path of created) await syncFile(path);
      await syncDirectory(this.projectRoot);
    } catch (error) {
      for (const path of created) await unlink(path).catch(() => {});
      if (error.code === 'EEXIST') {
        throw factoryError('OUTPUT_EXISTS', 409, '最终 HTML 或 plan.md 已存在，请更换输出文件名');
      }
      throw error;
    }
    return {
      publishedDeck:outputDeck,
      publishedPlan:snapshot.output.includePlan ? outputPlan : null,
      fingerprint:await sha256(outputDeck),
    };
  }
}
