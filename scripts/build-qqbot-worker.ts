import { mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import * as esbuild from 'esbuild'

const root = join(import.meta.dir, '..')
const outDir = join(root, 'packages/messaging-qqbot-worker/dist')
mkdirSync(outDir, { recursive: true })
await esbuild.build({ entryPoints: [join(root, 'packages/messaging-qqbot-worker/src/worker.ts')], bundle: true, platform: 'node', format: 'cjs', target: 'node20', outfile: join(outDir, 'worker.cjs'), packages: 'bundle' })
console.log(`QQ Bot worker built: ${(statSync(join(outDir, 'worker.cjs')).size / 1024 / 1024).toFixed(2)} MB`)
