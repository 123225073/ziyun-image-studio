import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import {readFile} from 'node:fs/promises';
// Read local CSS through the same Node UTF-8 path as the JS sources. The native
// loader on this Windows workspace can observe different bytes for this file.
export default defineConfig({base:'./',plugins:[{name:'local-css-reader',enforce:'pre',async load(id){if(/\/src\/[^/]+\.css$/.test(id.replaceAll('\\','/')))return readFile(id,'utf8')}},react()],build:{outDir:'dist',emptyOutDir:true}});
