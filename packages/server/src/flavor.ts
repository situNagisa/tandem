// 构建风味：默认 debug；发布构建会把 dist/flavor.js 固定为 release。
export type TandemFlavor = 'debug' | 'release';

export const FLAVOR: TandemFlavor = process.env.TANDEM_FLAVOR === 'release' ? 'release' : 'debug';
export const IS_DEBUG_FLAVOR = FLAVOR === 'debug';
