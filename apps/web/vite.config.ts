import tailwindcss from '@tailwindcss/postcss';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

function reactGrabDevPlugin(enabled: boolean) {
  return {
    name: 'codex-boards-react-grab-dev',
    apply: 'serve' as const,
    transformIndexHtml() {
      if (!enabled) {
        return [];
      }

      return [
        {
          tag: 'script',
          attrs: { type: 'module' },
          children: 'import("/dev/react-grab.ts");',
          injectTo: 'head' as const,
        },
      ];
    },
  };
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');

  return {
    plugins: [
      react(),
      reactGrabDevPlugin(env.VITE_ENABLE_REACT_GRAB === 'true'),
    ],
    css: {
      postcss: {
        plugins: [tailwindcss()],
      },
    },
  };
});
