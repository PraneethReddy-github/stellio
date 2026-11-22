/** TeX names the static pre-check (src/main/services/latex/precheck.ts) rejects; shared so the resume renderer can avoid them. */

/** Matched against command and environment names, lowercased with `@` removed (`\@@input` → `input`). */
export const DENY_PARTS = [
  'input', // \input \@@input \InputIfFileExists \lstinputlisting \verbatiminput
  'include', // \include \includegraphics \includepdf
  'openin',
  'openout',
  'write', // \write \immediate\write \write18 \protected@write, verbatimwrite env
  'read', // \read \readline
  'catcode',
  'csname', // \csname \ifcsname
  'endlinechar',
  'scantokens',
  'directlua',
  'latelua',
  'immediate',
  'special',
  'pdfobj',
  'pdfximage',
  'pdffile', // \pdffiledump \pdffilesize \pdffilemoddate
  'xetexpicfile',
  'xetexpdffile',
  'filecontents',
  'fileexists', // \IfFileExists
  'nameuse', // \@nameuse{input}
  'namedef',
  'usename', // \UseName{input}
  'explsyntax', // expl3 file streams (\ior_open:Nn) need \ExplSyntaxOn
  'expandargs',
];
/** Exact names: too short or too common to match as substrings. */
export const DENY_EXACT = new Set([
  'font',
  'csuse',
  'csdef',
  'csgdef',
  'csedef',
  'csxdef',
  'cslet',
  'csletcs',
  'letcs',
]);

/** Names a `{...}` group may not spell exactly (`\begin{x}` runs `\x`); exact, so `{Reader}` stays fine. */
export const DENY_GROUP = new Set([
  ...DENY_PARTS,
  ...DENY_EXACT,
  ...['includegraphics', 'includepdf', 'inputiffileexists', 'iffileexists', 'lstinputlisting'],
  ...['verbatiminput', 'verbatimwrite', 'ifcsname'],
]);

export const norm = (name: string): string => name.toLowerCase().replaceAll('@', '').replace(/\*$/, '');
