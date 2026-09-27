/** Verify that the files needed to start the packaged app were built and copied. */
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const requiredFiles = [
  'main.cjs',
  'bootstrap-preload.cjs',
  'browser-toolbar-preload.cjs',
  'interceptor.cjs',
  'renderer/index.html',
  'resources/config-defaults.json',
];

const requiredDirectories = [
  'renderer/assets',
  'resources/docs',
  'resources/themes',
  'resources/permissions',
  'resources/tool-icons',
  'resources/skills',
];

const missing = [
  ...requiredFiles.filter((file) => {
    const path = join('dist', file);
    return !existsSync(path) || !statSync(path).isFile();
  }),
  ...requiredDirectories.filter((directory) => {
    const path = join('dist', directory);
    return !existsSync(path) || !statSync(path).isDirectory();
  }),
];

if (missing.length > 0) {
  console.error(`Missing build assets:\n${missing.map((path) => `  dist/${path}`).join('\n')}`);
  process.exitCode = 1;
} else {
  console.log('Build assets validated');
}
