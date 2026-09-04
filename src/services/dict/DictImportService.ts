/**
 * 字典导入服务（DictImportService）
 * 主流程（§4.6 时序②）：
 *   建 dicts 行(计数 0) → 流式解析分批 insertEntries → 回填 entry_count → store 刷新
 * - 单文件格式经 PARSER_REGISTRY 按 (fileName, firstBytes) 分发
 * - StarDict 三件套（.ifo + .idx(.dz/.gz) + .dict(.dz)）经 importStarDict 成组导入
 * - 全链路 isCancelled / onProgress(entryCount)（计数而非百分比）
 * - 取消/失败：清理半成品 dict_id 行（entries + dicts）
 * - mdd 资源：走 resources 表；单文件 >1MB 跳过并计数；总量上限 50MB
 */
import type { DictEntry, ServiceResult } from '@/types';
import type { DictFormat, ImportReport } from '@/types/dict';
import { genId, nowISO } from '@/services/StorageService';
import * as DictDatabase from '@/services/dict/DictDatabase';
import { DictFileService } from '@/services/dict/DictFileService';
import { normalizeHeadword } from '@/services/dict/DictEngine';
// 注意：必须从 parsers/index（显式装配模块）导入注册表，
// 直接从 parsers/types 导入拿到的是未注册任何解析器的空数组（P0 修复）。
import { PARSER_REGISTRY, type DictParser, type ParsedEntry } from '@/services/dict/parsers';
import {
  makeStarDictParser,
  parseIfoBytes,
  validateIfo,
  type StarDictChunkReader,
} from '@/services/dict/parsers/StarDictParser';
import { useDictStore } from '@/store/useDictStore';

/** 错误明细上限（超出聚合计数，§4.4） */
const MAX_ERRORS = 100;

/** mdd 单资源上限（1MB，§9.6） */
const MAX_RESOURCE_BYTES = 1024 * 1024;
/** mdd 资源总量上限（50MB，§9.6） */
const MAX_RESOURCES_TOTAL_BYTES = 50 * 1024 * 1024;

/** 去扩展名的显示名 */
function baseName(fileName: string): string {
  const idx = fileName.lastIndexOf('.');
  return idx > 0 ? fileName.slice(0, idx) : fileName;
}

/** ParsedEntry → DictEntry（补 dictId/headwordNorm；id 由库 AUTOINCREMENT 生成，占位 0） */
function toDictEntry(dictId: string, parsed: ParsedEntry): DictEntry {
  return {
    id: 0,
    dictId,
    headword: parsed.headword,
    headwordNorm: normalizeHeadword(parsed.headword),
    pinyin: parsed.pinyin,
    readings: parsed.readings,
    contentType: parsed.contentType,
    content: parsed.content,
    extra: parsed.extra,
  };
}

/** 依据文件名 + 首字节从注册表分发解析器 */
function findParser(fileName: string, firstBytes: Uint8Array): DictParser | null {
  for (const parser of PARSER_REGISTRY) {
    try {
      if (parser.sniff(fileName, firstBytes)) {
        return parser;
      }
    } catch {
      // 单个解析器 sniff 异常不影响后续尝试
    }
  }
  return null;
}

/** 导入文件描述（单文件与成组导入共用） */
interface IngestFileInfo {
  /** 进度/报告展示名（成组导入为 .ifo 文件名） */
  fileName: string;
  size: number;
  displayName?: string;
}

/** 解析器形态：单文件 parser 与 StarDict parserLike 的公共子集 */
interface IngestParserLike {
  format: string;
  parse(ctx: {
    fileSize: number;
    readChunk(position: number, length: number): Promise<Uint8Array>;
    onProgress(entryCount: number): void;
    isCancelled(): boolean;
    reportError(e: { at?: number | string; reason: string }): void;
  }): AsyncGenerator<ParsedEntry[], void, void>;
}

