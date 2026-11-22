/** Wraps untrusted text in `<tag>…</tag>`; a tag of the same name inside the text cannot end or start the block. */
export function wrapData(tag: string, text: string): string {
  const safe = text.replace(new RegExp(`<(/?)${tag}`, 'gi'), (_m, slash: string) => `<\\${slash}${tag}`);
  return `<${tag}>\n${safe}\n</${tag}>`;
}
