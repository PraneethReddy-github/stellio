import { useEffect, useRef } from 'react';
import { Annotation, Compartment, EditorState, Transaction, type Extension } from '@codemirror/state';
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from '@codemirror/language';
import { markdown } from '@codemirror/lang-markdown';
import { stex } from '@codemirror/legacy-modes/mode/stex';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import { tags as t } from '@lezer/highlight';
import s from './CodeEditor.module.css';
import { cx } from './cx';
import { cspNonce } from './nonce';

export interface CodeEditorProps {
  value: string;
  onChange?: (value: string) => void;
  language: 'markdown' | 'latex';
  readOnly?: boolean;
  ariaLabel: string;
  /** Fixed height (px number or CSS length). Default 240. Ignored with `fill`. */
  height?: number | string;
  /** Stretch to the parent's height. */
  fill?: boolean;
  /** Ctrl/Cmd+S. */
  onSave?: () => void;
  /** Move the cursor to this 1-based line and scroll it into view. A new object re-triggers it. */
  focusLine?: { line: number };
}

const external = Annotation.define<boolean>();

// All colours are CSS variables, so the editor follows the light/dark theme without reconfiguring.
const theme = EditorView.theme({
  '&': { height: '100%', color: 'var(--text)', backgroundColor: 'var(--surface-1)', fontSize: '12.5px' },
  '&.cm-focused': { outline: '2px solid var(--signal)', outlineOffset: '-2px' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.55', overflow: 'auto' },
  '.cm-content': { caretColor: 'var(--signal)', padding: '8px 0' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--signal)', borderLeftWidth: '2px' },
  '.cm-gutters': { backgroundColor: 'var(--surface-1)', color: 'var(--text-3)', border: 'none' },
  '.cm-activeLine': { backgroundColor: 'var(--surface-2)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--surface-2)', color: 'var(--text-2)' },
  '.cm-selectionBackground, &.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': {
    backgroundColor: 'var(--signal-soft)',
  },
  '.cm-selectionMatch': { backgroundColor: 'var(--surface-3)' },
  '.cm-searchMatch': { backgroundColor: 'var(--warn-soft)', outline: '1px solid var(--warn)' },
  '.cm-searchMatch-selected': { backgroundColor: 'var(--signal-soft)', outline: '1px solid var(--signal)' },
  '.cm-panels': { backgroundColor: 'var(--surface-2)', color: 'var(--text)', borderColor: 'var(--line)' },
  '.cm-panel.cm-search input, .cm-panel.cm-search button': {
    font: 'inherit',
    fontSize: '12px',
    color: 'var(--text)',
    backgroundColor: 'var(--surface-1)',
    border: '1px solid var(--line-strong)',
    borderRadius: '2px',
  },
  '.cm-panel.cm-search label': { color: 'var(--text-2)' },
});

const highlight = HighlightStyle.define([
  { tag: [t.heading, t.strong], fontWeight: '500' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: [t.keyword, t.tagName, t.link, t.url], color: 'var(--info)' },
  { tag: [t.comment, t.meta, t.processingInstruction, t.contentSeparator], color: 'var(--text-3)' },
  { tag: [t.string, t.atom, t.number], color: 'var(--ok)' },
  { tag: t.monospace, color: 'var(--text-2)' },
]);

const language = (l: CodeEditorProps['language']): Extension =>
  l === 'markdown' ? markdown() : StreamLanguage.define(stex);
const mode = (p: Pick<CodeEditorProps, 'readOnly' | 'ariaLabel'>): Extension => [
  EditorState.readOnly.of(!!p.readOnly),
  EditorView.editable.of(!p.readOnly),
  // tabindex makes the scroller's keyboard path explicit: axe does not count a bare contenteditable.
  EditorView.contentAttributes.of({ 'aria-label': p.ariaLabel, 'aria-multiline': 'true', tabindex: '0' }),
];

export function CodeEditor(props: CodeEditorProps): React.JSX.Element {
  const {
    value,
    onChange,
    language: lang,
    readOnly,
    ariaLabel,
    height = 240,
    fill,
    onSave,
    focusLine,
  } = props;
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView>(null);
  const langC = useRef(new Compartment());
  const modeC = useRef(new Compartment());
  const initial = useRef(props);
  const latest = useRef({ onChange, onSave });

  useEffect(() => {
    latest.current = { onChange, onSave };
  });

  useEffect(() => {
    const p = initial.current;
    const v = new EditorView({
      parent: host.current ?? undefined,
      state: EditorState.create({
        doc: p.value,
        extensions: [
          // CodeMirror injects <style> elements; the production CSP only allows them with the per-load nonce.
          EditorView.cspNonce.of(cspNonce()),
          lineNumbers(),
          // A read-only view has no cursor worth marking.
          ...(p.readOnly ? [] : [highlightActiveLineGutter(), highlightActiveLine()]),
          drawSelection(),
          history(),
          search({ top: true }),
          highlightSelectionMatches(),
          EditorView.lineWrapping,
          keymap.of([
            {
              key: 'Mod-s',
              preventDefault: true,
              run: () => {
                latest.current.onSave?.();
                return true;
              },
            },
            ...searchKeymap,
            ...historyKeymap,
            ...defaultKeymap,
          ]),
          theme,
          syntaxHighlighting(highlight),
          langC.current.of(language(p.language)),
          modeC.current.of(mode(p)),
          EditorView.updateListener.of((u) => {
            if (u.docChanged && !u.transactions.some((tr) => tr.annotation(external))) {
              latest.current.onChange?.(u.state.doc.toString());
            }
          }),
        ],
      }),
    });
    view.current = v;
    return () => {
      v.destroy();
      view.current = null;
    };
  }, []);

  useEffect(() => {
    view.current?.dispatch({
      effects: [
        langC.current.reconfigure(language(lang)),
        modeC.current.reconfigure(mode({ readOnly, ariaLabel })),
      ],
    });
  }, [lang, readOnly, ariaLabel]);

  // Apply outside edits as a minimal splice so the cursor and undo history survive.
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const old = v.state.doc.toString();
    if (old === value) return;
    let from = 0;
    while (from < old.length && from < value.length && old[from] === value[from]) from++;
    let end = 0;
    while (
      end < old.length - from &&
      end < value.length - from &&
      old[old.length - 1 - end] === value[value.length - 1 - end]
    )
      end++;
    v.dispatch({
      changes: { from, to: old.length - end, insert: value.slice(from, value.length - end) },
      annotations: [external.of(true), Transaction.addToHistory.of(false)],
    });
  }, [value]);

  useEffect(() => {
    const v = view.current;
    if (!v || !focusLine) return;
    const at = v.state.doc.line(Math.min(Math.max(1, focusLine.line), v.state.doc.lines)).from;
    v.dispatch({ selection: { anchor: at }, scrollIntoView: true });
    v.focus();
  }, [focusLine]);

  return <div ref={host} className={cx(s.host, fill && s.fill)} style={fill ? undefined : { height }} />;
}
