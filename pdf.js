const pdfjsPath = path => new URL(`vendor/pdfjs/${path}`, import.meta.url).toString()

import './vendor/pdfjs/pdf.mjs'
const pdfjsLib = globalThis.pdfjsLib

const fetchText = async url => await (await fetch(url)).text()

// Nothing is fetched or resolved at import time: a host that bundles this module (no module URL,
// no network under its CSP) passes its own CSS and getDocument params to `makePDF` instead.
// https://raw.githubusercontent.com/mozilla/pdf.js/refs/tags/v5.5.207/web/text_layer_builder.css
// https://raw.githubusercontent.com/mozilla/pdf.js/refs/tags/v5.5.207/web/annotation_layer_builder.css
let defaultCSS
const getDefaultCSS = () => defaultCSS ??= Promise.all(
    ['text_layer_builder.css', 'annotation_layer_builder.css'].map(f => fetchText(pdfjsPath(f))))
    .then(css => css.join('\n'))
const defaultParams = () => ({
    cMapUrl: pdfjsPath('cmaps/'),
    standardFontDataUrl: pdfjsPath('standard_fonts/'),
})

// the latest render of each page document: fixed layout calls `render` again on every
// resize, so each call builds its own layers and only the latest one puts them in
const latestRender = new WeakMap()

const render = async (page, doc, zoom) => {
    const token = {}
    latestRender.set(doc, token)
    const stale = () => latestRender.get(doc) !== token
    const scale = zoom * devicePixelRatio
    doc.documentElement.style.transform = `scale(${1 / devicePixelRatio})`
    doc.documentElement.style.transformOrigin = 'top left'
    doc.documentElement.style.setProperty('--scale-factor', scale)
    const viewport = page.getViewport({ scale })

    // the canvas must be in the `PDFDocument`'s `ownerDocument`
    // (`globalThis.document` by default); that's where the fonts are loaded
    const canvas = document.createElement('canvas')
    canvas.height = viewport.height
    canvas.width = viewport.width
    const canvasContext = canvas.getContext('2d')
    await page.render({ canvasContext, viewport }).promise
    if (stale()) return
    doc.querySelector('#canvas').replaceChildren(doc.adoptNode(canvas))

    const container = doc.createElement('div')
    container.className = 'textLayer'
    const textLayer = new pdfjsLib.TextLayer({
        textContentSource: await page.streamTextContent(),
        container, viewport,
    })
    await textLayer.render()

    // hide "offscreen" canvases appended to docuemnt when rendering text layer
    // https://github.com/mozilla/pdf.js/blob/642b9a5ae67ef642b9a8808fd9efd447e8c350e2/web/pdf_viewer.css#L51-L58
    for (const canvas of document.querySelectorAll('.hiddenCanvasElement'))
        Object.assign(canvas.style, {
            position: 'absolute',
            top: '0',
            left: '0',
            width: '0',
            height: '0',
            display: 'none',
        })

    // fix text selection
    // https://github.com/mozilla/pdf.js/blob/642b9a5ae67ef642b9a8808fd9efd447e8c350e2/web/text_layer_builder.js#L105-L107
    const endOfContent = document.createElement('div')
    endOfContent.className = 'endOfContent'
    container.append(endOfContent)
    // TODO: this only works in Firefox; see https://github.com/mozilla/pdf.js/pull/17923
    container.onpointerdown = () => container.classList.add('selecting')
    container.onpointerup = () => container.classList.remove('selecting')

    const div = doc.createElement('div')
    div.className = 'annotationLayer'
    // pdf.js's IPDFLinkService: a Named action, a SetOCGState, an attachment, a JavaScript or a
    // ResetForm link calls `getAnchorUrl`; without it the layer throws and the page loses all its links
    const linkService = {
        pagesCount: 0,
        page: 0,
        rotation: 0,
        isInPresentationMode: false,
        externalLinkEnabled: true,
        goToDestination: () => {},
        goToPage: () => {},
        goToXY: () => {},
        getDestinationHash: dest => JSON.stringify(dest),
        getAnchorUrl: () => '#',
        addLinkAttributes: (link, url) => link.href = url,
        setHash: () => {},
        executeNamedAction: () => {},
        executeSetOCGState: () => {},
    }
    await new pdfjsLib.AnnotationLayer({ page, viewport, div, linkService })
        .render({ annotations: await page.getAnnotations() })
    if (stale()) return
    doc.querySelector('.textLayer').replaceWith(container)
    doc.querySelector('.annotationLayer').replaceWith(div)
}

