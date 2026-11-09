// 构建风味：源码默认 debug；scripts/write-flavor.mjs 在构建后用常量覆盖 dist/flavor.js，
// 所以打包产物运行时不读 TANDEM_FLAVOR 环境变量（只有直接跑 src 的测试/开发会读）。
export type TandemFlavor = 'debug' | 'release';

export const FLAVOR: TandemFlavor = process.env.TANDEM_FLAVOR === 'release' ? 'release' : 'debug';
export const IS_DEBUG_FLAVOR = FLAVOR === 'debug';
