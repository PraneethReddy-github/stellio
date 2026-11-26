/**
 * Hashes (`hashText`) of every earlier shipped version of the seed files that a new default may replace (D28).
 * A data-folder file whose hash is listed here was never changed by the user, so start-up swaps in the new
 * default and commits it. The profile is never listed: it is the user's own data.
 */
export const PREVIOUS_SEEDS: Readonly<Record<string, readonly string[]>> = {
  // Phase 0 to v1.0.4 (template format 1).
  'templates/resume.tex': ['9cdff81382df119abc33fd78d48aa6a5692ec708ebd77a8f97e765c8f565a877'],
  'templates/cover-letter.tex': ['d1a1fb38c97a65cb6706c69e6325b121f107510aac80f9865a6b9d509915a632'],
  'rules/resume.md': ['fb8e672d5d65108fc92766326624132d6658b65e974e654c4a0965a492895b8b'],
  'rules/cover-letter.md': ['514fe98201c99f21be04cd20e46137f71a24d3646955b4b545e4a05e3b04311a'],
};

/** Files that are upgraded together or not at all: a template and the rules written for it. */
export const SEED_PAIRS: readonly (readonly string[])[] = [
  ['templates/resume.tex', 'rules/resume.md'],
  ['templates/cover-letter.tex', 'rules/cover-letter.md'],
];
