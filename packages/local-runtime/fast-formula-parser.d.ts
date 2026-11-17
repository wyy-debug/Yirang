declare module 'fast-formula-parser' {
  class FormulaError extends Error {
    constructor(error: string, msg?: string);
    static REF: FormulaError;
    static VALUE: FormulaError;
    static NAME: FormulaError;
    static NUM: FormulaError;
  }
  export default class FormulaParser {
    static FormulaError: typeof FormulaError;
    constructor(config: {
      functions?: Record<string, Function>;
      onVariable: Function;
      onCell: Function;
      onRange: Function;
    });
    parse(formula: string, position: { sheet: string; row: number; col: number }): any;
    callFunction(name: string, args: unknown[]): any;
  }
}
