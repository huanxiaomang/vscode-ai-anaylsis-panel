import { defineConfig } from 'tsdown'

export default defineConfig({
    entry: ['./src/extension.ts'],
    outDir: './out',
    clean: true,
    minify: true,
    onSuccess: () => {
        console.log('编译成功')
    },
})