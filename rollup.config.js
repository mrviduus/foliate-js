import { nodeResolve } from '@rollup/plugin-node-resolve'
import terser from '@rollup/plugin-terser'
import { copy } from 'fs-extra'

const copyPDFJS = () => ({
    name: 'copy-pdfjs',
    async writeBundle() {
        await copy('node_modules/pdfjs-dist/build/pdf.mjs', 'vendor/pdfjs/pdf.mjs')
        await copy('node_modules/pdfjs-dist/build/pdf.mjs.map', 'vendor/pdfjs/pdf.mjs.map')
        await copy('node_modules/pdfjs-dist/build/pdf.worker.mjs', 'vendor/pdfjs/pdf.worker.mjs')
        await copy('node_modules/pdfjs-dist/build/pdf.worker.mjs.map', 'vendor/pdfjs/pdf.worker.mjs.map')
        await copy('node_modules/pdfjs-dist/cmaps', 'vendor/pdfjs/cmaps')
        await copy('node_modules/pdfjs-dist/standard_fonts', 'vendor/pdfjs/standard_fonts')
        // OpenJPEG (JPEG 2000 images), for a host that hands pdf.js its wasm (useWasm + a WasmFactory)
        for (const f of ['openjpeg.wasm', 'LICENSE_OPENJPEG', 'LICENSE_PDFJS_OPENJPEG'])
            await copy(`node_modules/pdfjs-dist/wasm/${f}`, `vendor/pdfjs/wasm/${f}`)
    },
})

export default [{
    input: 'rollup/fflate.js',
    output: {
        dir: 'vendor/',
        format: 'esm',
    },
    plugins: [nodeResolve(), terser()],
},
{
    input: 'rollup/zip.js',
    output: {
        dir: 'vendor/',
        format: 'esm',
    },
    plugins: [nodeResolve(), terser(), copyPDFJS()],
}]
