import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';

// base relativa: el renderer se carga con loadFile (file://), sin servidor de desarrollo.
export default defineConfig({ base: './', plugins: [tailwindcss()], build: { outDir: 'dist', emptyOutDir: true, target: 'esnext' } });