export const DictImportService = {
  /**
   * 单文件导入主流程：分发解析器后进入 ingestParser。
   */
  async importFromFile(
    file: { uri: string; fileName: string; size: number },
    opts: {
      displayName?: string;
      langPair?: string;
      onProgress?: (entryCount: number) => void;
      isCancelled?: () => boolean;
    } = {},
  ): Promise<ServiceResult<ImportReport>> {
    let reader: Awaited<ReturnType<typeof DictFileService.createChunkReader>> | null = null;
    try {
      reader = await DictFileService.createChunkReader(file.uri);
      const firstBytes = await reader.readChunk(0, 16);
      const parser = findParser(file.fileName, firstBytes);
      if (!parser) {
        return {
          success: false,
          error: `暂不支持的字典格式：${file.fileName}（支持 csv/tsv/json/txt/mdx/mdd；StarDict 请成组选择 .ifo/.idx/.dict 三件套）`,
        };
      }
      return await ingestParser(
        { fileName: file.fileName, size: file.size, displayName: opts.displayName },
        reader,
        parser,
        opts,
      );
    } catch (e) {
      return { success: false, error: `导入失败：${(e as Error).message}` };
    }
  },

  /**
   * StarDict 成组导入：files 为多选文件列表，按扩展名归类：
   *   .ifo（恰好 1 个）+ .idx/.idx.gz/.idx.dz（1 个）+ .dict/.dict.dz（1 个）
   * 校验通过后装配 StarDictParserLike 进入 ingestParser，dictId 取自 .ifo 文件。
   */
  async importStarDict(
    files: Array<{ uri: string; fileName: string; size: number }>,
    opts: {
      displayName?: string;
      langPair?: string;
      onProgress?: (entryCount: number) => void;
      isCancelled?: () => boolean;
    } = {},
  ): Promise<ServiceResult<ImportReport>> {
    try {
      let ifoFile: (typeof files)[number] | null = null;
      let idxFile: (typeof files)[number] | null = null;
      let dictFile: (typeof files)[number] | null = null;
      const unknown: string[] = [];
      for (const f of files) {
        const lower = f.fileName.toLowerCase();
        if (lower.endsWith('.ifo')) {
          if (ifoFile) {
            return { success: false, error: '选择了多个 .ifo 文件，请一次只导入一部 StarDict 词典' };
          }
          ifoFile = f;
        } else if (/\.idx(\.(dz|gz))?$/.test(lower)) {
          if (idxFile) {
            return {
              success: false,
              error: `选择了多个 .idx 文件（${idxFile.fileName} 与 ${f.fileName}），一次只能导入一部词典`,
            };
          }
          idxFile = f;
        } else if (/\.dict(\.(dz|gz))?$/.test(lower)) {
          if (dictFile) {
            return {
              success: false,
              error: `选择了多个 .dict 文件（${dictFile.fileName} 与 ${f.fileName}），一次只能导入一部词典`,
            };
          }
          dictFile = f;
        } else {
          unknown.push(f.fileName);
        }
      }
      if (!ifoFile || !idxFile || !dictFile) {
        return {
          success: false,
          error: `StarDict 需要三个文件成组导入：.ifo + .idx（可 .dz/.gz）+ .dict（可 .dz）${
            unknown.length > 0 ? `；无法识别：${unknown.join('、')}` : ''
          }`,
        };
      }

      // 读 .ifo（小文件，一次读完）
      const ifoReader = await DictFileService.createChunkReader(ifoFile.uri);
      const ifoBytes = await ifoReader.readChunk(0, ifoReader.fileSize);
      const ifo = parseIfoBytes(ifoBytes);
      const ifoError = validateIfo(ifo);
      if (ifoError) {
        return { success: false, error: ifoError };
      }

      const idxReader = await DictFileService.createChunkReader(idxFile.uri);
      const dictReader = await DictFileService.createChunkReader(dictFile.uri);
      const parser = makeStarDictParser({
        ifo,
        idx: idxReader as StarDictChunkReader,
        dict: dictReader as StarDictChunkReader,
      });

      const displayName = opts.displayName?.trim() || ifo.bookname?.trim() || baseName(ifoFile.fileName);
      const res = await ingestParser(
        { fileName: ifoFile.fileName, size: ifoFile.size, displayName },
        idxReader,
        parser,
        opts,
      );
      // 成组导入成功但带了误选的无关文件：附 warnings 提示（不改变成功/失败语义）
      if (res.success && res.data && unknown.length > 0) {
        res.data.warnings = [`已忽略 ${unknown.length} 个无关文件：${unknown.join('、')}`];
      }
      return res;
    } catch (e) {
      return { success: false, error: `StarDict 导入失败：${(e as Error).message}` };
    }
  },
};

/**
 * 通用入库主流程（单文件与 StarDict 成组共用）：
 * 建 dicts 行(计数 0) → 流式解析分批入库 → 回填 entry_count → store 刷新。
 * 返回 ImportReport（含取消/失败信息；取消与失败均清理半成品行）。
 */
