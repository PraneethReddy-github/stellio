import { lazy, Suspense } from 'react';
import type { CodeEditorProps } from './CodeEditor';

// CodeMirror is ~1 MB: load it when an editor first appears, not with every screen.
const Editor = lazy(() => import('./CodeEditor').then((m) => ({ default: m.CodeEditor })));

export function CodeEditor(props: CodeEditorProps): React.JSX.Element {
  const height = props.fill ? '100%' : (props.height ?? 240);
  return (
    <Suspense fallback={<div style={{ height }} aria-busy="true" />}>
      <Editor {...props} />
    </Suspense>
  );
}
