import { useEffect, useRef, useState } from 'react';
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist';
import s from './rules.module.css';

type Pdfjs = typeof import('pdfjs-dist');
let pdfjs: Promise<Pdfjs> | undefined;

/**
 * pdf.js, loaded on first use. The worker is a bundled file served from app://, which the production CSP
 * (script-src 'self') allows; blob: and data: workers would not be.
 */
function loadPdfjs(): Promise<Pdfjs> {
  pdfjs ??= Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')]).then(
    ([lib, worker]) => {
      lib.GlobalWorkerOptions.workerSrc = worker.default;
      return lib;
    },
  );
  return pdfjs;
}

/** Page 1 of a PDF, scaled to the width of its container. */
export function PdfCanvas({ bytes, label }: { bytes: Uint8Array; label: string }): React.JSX.Element {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [width, setWidth] = useState(0);
  // Tied to the bytes it is about, so a new PDF starts without the old error.
  const [failure, setFailure] = useState<{ of: Uint8Array; message: string } | null>(null);
  const error = failure?.of === bytes ? failure.message : null;

  useEffect(() => {
    let dead = false;
    let task: PDFDocumentLoadingTask | undefined;
    loadPdfjs()
      .then((lib) => {
        if (dead) return;
        // `data` is transferred to the worker, so hand it a copy.
        task = lib.getDocument({ data: bytes.slice() });
        return task.promise;
      })
      .then((d) => {
        if (d && !dead) setDoc(d);
      })
      .catch((e: unknown) => {
        if (!dead) setFailure({ of: bytes, message: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      dead = true;
      setDoc(null);
      void task?.destroy();
    };
  }, [bytes]);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.floor(entry?.contentRect.width ?? 0)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const el = canvas.current;
    if (!doc || !el || width < 40) return;
    let task: { cancel: () => void; promise: Promise<unknown> } | undefined;
    let dead = false;
    void doc
      .getPage(1)
      .then((page) => {
        if (dead) return;
        const base = page.getViewport({ scale: 1 });
        const dpr = window.devicePixelRatio || 1;
        const viewport = page.getViewport({ scale: (width / base.width) * dpr });
        el.width = Math.floor(viewport.width);
        el.height = Math.floor(viewport.height);
        el.style.width = `${String(width)}px`;
        task = page.render({ canvas: el, viewport });
        return task.promise;
      })
      .catch((e: unknown) => {
        // A superseded render rejects with RenderingCancelledException; only real failures matter.
        if (!dead) setFailure({ of: bytes, message: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      dead = true;
      task?.cancel();
    };
  }, [doc, width, bytes]);

  // Focusable so the scrolling panel around it is reachable by keyboard when this is all it holds.
  return (
    <div ref={box} className={s.pdfBox} role="region" aria-label="Preview" tabIndex={0}>
      {error ? (
        <p className={s.compileError} role="alert">
          Could not draw the preview: {error}
        </p>
      ) : (
        <canvas ref={canvas} className={s.pdfCanvas} role="img" aria-label={label} />
      )}
    </div>
  );
}