async function ingestParser(
  info: IngestFileInfo,
  reader: { fileSize: number; readChunk(position: number, length: number): Promise<Uint8Array> },
  parser: IngestParserLike,
  opts: {
    displayName?: string;
    langPair?: string;
    onProgress?: (entryCount: number) => void;
    isCancelled?: () => boolean;
  },
): Promise<ServiceResult<ImportReport>> {
  const startedAt = Date.now();
  const dictId = genId('user');
  const isCancelled = opts.isCancelled ?? (() => false);
  const store = useDictStore.getState();

  /** 错误收集（上限 + 溢出计数） */
  const errors: ImportReport['errors'] = [];
  let overflowCount = 0;
  const reportError = (e: { at?: number | string; reason: string }): void => {
    if (errors.length < MAX_ERRORS) {
      errors.push(e);
    } else {
      overflowCount += 1;
    }
  };

  let report: ImportReport | null = null;
  let inserted = false;

  try {
    // 0) 打开库
    const openRes = DictDatabase.openDictDatabases();
    if (!openRes.success) {
      return { success: false, error: openRes.error };
    }

    // 1) 建 dicts 行（entry_count = 0；完成后回填）
    const name = opts.displayName?.trim() || info.displayName?.trim() || baseName(info.fileName);
    DictDatabase.insertDictRow({
      id: dictId,
      name,
      kind: 'user',
      format: (parser.format === 'mdd' ? 'mdx' : parser.format) as DictFormat,
      entryCount: 0,
      description: `从文件 ${info.fileName} 导入`,
      sizeBytes: info.size,
      createdAt: nowISO(),
      langPair: opts.langPair?.trim() || undefined,
    });
    inserted = true;

    store.setImportStatus('parsing', { fileName: info.fileName, entryCount: 0 });

    // 2) 流式解析分批入库
    let totalEntries = 0;
    let resourcesBytes = DictDatabase.getResourcesTotalSize();
    let skippedResources = 0;

    const ctx = {
      fileSize: reader.fileSize,
      readChunk: reader.readChunk,
      onProgress: (entryCount: number): void => {
        opts.onProgress?.(entryCount);
        useDictStore.getState().setImportStatus('writing', { entryCount });
      },
      isCancelled,
      reportError,
    };

    for await (const batch of parser.parse(ctx)) {
      if (isCancelled()) {
        break;
      }

      const entries: DictEntry[] = [];
      for (const parsed of batch) {
        if (parsed.resource) {
          // mdd 资源：单文件上限 + 总量上限
          if (parsed.resource.sizeBytes > MAX_RESOURCE_BYTES) {
            skippedResources += 1;
            reportError({
              at: parsed.headword,
              reason: `资源超过 1MB 上限（${parsed.resource.sizeBytes} 字节），已跳过`,
            });
            continue;
          }
          if (resourcesBytes + parsed.resource.sizeBytes > MAX_RESOURCES_TOTAL_BYTES) {
            skippedResources += 1;
            reportError({
              at: parsed.headword,
              reason: `资源总量超过 50MB 上限，已跳过`,
            });
            continue;
          }
          DictDatabase.insertResource(
            parsed.headword,
            parsed.resource.mime,
            parsed.resource.sizeBytes,
            parsed.resource.dataBase64,
          );
          resourcesBytes += parsed.resource.sizeBytes;
          totalEntries += 1;
          continue;
        }
        entries.push(toDictEntry(dictId, parsed));
      }

      if (entries.length > 0) {
        useDictStore.getState().setImportStatus('writing', { fileName: info.fileName, entryCount: totalEntries });
        DictDatabase.insertEntries(dictId, entries);
        totalEntries += entries.length;
      }
    }

    // 3) 取消 → 清理半成品
    if (isCancelled()) {
      DictDatabase.deleteEntriesByDict(dictId);
      DictDatabase.deleteDictRow(dictId);
      useDictStore.getState().setImportStatus('cancelled', { fileName: info.fileName });
      report = {
        dictId,
        totalEntries: 0,
        failedCount: errors.length + overflowCount,
        errors,
        elapsedMs: Date.now() - startedAt,
        cancelled: true,
      };
      return { success: false, error: '导入已取消', data: report };
    }

    // 4) 回填 entry_count + store 刷新
    DictDatabase.updateEntryCount(dictId, totalEntries);
    useDictStore.getState().syncFromEngine();
    useDictStore.getState().setImportStatus('done', { fileName: info.fileName, entryCount: totalEntries });

    report = {
      dictId,
      totalEntries,
      failedCount: errors.length + overflowCount,
      errors,
      elapsedMs: Date.now() - startedAt,
      cancelled: false,
    };
    if (skippedResources > 0) {
      report.errors.push({
        at: '资源',
        reason: `另有 ${skippedResources} 个资源因超限被跳过`,
      });
    }
    return { success: true, data: report };
  } catch (e) {
    // 失败 → 清理半成品（已建 dicts 行时）
    if (inserted) {
      try {
        DictDatabase.deleteEntriesByDict(dictId);
        DictDatabase.deleteDictRow(dictId);
      } catch {
        // 清理失败不影响错误返回
      }
    }
    useDictStore.getState().setImportStatus('error', {
      fileName: info.fileName,
      error: (e as Error).message,
    });
    return {
      success: false,
      error: `导入失败：${(e as Error).message}`,
      data: {
        dictId,
        totalEntries: 0,
        failedCount: errors.length + overflowCount,
        errors,
        elapsedMs: Date.now() - startedAt,
        cancelled: false,
      },
    };
  }
}

export default DictImportService;
