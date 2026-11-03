import {resolve} from 'node:path';
import {defineConfig} from 'vite';
export default defineConfig({define:{__AAW_MAIN_DEVELOPMENT__:'false'},build:{emptyOutDir:true,minify:false,outDir:resolve(import.meta.dirname,'../../dist/cloud/main'),rollupOptions:{external:['electron'],output:{entryFileNames:'index.js',format:'cjs'}},sourcemap:false,ssr:resolve(import.meta.dirname,'src/main/cloud-index.ts'),target:'node24'},ssr:{external:['electron'],noExternal:true,target:'node'}});
