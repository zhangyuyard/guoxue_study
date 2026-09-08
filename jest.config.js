/**
 * Jest 配置（最小化）
 * - testEnvironment: node —— 单测聚焦 zustand store 逻辑，无需 RN 渲染环境
 * - transform 内联 babel 配置并关闭 configFile，避免加载 RN 专用 babel.config.js
 *   （reanimated plugin / module-resolver），路径别名改由 moduleNameMapper 承担
 * - setupFiles 加载原生模块（MMKV / quick-sqlite）mock，详见 jestSetupFile.js
 */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  transform: {
    '^.+\\.tsx?$': [
      'babel-jest',
      {
        configFile: false,
        presets: [
          ['@babel/preset-env', { targets: { node: 'current' } }],
          '@babel/preset-typescript',
        ],
      },
    ],
  },
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },
  setupFiles: ['<rootDir>/jestSetupFile.js'],
  // __tests__ 目录下的共享 helper（无 test 用例）不作为测试套件收集
  testPathIgnorePatterns: ['/node_modules/', '\\.helper\\.tsx?$'],
};
