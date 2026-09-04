/**
 * 解析器注册入口（PARSER_REGISTRY 唯一装配点）
 *
 * 修复 P0：PARSER_REGISTRY 依赖 parser 模块的副作用 push 注册，
 * 但 DictImportService 只 import `parsers/types` 拿到的是空注册表，
 * 生产运行时 findParser() 遍历空数组 → 所有格式报「暂不支持的字典格式」。
 *
 * 约定：任何需要遍历 PARSER_REGISTRY 的消费方必须从本模块（或
 * '@/services/dict/parsers'）导入，禁止直接从 './parsers/types' 导入
 * 注册表——后者未经装配（测试文件 import parser 恰好完成注册会掩盖问题）。
 */
import { PARSER_REGISTRY } from './types';
import './TextDictParser'; // 副作用注册 csv/tsv/json/txt
import './MDictParser'; // 副作用注册 mdx/mdd

export { PARSER_REGISTRY };
export type { DictParser, ParsedEntry, DictParserContext } from './types';
