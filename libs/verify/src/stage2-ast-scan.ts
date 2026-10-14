import { Project, SyntaxKind } from 'ts-morph';
import { StageResult, StageDiagnostic } from './types';

const ALLOWED_IMPORTS = new Set([
  'crypto',
  '@lattice/canonical',
  '@lattice/adapters',
  '@lattice/mapping-spec',
  'zod',
]);

const BANNED_IDENTIFIERS = new Set([
  'eval',
  'Function',
  'setTimeout',
  'setInterval',
  'setImmediate',
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'process',
  'require',
  'global',
  'globalThis',
  'child_process',
  'fs',
  'net',
  'http',
  'https',
]);

export class AstSecurityScanner {
  static verify(adapterFileName: string, adapterSourceCode: string): StageResult {
    const start = Date.now();
    const diagnostics: StageDiagnostic[] = [];

    const project = new Project({ useInMemoryFileSystem: true });
    const sourceFile = project.createSourceFile(adapterFileName, adapterSourceCode);

    // 1. Check all import declarations against strict allowlist
    for (const imp of sourceFile.getImportDeclarations()) {
      const moduleSpec = imp.getModuleSpecifierValue();
      if (!ALLOWED_IMPORTS.has(moduleSpec)) {
        const pos = sourceFile.getLineAndColumnAtPos(imp.getStart());
        diagnostics.push({
          stage: 'AST_SCAN',
          code: 'AST_FORBIDDEN_IMPORT',
          message: `Import "${moduleSpec}" is not permitted in generated adapters. Allowed: ${Array.from(ALLOWED_IMPORTS).join(', ')}`,
          line: pos.line,
          column: pos.column,
        });
      }
    }

    // 2. Scan all Identifiers for banned globals / runtime escape vectors
    sourceFile.forEachDescendant((node) => {
      if (node.getKind() === SyntaxKind.Identifier) {
        const text = node.getText();
        if (BANNED_IDENTIFIERS.has(text)) {
          const pos = sourceFile.getLineAndColumnAtPos(node.getStart());
          diagnostics.push({
            stage: 'AST_SCAN',
            code: 'AST_BANNED_IDENTIFIER',
            message: `Forbidden identifier "${text}" detected in generated code`,
            line: pos.line,
            column: pos.column,
          });
        }
      }
    });

    return {
      stage: 'AST_SCAN',
      passed: diagnostics.length === 0,
      durationMs: Date.now() - start,
      diagnostics,
    };
  }
}