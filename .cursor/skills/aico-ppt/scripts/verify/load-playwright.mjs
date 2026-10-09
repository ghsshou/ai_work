import { connectDesktopRenderer } from './desktop-renderer.mjs';

/** 原装宿主的插件模式只使用私有浏览器；旧桌面模式使用其既有渲染服务。 */
export function chromiumLaunchOptions(environment = process.env) {
  if (environment.AICO_RUNTIME_KIND === 'desktop') return {};
  const executablePath = environment.AICO_BROWSER_EXECUTABLE;
  if (environment.AICO_RUNTIME_KIND === 'plugin' && executablePath === undefined) {
    throw new Error('插件渲染缺少私有浏览器路径，请修复 PPT 资源安装');
  }
  if (executablePath === undefined) return { channel:'chrome', headless:true };
  if (!executablePath.trim()) throw new Error('AICO 内置浏览器路径不能为空');
  return { executablePath, headless:true };
}

export async function loadChromium() {
  if (process.env.AICO_RUNTIME_KIND === 'desktop') return { launch:() => connectDesktopRenderer() };
  const candidates = [process.env.PLAYWRIGHT_CORE, 'playwright-core',
    '/opt/homebrew/lib/node_modules/openclaw/node_modules/playwright-core/index.js'].filter(Boolean);
  for (const candidate of candidates) {
    try { const mod = await import(candidate); return (mod.default ?? mod).chromium; } catch {}
  }
  throw new Error(`无法加载 playwright-core（已尝试: ${candidates.join(' → ')}）`);
}
