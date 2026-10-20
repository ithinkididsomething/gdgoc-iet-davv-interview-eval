import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'icons.svg', 'gdg-logo.png', 'gdg-logo-dark.png', 'gdg-mark.png'],
      manifest: {
        name: 'GDGOC IET DAVV Interviews',
        short_name: 'GDGOC Interviews',
        description: 'Offline-first interview evaluation for GDGOC IET DAVV',
        theme_color: '#4285F4',
        background_color: '#ffffff',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: 'gdg-mark.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'gdg-mark.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'gdg-mark.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: 'icons.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
        ],
      },
      workbox: {
        // App shell only. Never cache API responses — evaluations live in IndexedDB.
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        navigateFallback: '/index.html',
        runtimeCaching: [],
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
      },
      devOptions: { enabled: false },
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.VITE_API_PROXY_TARGET ?? 'http://localhost:4000',
        changeOrigin: true,
      },
    },
  },
  preview: {
    port: 4173,
    proxy: {
      '/api': {
        target: process.env.VITE_API_PROXY_TARGET ?? 'http://localhost:4000',
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
} as Parameters<typeof defineConfig>[0] & { test: unknown });
