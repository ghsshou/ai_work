import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const EDITOR_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = resolve(EDITOR_DIR, '../..');
const DEFAULT_CATALOG_PATH = join(EDITOR_DIR, 'template-catalog.json');
const MAX_CONSECUTIVE_VISUAL_FAMILY = 2;

const FAMILY_RULES = [
  [/(?:cover|封面)/i, 'cover'],
  [/(?:toc|目录)/i, 'toc'],
  [/(?:thanks|结语|感谢)/i, 'thanks'],
  [/(?:section-divider|章扉)/i, 'transition'],
  [/(?:question|seminar|qa|quiz|问题|研讨|问答|题卡)/i, 'question'],
  [/(?:quote|takeaway|tldr|agenda|金句|总结|摘要|议程)/i, 'statement'],
  [/(?:timeline|flow|process|funnel|gantt|milestone|evolution|root-cause|training-stages|build|gradient-derivation|four-stage-chain|next-steps|流程|时间轴|漏斗|甘特|里程碑|演进|根因|逐步|四段链|下一步)/i, 'sequence'],
  [/(?:comparison|selection|decision|dual-option|big-number-vs|tuning-comparison|对比|选型|决策|双方案)/i, 'comparison'],
  [/(?:matrix|table|heatmap|capability|feature-matrix|risk|pitfalls|矩阵|表格|热力|风险|踩坑)/i, 'matrix'],
  [/(?:architecture|overview|swimlane|organization|full-image|transformer|stack|mechanism|diagram|double-loop|combined-solution|example-mnist|全景|架构|泳道|组织|技术栈|原理|双轮|双圆)/i, 'diagram'],
  [/(?:screenshot|case-study|annotated|reading|lab|tool-demo|projector|evidence|trend-data|memo|qr|案例|截图|批注|实验|工具|纪要|二维码)/i, 'evidence'],
  [/(?:layer|mixed-sequence|multi-layer|troubleshooting|切换|排障)/i, 'interactive'],
  [/(?:image-text|split|parameter-code|detailed-value|左图右文|左右)/i, 'split'],
  [/(?:card-grid|dense-columns|kpi|metrics|team|honors|pain-point|grid|卡片|多栏|数据墙|团队|荣誉|痛点)/i, 'grid'],
];

function catalogError(code, statusCode, message) {
  return Object.assign(new Error(message), { code, statusCode });
}

