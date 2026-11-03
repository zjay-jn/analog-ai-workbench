import {resolve} from 'node:path';
import {build,defineConfig} from 'vite';
const preload=(name:string)=>({build:{emptyOutDir:false,minify:false,outDir:resolve(import.meta.dirname,'../../dist/preload'),rollupOptions:{external:['electron'],output:{entryFileNames:`preload/${name}.js`,format:'cjs' as const}},sourcemap:false,ssr:resolve(import.meta.dirname,`src/preload/${name}.ts`),target:'node24'},ssr:{external:['electron'],noExternal:true as const,target:'node' as const}});
// Build separately: a sandbox preload must not require shared local chunks.
export default defineConfig({...preload('cloud'),plugins:[{name:'standalone-session-preload',async closeBundle(){await build({configFile:false,...preload('sessions')});}}]});
