import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { viteSingleFile } from 'vite-plugin-singlefile'

export default defineConfig({
  root: 'src/apps/attention/ui',
  plugins: [react(), tailwindcss(), viteSingleFile()],
  build: {
    outDir: '../../../../dist/attention-panel',
    emptyOutDir: true
  }
})
