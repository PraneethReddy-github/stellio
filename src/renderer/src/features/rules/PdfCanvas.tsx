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

/** Every page of a PDF, stacked, each scaled to the width of its container. */
export function PdfCanvas({ bytes, label }: { bytes: Uint8Array; label: string }): React.JSX.Element {
  const box = useRef<HTMLDivElement>(null);
  const canvases = useRef<(HTMLCanvasElement | null)[]>([]);
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
    if (!doc || width < 40) return;
    const tasks: { cancel: () => void }[] = [];
    let dead = false;
    const draw = async (n: number): Promise<void> => {
      const page = await doc.getPage(n);
      const el = canvases.current[n - 1];
      if (dead || !el) return;
      const base = page.getViewport({ scale: 1 });
      const dpr = window.devicePixelRatio || 1;
      const viewport = page.getViewport({ scale: (width / base.width) * dpr });
      el.width = Math.floor(viewport.width);
      el.height = Math.floor(viewport.height);
      el.style.width = `${String(width)}px`;
      const task = page.render({ canvas: el, viewport });
      tasks.push(task);
      await task.promise;
    };
    Promise.all(Array.from({ length: doc.numPages }, (_, i) => draw(i + 1))).catch((e: unknown) => {
      // A superseded render rejects with RenderingCancelledException; only real failures matter.
      if (!dead) setFailure({ of: bytes, message: e instanceof Error ? e.message : String(e) });
    });
    return () => {
      dead = true;
      tasks.forEach((t) => t.cancel());
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
        Array.from({ length: doc?.numPages ?? 1 }, (_, i) => (
          <canvas
            key={i}
            ref={(el) => {
              canvases.current[i] = el;
            }}
            className={s.pdfCanvas}
            role="img"
            aria-label={`${label}, page ${String(i + 1)}`}
          />
        ))
      )}
    </div>
  );
}
