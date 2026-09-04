/**
 * opencc-js 类型声明
 * 该库未随包提供 TypeScript 类型（main 指向 umd/full.js），此处补充最小可用类型。
 */
declare module 'opencc-js' {
  export interface ConverterOptions {
    from?: string;
    to?: string;
  }

  export function Converter(options?: ConverterOptions): (text: string) => string;
}