function contains(parent, child) {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

function inferVisualFamily(pageTypeId, sourceLabel, role) {
  if (role) return role;
  const value = `${pageTypeId} ${sourceLabel}`;
  return FAMILY_RULES.find(([pattern]) => pattern.test(value))?.[1] ?? 'custom';
}

function inferDensity(visualFamily) {
  if (['cover', 'toc', 'thanks', 'transition', 'question', 'statement'].includes(visualFamily)) {
    return 'light';
  }
  if (['grid', 'matrix', 'diagram', 'interactive'].includes(visualFamily)) return 'dense';
  return 'medium';
}

function inferRhythmRole(visualFamily) {
  if (['cover', 'toc', 'thanks'].includes(visualFamily)) return 'fixed';
  if (['transition', 'question', 'statement'].includes(visualFamily)) return 'breather';
  if (visualFamily === 'evidence') return 'evidence';
  return 'explanation';
}

function decodeTemplateBundle(contents, templateId) {
  const match = contents.match(/<script\s+type=["']__bundler\/template["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!match) throw catalogError('TEMPLATE_CATALOG_INVALID', 500, `模板缺少 bundle template：${templateId}`);
  let html;
  try { html = JSON.parse(match[1].trim()); }
  catch { throw catalogError('TEMPLATE_CATALOG_INVALID', 500, `模板 bundle 无法解码：${templateId}`); }
  const pages = [];
  const sections = html.matchAll(/<section\b[\s\S]*?<\/section>/gi);
  for (const match of sections) {
    const opening = match[0].match(/^<section\b[^>]*>/i)?.[0] ?? '';
    const label = opening.match(/\bdata-label=(?:"([^"]*)"|'([^']*)')/i);
    if (!label) continue;
    const steps = [...match[0].matchAll(/\bdata-step=(?:"(\d+)"|'(\d+)')/gi)]
      .map(item => Number(item[1] ?? item[2]));
    pages.push({
      label:label[1] ?? label[2] ?? '',
      defaultSteps:steps.length ? Math.max(...steps) + 2 : 1,
    });
  }
  if (!pages.length) throw catalogError('TEMPLATE_CATALOG_INVALID', 500, `模板没有可用页面：${templateId}`);
  return pages;
}

function normalizeTemplate(item, sourcePath, sourcePages) {
  const requiredPages = Array.isArray(item.requiredPages) ? item.requiredPages : [];
  const explicitPageTypes = Array.isArray(item.pageTypes) ? item.pageTypes : [];
  const bySourcePage = new Map();
  const ids = new Set();
  for (const page of [...requiredPages, ...explicitPageTypes]) {
    if (!page || typeof page.pageTypeId !== 'string' || !page.pageTypeId
      || ids.has(page.pageTypeId) || !Number.isSafeInteger(page.sourcePage)
      || page.sourcePage < 1 || page.sourcePage > sourcePages.length
      || bySourcePage.has(page.sourcePage)
      || (page.compatibleWith !== undefined && (
        !Array.isArray(page.compatibleWith)
        || page.compatibleWith.some(value => typeof value !== 'string' || !value)
        || new Set(page.compatibleWith).size !== page.compatibleWith.length
      ))) {
      throw catalogError('TEMPLATE_CATALOG_INVALID', 500, `模板页型配置无效：${item.templateId}`);
    }
    ids.add(page.pageTypeId);
    bySourcePage.set(page.sourcePage, page);
  }
  const expectedRoles = new Map([
    ['cover', { position:'first', sourcePage:1, preserveLayout:true }],
    ['toc', { position:'second', sourcePage:2, adaptiveToc:true }],
    ['thanks', { position:'last', sourcePage:sourcePages.length, preserveLayout:true }],
  ]);
  const roles = new Set(requiredPages.map(page => page.role));
  if (requiredPages.length !== 3 || roles.size !== 3
    || ![...expectedRoles].every(([role, expected]) => {
      const page = requiredPages.find(candidate => candidate.role === role);
      return page?.position === expected.position && page?.sourcePage === expected.sourcePage
        && (!expected.preserveLayout || page?.preserveLayout === true)
        && (!expected.adaptiveToc || page?.adaptiveToc === true);
    })) {
    throw catalogError('TEMPLATE_CATALOG_INVALID', 500, `模板未声明封面、目录或感谢页：${item.templateId}`);
  }
  const pageTypes = sourcePages.map((sourcePageInfo, index) => {
    const sourcePage = index + 1;
    const configured = bySourcePage.get(sourcePage);
    const sourceLabel = sourcePageInfo.label;
    const pageTypeId = configured?.pageTypeId ?? `source-page-${String(sourcePage).padStart(2, '0')}`;
    const visualFamily = configured?.visualFamily
      ?? inferVisualFamily(pageTypeId, sourceLabel, configured?.role);
    return {
      pageTypeId,
      name:configured?.name ?? sourceLabel,
      sourcePage,
      sourceLabel,
      sourceTemplateId:item.templateId,
      defaultSteps:configured?.defaultSteps ?? sourcePageInfo.defaultSteps,
      repeatable:configured?.repeatable ?? !configured?.role,
      visualFamily,
      density:configured?.density ?? inferDensity(visualFamily),
      rhythmRole:configured?.rhythmRole ?? inferRhythmRole(visualFamily),
      compatibleWith:configured?.compatibleWith ?? [item.templateId],
      useWhen:configured?.useWhen ?? '',
      borrowed:false,
      ...(configured?.role ? { role:configured.role } : {}),
      ...(configured?.position ? { position:configured.position } : {}),
      preserveLayout:Boolean(configured?.preserveLayout),
      adaptiveToc:Boolean(configured?.adaptiveToc),
    };
  });
  return {
    ...structuredClone(item),
    requiredPages:requiredPages.map(page => page.pageTypeId),
    pageTypes,
    pageCount:sourcePages.length,
    sourcePath,
  };
}

function attachAvailablePageTypes(templates) {
  const templateIds = new Set(templates.map(template => template.templateId));
  for (const template of templates) {
    for (const page of template.pageTypes) {
      if (page.compatibleWith.some(templateId => !templateIds.has(templateId))) {
        throw catalogError(
          'TEMPLATE_CATALOG_INVALID', 500,
          `页型兼容列表引用了未知模板：${template.templateId} / ${page.pageTypeId}`,
        );
      }
    }
  }
  return templates.map(template => {
    const available = template.pageTypes.map(page => structuredClone(page));
    const byId = new Map(available.map(page => [page.pageTypeId, page]));
    for (const sourceTemplate of templates) {
      if (sourceTemplate.templateId === template.templateId) continue;
      for (const page of sourceTemplate.pageTypes) {
        if (page.role || !page.compatibleWith.includes(template.templateId)) continue;
        if (byId.has(page.pageTypeId)) continue;
        const borrowed = { ...structuredClone(page), borrowed:true };
        available.push(borrowed);
        byId.set(borrowed.pageTypeId, borrowed);
      }
    }
    return { ...template, availablePageTypes:available };
  });
}

export class TemplateCatalog {
  static async open({ catalogPath = DEFAULT_CATALOG_PATH, projectDir = PROJECT_DIR } = {}) {
    const value = JSON.parse(await readFile(catalogPath, 'utf8'));
    if (value?.version !== 2 || !Array.isArray(value.templates) || value.templates.length === 0) {
      throw catalogError('TEMPLATE_CATALOG_INVALID', 500, '模板目录格式无效');
    }
    const root = await realpath(projectDir);
    const templates = [];
    const ids = new Set();
    for (const item of value.templates) {
      if (!item || typeof item.templateId !== 'string' || ids.has(item.templateId)
        || typeof item.name !== 'string' || typeof item.source !== 'string'
        || !Array.isArray(item.pageTypes) || !Array.isArray(item.requiredPages)) {
        throw catalogError('TEMPLATE_CATALOG_INVALID', 500, '模板目录含有无效或重复条目');
      }
      const source = await realpath(join(root, item.source)).catch(() => null);
      if (!source || !contains(root, source) || !(await stat(source)).isFile()) {
        throw catalogError('TEMPLATE_CATALOG_INVALID', 500, `模板文件不存在或逃逸项目目录：${item.templateId}`);
      }
      ids.add(item.templateId);
      const sourcePages = decodeTemplateBundle(await readFile(source, 'utf8'), item.templateId);
      templates.push(normalizeTemplate(item, source, sourcePages));
    }
    return new TemplateCatalog(
      attachAvailablePageTypes(templates),
      { catalogPath:await realpath(catalogPath) },
    );
  }

  constructor(templates, { catalogPath = DEFAULT_CATALOG_PATH } = {}) {
    this.templates = templates;
    this.byId = new Map(templates.map(template => [template.templateId, template]));
    this.catalogPath = catalogPath;
  }

  snapshot() {
    return {
      version:2,
      templates:this.templates.map(({ sourcePath, ...template }) => structuredClone(template)),
    };
  }

  resolve(templateId) {
    const template = this.byId.get(templateId);
    if (!template) throw catalogError('TEMPLATE_NOT_ALLOWED', 400, `不允许使用模板：${String(templateId)}`);
    return { ...structuredClone(template), sourcePath:template.sourcePath };
  }

  resolvePageType(templateId, pageTypeId) {
    const template = this.resolve(templateId);
    const pageType = template.availablePageTypes.find(page => page.pageTypeId === pageTypeId);
    if (!pageType) {
      throw catalogError('PAGE_TYPE_NOT_ALLOWED', 422, `模板中不存在可用页型：${String(pageTypeId)}`);
    }
    return pageType;
  }

  validatePagePlan(templateId, pagePlan) {
    const template = this.resolve(templateId);
    const pages = pagePlan?.pages;
    if (!Array.isArray(pages)) {
      throw catalogError('PAGE_PLAN_TEMPLATE_MISMATCH', 422, '页面规划缺少 pages');
    }
    const types = new Map(template.availablePageTypes.map(page => [page.pageTypeId, page]));
    const counts = new Map();
    const contentPages = [];
    const borrowedPageTypes = new Set();
    for (const page of pages) {
      const type = types.get(page?.pageTypeId);
      if (!type) {
        throw catalogError(
          'PAGE_TYPE_NOT_ALLOWED', 422,
          `页面“${page?.label ?? page?.pageId ?? '未命名'}”使用了模板中不存在的页型：${String(page?.pageTypeId)}`,
        );
      }
      const count = (counts.get(type.pageTypeId) ?? 0) + 1;
      counts.set(type.pageTypeId, count);
      if (!type.repeatable && count > 1) {
        throw catalogError('PAGE_TYPE_NOT_REPEATABLE', 422, `页型不可重复：${type.pageTypeId}`);
      }
      if (!type.role) {
        if (typeof page.layoutRationale !== 'string' || !page.layoutRationale.trim()) {
          throw catalogError(
            'PAGE_LAYOUT_RATIONALE_REQUIRED', 422,
            `页面“${page?.label ?? page?.pageId ?? '未命名'}”必须说明页型选择理由`,
          );
        }
        if (typeof page.artwork !== 'string' || !page.artwork.trim()) {
          throw catalogError(
            'PAGE_ARTWORK_PLAN_REQUIRED', 422,
            `页面“${page?.label ?? page?.pageId ?? '未命名'}”必须填写配图或证据计划；无需配图时写“无”`,
          );
        }
        contentPages.push({ page, type });
        if (type.borrowed) borrowedPageTypes.add(type.pageTypeId);
      }
    }
    const required = template.pageTypes.filter(page => page.role);
    for (const type of required) {
      if (counts.get(type.pageTypeId) !== 1) {
        throw catalogError('REQUIRED_TEMPLATE_PAGE_MISSING', 422, `页面规划必须且只能包含一个${type.name}`);
      }
      const index = pages.findIndex(page => page.pageTypeId === type.pageTypeId);
      const validPosition = type.position === 'first' ? index === 0
        : type.position === 'second' ? index === 1
          : type.position === 'last' ? index === pages.length - 1 : true;
      if (!validPosition) {
        throw catalogError('REQUIRED_TEMPLATE_PAGE_POSITION', 422, `${type.name}位置必须为 ${type.position}`);
      }
    }
    for (let index = MAX_CONSECUTIVE_VISUAL_FAMILY; index < contentPages.length; index += 1) {
      const run = contentPages.slice(index - MAX_CONSECUTIVE_VISUAL_FAMILY, index + 1);
      if (run.every(item => item.type.visualFamily === run[0].type.visualFamily)) {
        throw catalogError(
          'PAGE_VISUAL_FAMILY_REPETITION', 422,
          `连续 ${run.length} 页使用同一视觉家族“${run[0].type.visualFamily}”：`
            + run.map(item => item.page.label).join('、'),
        );
      }
    }
    const byChapter = new Map();
    for (const item of contentPages) {
      const chapterId = item.page.chapterId ?? '';
      if (!byChapter.has(chapterId)) byChapter.set(chapterId, []);
      byChapter.get(chapterId).push(item);
    }
    for (const [chapterId, chapterPages] of byChapter) {
      if (chapterPages.length >= 4
        && new Set(chapterPages.map(item => item.type.visualFamily)).size < 2) {
        throw catalogError(
          'PAGE_CHAPTER_VISUAL_VARIETY_REQUIRED', 422,
          `章节“${chapterId || '未分章'}”包含 ${chapterPages.length} 个内容页，但只有一种视觉家族`,
        );
      }
    }
    return {
      templateId,
      pageCount:pages.length,
      requiredPages:[...template.requiredPages],
      visualFamilies:[...new Set(contentPages.map(item => item.type.visualFamily))],
      borrowedPageTypes:[...borrowedPageTypes],
    };
  }
}
