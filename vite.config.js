import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    hmr: {
      port: 5173
    },
    // Enable caching for large assets
    headers: {
      'Cache-Control': 'public, max-age=31536000, immutable'
    }
  },
  build: {
    // Increase chunk size warning limit for Three.js
    chunkSizeWarningLimit: 3000,
    rollupOptions: {
      output: {
        // Split vendor chunks for better caching
        manualChunks: {
          three: ['three'],
          rapier: ['@dimforge/rapier3d-compat']
        }
      }
    }
  },
  // Optimize deps
  optimizeDeps: {
    include: ['three', '@dimforge/rapier3d-compat']
  },
  // Asset handling - keep large files as separate assets
  assetsInclude: ['**/*.glb', '**/*.gltf']
});
