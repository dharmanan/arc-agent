import { createLogger, defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const viteLogger = createLogger();
const originalWarn = viteLogger.warn;

viteLogger.warn = (msg, options) => {
  const isOxPureAnnotationWarning =
    typeof msg === 'string'
    && msg.includes('contains an annotation that Rollup cannot interpret due to the position of the comment')
    && msg.includes('/node_modules/')
    && msg.includes('/ox/_esm/');

  if (isOxPureAnnotationWarning) return;
  originalWarn(msg, options);
};

export default defineConfig({
  customLogger: viteLogger,
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: process.env.VITE_BUILD_SOURCEMAP === 'true',
    reportCompressedSize: false,
    chunkSizeWarningLimit: 2500,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('/node_modules/')) return;
          if (id.includes('/react/') || id.includes('/react-dom/') || id.includes('/scheduler/')) return 'react-vendor';
          if (id.includes('/@metamask/')) return 'wallet-metamask';
          if (id.includes('/@walletconnect/') || id.includes('/@reown/')) return 'wallet-walletconnect';
          if (id.includes('/@coinbase/') || id.includes('/@base-org/')) return 'wallet-coinbase';
          if (id.includes('/@rainbow-me/') || id.includes('/wagmi/') || id.includes('/@tanstack/') || id.includes('/viem/') || id.includes('/ox/') || id.includes('/porto/')) return 'wallet-core';
          if (id.includes('/@circle-fin/')) return 'circle-kit';
          if (id.includes('/ethers/')) return 'ethers-vendor';
        },
      },
      onLog(level, log, handler) {
        const message = typeof log === 'string' ? log : log.message;
        const id = typeof log === 'string' ? '' : (log.id || '');
        const isOxPureAnnotationWarning =
          level === 'warn'
          && message?.includes('contains an annotation that Rollup cannot interpret due to the position of the comment')
          && id.includes('/node_modules/')
          && id.includes('/ox/_esm/');

        if (isOxPureAnnotationWarning) return;
        handler(level, log);
      },
    },
  },
});
