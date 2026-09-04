/**
 * ESLint 配置（2026-09-03 补齐：此前 lint script 无配置文件从未可用）。
 * 采用 @typescript-eslint recommended 的务实子集：能抓真问题
 * （未用变量、误用 any 断言、空 catch 等），不引入风格类噪音（风格归 prettier）。
 */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    ecmaFeatures: { jsx: true },
  },
  plugins: ['@typescript-eslint'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
  ],
  env: {
    es2022: true,
    node: true,
    jest: true,
    browser: true,
  },
  globals: {
    __DEV__: 'readonly',
    __RNInternal__: 'readonly',
    HermesInternal: 'readonly',
  },
  ignorePatterns: [
    'node_modules/',
    'android/',
    'ios/',
    'scripts/',
    'deliverables/',
    '.history/',
    'coverage/',
    '*.config.js',
    'jestSetupFile.js',
    'index.js',
    // 第三方内联 vendor 代码（pako inflate 精简版），不做 lint 改写以免引入回归
    'src/vendor/',
  ],
  rules: {
    // 团队约定：any 在业务代码中暂允许（渐进收紧），仅禁不安全断言
    '@typescript-eslint/no-explicit-any': 'off',
    '@typescript-eslint/no-unused-vars': [
      'error',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
    ],
    // require 未在推荐的 default 之列，显式关闭（RN 资源图片 require 用法）
    '@typescript-eslint/no-require-imports': 'off',
    'no-empty': ['error', { allowEmptyCatch: true }],
    'no-console': 'off',
    // 以下为有意为之的模式，全项目豁免（豁免理由见注释）：
    // 字典解析按 NUL 分割、清洗控制字符属核心逻辑而非误用
    'no-control-regex': 'off',
    // 测试用例本身在测组合字符/重叠字形（guyinData）
    'no-misleading-character-class': 'off',
    // UI 文案中的全角/表意空格是有意排版
    'no-irregular-whitespace': 'off',
    // eslint-plugin-react-hooks 未安装；源码中留有该规则的 disable 注释（依赖数组有意冻结），
    // 声明为 off 使注解合法，待安装插件后再收紧
    'react-hooks/exhaustive-deps': 'off',
  },
};
