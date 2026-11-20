/// <reference types="vitest/config" />
import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import { configDefaults } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, '.', '');
    return {
      plugins: [react()],
      define: {
        // Browser-only key for local development. The server's GEMINI_API_KEY
        // must never be defined here: it would be inlined into the bundle.
        'process.env.BROWSER_GEMINI_API_KEY': JSON.stringify(env.BROWSER_GEMINI_API_KEY || ''),
      },
      resolve: {
        alias: {
          '@': path.resolve(__dirname, '.'),
        }
      },
      server: {
        // Task worktrees build their own copies under .claude/; changes there
        // must not reload this checkout's page.
        watch: { ignored: ['**/.claude/**'] },
      },
      test: {
        // Claude Code task worktrees live under .claude/worktrees; without this
        // their copies of the test suite run alongside this checkout's.
        exclude: [...configDefaults.exclude, '.claude/**'],
      },
    };
});
