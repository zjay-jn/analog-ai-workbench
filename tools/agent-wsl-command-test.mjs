// Pure, in-memory TypeScript verification. No WSL, app, build output or APIs.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url),ts=require('typescript');
for(const extension of ['.ts','.tsx'])require.extensions[extension]=(module,file)=>module._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2023,module:ts.ModuleKind.CommonJS,esModuleInterop:true,jsx:ts.JsxEmit.ReactJSX},fileName:file}).outputText,file);
const product=path.resolve(import.meta.dirname,'..');
for(const file of ['agent-wsl-command-driver','agent-command-wsl-contract','agent-wsl-process-policy','agent-wsl-command-presentation','agent-wsl-command-security'])require(path.join(product,'tests/'+file+'.test.ts'));
