const META_REFRESH_RE = /<meta\b[^>]*\bhttp-equiv\s*=\s*(["']?)\s*refresh\s*\1[^>]*>/gi;
const BASE_RE = /<base\b[^>]*>/gi;
const LINK_RE = /<link\b[^>]*>/gi;
const PRELOAD_REL_RE = /\brel\s*=\s*(?:"[^"]*\b(?:preload|prefetch|preconnect|dns-prefetch|prerender|modulepreload)\b[^"]*"|'[^']*\b(?:preload|prefetch|preconnect|dns-prefetch|prerender|modulepreload)\b[^']*'|(?:preload|prefetch|preconnect|dns-prefetch|prerender|modulepreload)\b)/i;

/** Strip `<meta http-equiv=refresh>`, `<base>` and preload/prefetch/preconnect `<link>`s from served artifact HTML. */
export function sanitizeHtml(html: string): string {
	return html
		.replace(META_REFRESH_RE, "")
		.replace(BASE_RE, "")
		.replace(LINK_RE, (tag) => (PRELOAD_REL_RE.test(tag) ? "" : tag));
}
