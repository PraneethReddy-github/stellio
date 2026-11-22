/** Fixed allow-list of editable rule/template files (paths relative to the data folder). */
export const RULE_FILES = [
  'rules/resume.md',
  'rules/cover-letter.md',
  'rules/skills-policy.md',
  'rules/referral-message.md',
] as const;
export const TEMPLATE_FILES = ['templates/resume.tex', 'templates/cover-letter.tex'] as const;
export const RULES_AND_TEMPLATE_FILES = [...RULE_FILES, ...TEMPLATE_FILES] as const;

export type RuleFile = (typeof RULE_FILES)[number];
export type TemplateFile = (typeof TEMPLATE_FILES)[number];
export type RulesFile = RuleFile | TemplateFile;

export type RulesKind = 'resume' | 'cover-letter' | 'skills-policy' | 'referral-message';
export type TemplateKind = 'resume' | 'cover-letter';

export const RULE_KIND: Record<RuleFile, RulesKind> = {
  'rules/resume.md': 'resume',
  'rules/cover-letter.md': 'cover-letter',
  'rules/skills-policy.md': 'skills-policy',
  'rules/referral-message.md': 'referral-message',
};
export const TEMPLATE_KIND: Record<TemplateFile, TemplateKind> = {
  'templates/resume.tex': 'resume',
  'templates/cover-letter.tex': 'cover-letter',
};

export function isRuleFile(path: string): path is RuleFile {
  return Object.hasOwn(RULE_KIND, path);
}
export function isTemplateFile(path: string): path is TemplateFile {
  return Object.hasOwn(TEMPLATE_KIND, path);
}
