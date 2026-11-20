import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import viteConfig from '../vite.config';

const lines = (file: string) =>
  readFileSync(file, 'utf8').split('\n').map((l) => l.trim());

describe('browser credential isolation', () => {
  it('vite define exposes no server Gemini key', async () => {
    const original = { ...process.env };
    process.env.GEMINI_API_KEY = 'SENTINEL_SERVER';
    process.env.API_KEY = 'SENTINEL_SERVER';
    try {
      const factory = viteConfig as unknown as (a: { mode: string; command: string }) => any;
      const config = await factory({ mode: 'test', command: 'build' });
      const serialized = JSON.stringify(config.define);
      expect(serialized).not.toContain('SENTINEL_SERVER');
      expect(Object.keys(config.define)).toEqual(['process.env.BROWSER_GEMINI_API_KEY']);
    } finally {
      process.env = original;
    }
  });

  it('exposes BROWSER_GEMINI_API_KEY when set', async () => {
    const original = { ...process.env };
    process.env.BROWSER_GEMINI_API_KEY = 'BROWSER_OK';
    try {
      const factory = viteConfig as unknown as (a: { mode: string; command: string }) => any;
      const config = await factory({ mode: 'test', command: 'build' });
      expect(config.define['process.env.BROWSER_GEMINI_API_KEY']).toBe('"BROWSER_OK"');
    } finally {
      process.env = original;
    }
  });

  it.each(['.dockerignore', '.gcloudignore'])(
    'docker and gcloud build contexts exclude env files (%s)',
    (file) => {
      const l = lines(file);
      expect(l).toContain('.env');
      expect(l).toContain('.env.*');
      expect(l).toContain('!.env.example');
    },
  );

  it('.gcloudignore keeps the .gitignore fallback and excludes local-only paths', () => {
    const l = lines('.gcloudignore');
    expect(l[0]).toBe('#!include:.gitignore');
    for (const p of ['deploy/*.env', 'migrated_prompt_history/', '.superpowers', '.claude']) {
      expect(l).toContain(p);
    }
  });
});
