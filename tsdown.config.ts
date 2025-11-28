import { defineConfig } from 'tsdown'
import { renameSync } from 'node:fs'
import { resolve } from 'node:path'

export default defineConfig({
    entry: ['./src/extension.ts'],
    outDir: './out',
    clean: true,
    minify: true,
    onSuccess() {
        const oldPath = resolve('./out/extension.cjs')
        const newPath = resolve('./out/extension.js')

        try {
            renameSync(oldPath, newPath)
            console.log('extension.cjs → extension.js')
        } catch (err) {
            console.log('can not find cjs file')
        }

    },
    format: 'cjs',

})