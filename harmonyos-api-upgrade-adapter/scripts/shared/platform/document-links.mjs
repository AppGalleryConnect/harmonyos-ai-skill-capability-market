export function normalizeDocumentUrl(value, { fragment = true } = {}) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    if (url.hostname === 'developer.huawei.com') url.pathname = url.pathname
      .replace(/\/doc\/(?:harmonyos-releases|doccenter-release-notes)\//, '/doc/doccenter-release-notes/');
    url.pathname = url.pathname.replace(/\/$/, '');
    if (!fragment) url.hash = '';
    return url.href;
  } catch { return null; }
}

export function entryUrl(value) {
  const normalized = normalizeDocumentUrl(value);
  if (!normalized) return null;
  const hash = new URL(normalized).hash;
  return hash.length > 1 && !/^#scan-/i.test(hash) ? normalized : null;
}

// A syntactically valid backend URL is not evidence of a public change identity.
export function ruleDocumentLink(rule, providedUrl, { requireEntry = true } = {}) {
  const expected = requireEntry ? entryUrl(rule.url) : normalizeDocumentUrl(rule.url);
  const supplied = normalizeDocumentUrl(providedUrl);
  const rejectedReason = !supplied ? null : /^#scan-/i.test(new URL(supplied).hash)
    ? 'SYNTHETIC_SCAN_ANCHOR' : supplied !== expected ? 'RULE_LINK_MISMATCH' : null;
  return { url: expected ?? '', source: expected ? supplied === expected ? 'VERIFIED_DEVECO_REPORT'
    : rule.documentLink?.source ?? 'VERIFIED_RULE' : null,
    ...(rejectedReason ? { originalUrl: providedUrl, rejectedReason } : {}),
    ...(!expected ? { reason: rule.documentLink?.reason ?? 'DOCUMENT_ENTRY_NOT_VERIFIED' } : {}) };
}
