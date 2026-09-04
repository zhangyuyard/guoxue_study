const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

/**
 * Metro 打包配置
 * - 支持 JSON 静态资源直接打包进 Bundle
 * - 支持 SVG 文件解析
 * - 禁用 0.74 默认的静态资源混淆，保证 JSON 数据在运行时以 require 方式可读
 */
const config = {
  resolver: {
    sourceExts: ['js', 'jsx', 'ts', 'tsx', 'json', 'svg'],
    assetExts: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'ttf', 'otf', 'woff', 'woff2'],
  },
  transformer: {
    // 大 JSON 文件（词典数据）避免 inline 到 bundle，按资源加载
    inlineRequires: true,
  },
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
