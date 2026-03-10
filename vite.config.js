import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'fs'

const BUILD_VERSION = Date.now().toString();

// https://vite.dev/config/
export default defineConfig(({ command }) => ({
  plugins: [
    react(),
    {
      name: 'generate-version-json',
      buildStart() {
        fs.writeFileSync('./public/version.json', JSON.stringify({ version: BUILD_VERSION }));
      },
    },
  ],
  define: {
    __BUILD_VERSION__: JSON.stringify(BUILD_VERSION),
  },
  base: command === 'build' ? './' : '/',
}))
