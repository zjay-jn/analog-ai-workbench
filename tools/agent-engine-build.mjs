// QA-owned invocation only. No package/dependency install and no shared dist mutation.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
if(root.toLowerCase()!=='c:\\work\\analog_ai_workbench')throw new Error('Pilot build root unavailable');
const output=path.join(root,'.local','agent-engine-pilot-build');
await build({configFile:false,define:{__AAW_MAIN_DEVELOPMENT__:'false'},build:{emptyOutDir:true,minify:false,outDir:path.join(output,'main'),ssr:path.join(root,'apps/desktop/src/main/engine-pilot-index.ts'),target:'node24',rollupOptions:{external:['electron'],output:{entryFileNames:'index.cjs',format:'cjs'}}},ssr:{external:['electron'],noExternal:true,target:'node'}});
await build({configFile:false,define:{__AAW_MAIN_DEVELOPMENT__:'false'},build:{emptyOutDir:false,minify:false,outDir:path.join(output,'main'),ssr:path.join(root,'apps/desktop/src/main/engine-pilot-native-index.ts'),target:'node24',rollupOptions:{external:['electron'],output:{entryFileNames:'native.cjs',format:'cjs'}}},ssr:{external:['electron'],noExternal:true,target:'node'}});
await build({configFile:false,build:{emptyOutDir:true,minify:false,outDir:path.join(output,'dist','preload','preload'),ssr:path.join(root,'apps/desktop/src/preload/engine-pilot.ts'),target:'node24',rollupOptions:{external:['electron'],output:{entryFileNames:'engine-pilot.js',format:'cjs'}}},ssr:{external:['electron'],noExternal:true,target:'node'}});
console.log('Pilot main/preload compiled in isolated output. QA must build renderer at .local/agent-engine-pilot-build/dist/renderer without modifying shared dist.');
