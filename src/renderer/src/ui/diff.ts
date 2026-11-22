export interface DiffLine {
  kind: 'ctx' | 'add' | 'del';
  text: string;
  /** 1-based line number in the old / new text (absent on the side the line does not exist). */
  oldNo?: number;
  newNo?: number;
}

export interface Hunk {
  header: string;
  lines: DiffLine[];
}

/** One side-by-side row: removed text left, added text right, context on both. */
export interface DiffRow {
  left?: DiffLine;
  right?: DiffLine;
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** Parses git-format unified diff text. File headers are skipped; hunks of several files are concatenated. */
export function parseUnifiedDiff(text: string): Hunk[] {
  const hunks: Hunk[] = [];
  let cur: Hunk | undefined;
  let o = 0;
  let n = 0;
  const raw = text.split(/\r?\n/);
  if (raw[raw.length - 1] === '') raw.pop();
  for (const line of raw) {
    const m = HUNK.exec(line);
    if (m) {
      cur = { header: line, lines: [] };
      hunks.push(cur);
      o = Number(m[1]);
      n = Number(m[2]);
    } else if (line.startsWith('diff ')) {
      cur = undefined;
    } else if (cur) {
      const c = line[0];
      const body = line.slice(1);
      if (c === '+') cur.lines.push({ kind: 'add', text: body, newNo: n++ });
      else if (c === '-') cur.lines.push({ kind: 'del', text: body, oldNo: o++ });
      else if (c === ' ' || c === undefined)
        cur.lines.push({ kind: 'ctx', text: body, oldNo: o++, newNo: n++ });
      // '\ No newline at end of file' and anything else: ignored
    }
  }
  return hunks;
}

/** Pairs each run of removed lines with the following run of added lines. */
export function toRows(hunk: Hunk): DiffRow[] {
  const rows: DiffRow[] = [];
  let dels: DiffLine[] = [];
  let adds: DiffLine[] = [];
  const flush = (): void => {
    for (let i = 0; i < Math.max(dels.length, adds.length); i++) rows.push({ left: dels[i], right: adds[i] });
    dels = [];
    adds = [];
  };
  for (const l of hunk.lines) {
    if (l.kind === 'ctx') {
      flush();
      rows.push({ left: l, right: l });
    } else if (l.kind === 'del') {
      if (adds.length) flush();
      dels.push(l);
    } else adds.push(l);
  }
  flush();
  return rows;
}

const CONTEXT = 3;

/**
 * Line diff of two strings (LCS), as hunks with 3 lines of context.
 * shortcut: O(n*m) table after trimming common ends, fine for documents under a few thousand lines.
 */
export function diffLines(a: string, b: string): Hunk[] {
  const A = a === '' ? [] : a.split('\n');
  const B = b === '' ? [] : b.split('\n');
  let pre = 0;
  while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
  let suf = 0;
  while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf])
    suf++;
  const x = A.slice(pre, A.length - suf);
  const y = B.slice(pre, B.length - suf);

  const W = y.length + 1;
  const L = new Uint32Array((x.length + 1) * W);
  const at = (i: number, j: number): number => L[i * W + j] ?? 0;
  for (let i = x.length - 1; i >= 0; i--)
    for (let j = y.length - 1; j >= 0; j--)
      L[i * W + j] = x[i] === y[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));

  const all: DiffLine[] = A.slice(0, pre).map((text, i) => ({
    kind: 'ctx',
    text,
    oldNo: i + 1,
    newNo: i + 1,
  }));
  let i = 0;
  let j = 0;
  let o = pre + 1;
  let n = pre + 1;
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) {
      all.push({ kind: 'ctx', text: x[i++] ?? '', oldNo: o++, newNo: n++ });
      j++;
    } else if (i < x.length && (j === y.length || at(i + 1, j) >= at(i, j + 1))) {
      all.push({ kind: 'del', text: x[i++] ?? '', oldNo: o++ }); // removals first, like git
    } else all.push({ kind: 'add', text: y[j++] ?? '', newNo: n++ });
  }
  for (const text of A.slice(A.length - suf)) all.push({ kind: 'ctx', text, oldNo: o++, newNo: n++ });

  // Keep changed lines plus CONTEXT lines around them, split where the gap is larger.
  const keep = all.map(
    (l, k) =>
      l.kind !== 'ctx' || all.slice(Math.max(0, k - CONTEXT), k + CONTEXT + 1).some((m) => m.kind !== 'ctx'),
  );
  const hunks: Hunk[] = [];
  for (let k = 0; k < all.length; k++) {
    if (!keep[k]) continue;
    let e = k;
    while (e < all.length && keep[e]) e++;
    const lines = all.slice(k, e);
    const oldStart = lines.find((l) => l.oldNo !== undefined)?.oldNo ?? 0;
    const newStart = lines.find((l) => l.newNo !== undefined)?.newNo ?? 0;
    const oldLen = lines.filter((l) => l.kind !== 'add').length;
    const newLen = lines.filter((l) => l.kind !== 'del').length;
    hunks.push({
      header: `@@ -${String(oldStart)},${String(oldLen)} +${String(newStart)},${String(newLen)} @@`,
      lines,
    });
    k = e;
  }
  return hunks;
}
