import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// docs/14 §1: Stellio never guesses or builds email addresses. A grep-style guard over every referral module.
const code = [
  ...['src/shared/referrals', 'src/main/services/referrals'].flatMap((d) =>
    readdirSync(d).map((f) => join(d, f)),
  ),
  'src/main/ai/tasks/referrals.ts',
  'src/main/db/repos/referrals.ts',
].filter((f) => f.endsWith('.ts'));

describe('no email construction in the referral code', () => {
  it.each(code)('%s builds no address from parts', (file) => {
    const src = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
    // template/concatenation that puts "@" between pieces: `${a}@${b}`, a + '@' + b, ['a', 'b'].join('@')
    expect(src).not.toMatch(/\}@\$\{|\}@[a-z]|[`'"]@[`'"]\s*\+|\+\s*[`'"]@|join\(\s*['"]@['"]/);
    // address-pattern helpers and lookups
    expect(src).not.toMatch(
      /mailto:[^/]*\$\{|guess|permutation|firstname\.lastname|first\.last|emailFormat|patterns?\.map/i,
    );
  });

  it('the only "@" literals are the address validator, phone lookbehinds, an "@" check and the " @ " title separator and the prompt version tag', () => {
    const lines = code.flatMap((f) =>
      readFileSync(f, 'utf8')
        .split('\n')
        .filter((l) => /[`'"/][^\n]*@/.test(l) && !/^\s*(\/\/|\*|\/\*)/.test(l) && !/from '@/.test(l))
        .map((l) => `${f}: ${l.trim()}`),
    );
    for (const l of lines) expect(l, l).toMatch(/EMAIL_RE|\(\?<!|includes\('@'\)|\[\\w@|\\s\+@\\s|@v\d/);
  });

  it('the search prompt forbids guessing and demands the exact address in a cited fact', () => {
    const p = readFileSync('prompts/referrals.search/v2.md', 'utf8');
    expect(p).toMatch(/Never guess an email/);
    expect(p).toMatch(/appear, written exactly, in the text/);
    expect(p).toMatch(/Never include phone numbers/);
  });
});
