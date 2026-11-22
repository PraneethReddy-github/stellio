export interface LoadedPrompt {
  version: number;
  system: string;
  jsonSchema: object;
}

// Raw files are inlined at build time so they ship inside the bundle.
const files = import.meta.glob<string>('../../../prompts/*/*', {
  query: '?raw',
  import: 'default',
  eager: true,
});

const find = (task: string, name: string): string | undefined =>
  Object.entries(files).find(([path]) => path.endsWith(`/prompts/${task}/${name}`))?.[1];

/** Loads `prompts/<task>/v<N>.md` (latest unless `version` is given) and `prompts/<task>/schema.json`. */
export function loadPrompt(task: string, version?: number): LoadedPrompt {
  const versions = Object.keys(files)
    .map((p) => new RegExp(`/prompts/${task.replace('.', '\\.')}/v(\\d+)\\.md$`).exec(p)?.[1])
    .filter((v): v is string => v !== undefined)
    .map(Number);
  const v = version ?? Math.max(...versions);
  const system = versions.includes(v) ? find(task, `v${v}.md`) : undefined;
  const schema = find(task, 'schema.json');
  if (system === undefined || schema === undefined)
    throw new Error(`Prompt not found: ${task}${version === undefined ? '' : ` v${version}`}`);
  return { version: v, system, jsonSchema: JSON.parse(schema) as object };
}
