/** 模块加载时固定版本，磁盘升级不能改变仍在运行的服务身份。 */
import {createRequire} from 'node:module';
export const runtimeVersion=createRequire(import.meta.url)('../../package.json').version;