const renderPage = async (page, getImageBlob, css) => {
    const viewport = page.getViewport({ scale: 1 })
    if (getImageBlob) {
        const canvas = document.createElement('canvas')
        canvas.height = viewport.height
        canvas.width = viewport.width
        const canvasContext = canvas.getContext('2d')
        await page.render({ canvasContext, viewport }).promise
        return new Promise(resolve => canvas.toBlob(resolve))
    }
    const src = URL.createObjectURL(new Blob([`
        <!DOCTYPE html>
        <html lang="en">
        <meta charset="utf-8">
        <meta name="viewport" content="width=${viewport.width}, height=${viewport.height}">
        <style>
        html, body {
            margin: 0;
            padding: 0;
        }
        /*
        https://github.com/mozilla/pdf.js/commit/bd05b255fabfc313b194bfe9a17ccded4d90fb5a
        */
        :root {
          --user-unit: 1;
          --total-scale-factor: calc(var(--scale-factor) * var(--user-unit));
          --scale-round-x: 1px;
          --scale-round-y: 1px;
        }
        ${css}
        </style>
        <div id="canvas"></div>
        <div class="textLayer"></div>
        <div class="annotationLayer"></div>
    `], { type: 'text/html' }))
    const onZoom = ({ doc, scale }) => render(page, doc, scale)
    return { src, onZoom }
}

const KEEP_PAGES = 4

const makeTOCItem = item => ({
    label: item.title,
    href: JSON.stringify(item.dest),
    subitems: item.items.length ? item.items.map(makeTOCItem) : null,
})

/**
 * `options.css`: the text and annotation layer CSS (default: fetched from `vendor/pdfjs/`).
 * `options.params`: getDocument params (default: cMaps and standard fonts from `vendor/pdfjs/`).
 * The worker is `GlobalWorkerOptions.workerSrc`, unless the host set one up on `globalThis.pdfjsWorker`
 * (pdf.js then runs it on the main thread). Eval stays off (`isEvalSupported: false`, not overridable).
 */
export const makePDF = async (file, { css, params } = {}) => {
    if (!pdfjsLib.GlobalWorkerOptions.workerSrc && !globalThis.pdfjsWorker)
        pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsPath('pdf.worker.mjs')
    css ??= await getDefaultCSS()
    const transport = new pdfjsLib.PDFDataRangeTransport(file.size, [])
    transport.requestDataRange = (begin, end) => {
        file.slice(begin, end).arrayBuffer().then(chunk => {
            transport.onDataRange(begin, chunk)
        })
    }
    const task = pdfjsLib.getDocument({
        range: transport,
        ...(params ?? defaultParams()),
        isEvalSupported: false,
    })
    // a load that fails before the book is made destroys its own loading task (and worker port)
    const orDestroy = promise => promise.catch(e => {
        task.destroy()
        throw e
    })
    const pdf = await orDestroy(task.promise)

    const book = { rendition: { layout: 'pre-paginated' } }

    const { metadata, info } = await orDestroy(pdf.getMetadata()) ?? {}
    // TODO: for better results, parse `metadata.getRaw()`
    book.metadata = {
        title: metadata?.get('dc:title') ?? info?.Title,
        author: metadata?.get('dc:creator') ?? info?.Author,
        contributor: metadata?.get('dc:contributor'),
        description: metadata?.get('dc:description') ?? info?.Subject,
        language: metadata?.get('dc:language'),
        publisher: metadata?.get('dc:publisher'),
        subject: metadata?.get('dc:subject'),
        identifier: metadata?.get('dc:identifier'),
        source: metadata?.get('dc:source'),
        rights: metadata?.get('dc:rights'),
    }

    const outline = await orDestroy(pdf.getOutline())
    book.toc = outline?.map(makeTOCItem)

    // the last `KEEP_PAGES` loaded pages, least recently loaded first; an older one gives back its
    // `blob:` URL and pdf.js's resources for it (`cleanup()` waits for a render in progress), and is
    // rebuilt when visited again
    const cache = new Map()
    const release = entry => entry.then(({ page, src }) => {
        URL.revokeObjectURL(src)
        page.cleanup()
    }, () => {})
    book.sections = Array.from({ length: pdf.numPages }).map((_, i) => ({
        id: i,
        load: () => {
            const cached = cache.get(i)
            cache.delete(i)
            const entry = cached ?? pdf.getPage(i + 1).then(async page =>
                ({ page, ...await renderPage(page, false, css) }))
            cache.set(i, entry)
            entry.catch(() => cache.get(i) === entry && cache.delete(i))
            for (const [j, old] of cache) {
                if (cache.size <= KEEP_PAGES) break
                cache.delete(j)
                release(old)
            }
            return entry.then(({ src, onZoom }) => ({ src, onZoom }))
        },
        size: 1000,
    }))
    book.isExternal = uri => /^\w+:/i.test(uri)
    book.resolveHref = async href => {
        const parsed = JSON.parse(href)
        const dest = typeof parsed === 'string'
            ? await pdf.getDestination(parsed) : parsed
        if (dest?.[0] == null) return null
        const index = await pdf.getPageIndex(dest[0])
        return { index }
    }
    book.splitTOCHref = async href => {
        const parsed = JSON.parse(href)
        const dest = typeof parsed === 'string'
            ? await pdf.getDestination(parsed) : parsed
        if (dest?.[0] == null) return null
        const index = await pdf.getPageIndex(dest[0])
        return [index, null]
    }
    book.getTOCFragment = doc => doc.documentElement
    book.getCover = async () => renderPage(await pdf.getPage(1), true)
    book.destroy = () => {
        for (const entry of cache.values())
            entry.then(({ src }) => URL.revokeObjectURL(src), () => {})
        cache.clear()
        return pdf.destroy()
    }
    return book
}
