/** The per-load CSP nonce from the page, for libraries that inject <style> elements. Empty in dev. */
export const cspNonce = (): string =>
  document.querySelector<HTMLMetaElement>('meta[name="csp-nonce"]')?.content ?? '';
