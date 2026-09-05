import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { importMapPlugin } from './plugins/import-map.js'

export default defineConfig({
  plugins: [vue(), importMapPlugin()],
  publicDir: 'data',
})
