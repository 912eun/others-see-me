import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// GitHub Pages(프로젝트 페이지)는 /<repo>/ 아래에서 서빙되므로 BASE_PATH로 지정
export default defineConfig({
  base: process.env.BASE_PATH ?? '/',
  plugins: [react()],
})
