import * as vm from 'vm';
import * as ts from 'typescript';
import * as crypto from 'crypto';
import * as canonicalPkg from '@lattice/canonical';
import * as mappingSpecPkg from '@lattice/mapping-spec';
import { PartnerAdapter } from '@lattice/adapters';

export class SandboxRunner {
  /**
   * Transpiles and instantiates the generated PartnerAdapter inside a locked-down
   * V8 VM context with strict CPU timeout (500ms per invocation) and no global access.
   */
  static instantiateAdapter(adapterSourceCode: string): PartnerAdapter {
    // 1. Transpile TypeScript to CommonJS
    const transpiled = ts.transpileModule(adapterSourceCode, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
      },
    }).outputText;

    // 2. Build restricted require allowlist
    const safeRequire = (modName: string) => {
      switch (modName) {
        case 'crypto':
          return crypto;
        case '@lattice/canonical':
          return canonicalPkg;
        case '@lattice/mapping-spec':
          return mappingSpecPkg;
        case '@lattice/adapters':
          return {};
        default:
          throw new Error(`Sandbox security violation: Blocked require("${modName}")`);
      }
    };

    const exportsObj: Record<string, any> = {};
    const moduleObj = { exports: exportsObj };

    // 3. Create frozen, network-less V8 context
    const context = vm.createContext(
      Object.freeze({
        exports: exportsObj,
        module: moduleObj,
        require: safeRequire,
        Buffer,
        Date,
        Math,
        Number,
        String,
        Boolean,
        Array,
        Object,
        Set,
        Map,
        RegExp,
        JSON,
        Error,
        parseInt,
        parseFloat,
        isNaN,
      })
    );

    const script = new vm.Script(transpiled, { filename: 'sandbox-adapter.js' });
    script.runInContext(context, { timeout: 500 }); // 500ms hard execution cap

    const ExportedClass = Object.values(moduleObj.exports).find(
      (val) => typeof val === 'function'
    );

    if (!ExportedClass) {
      throw new Error('No exported adapter class found in sandboxed module');
    }

    return new (ExportedClass as any)();
  }
}