// Rule identities, CSV records and physical locations are separate units.
export function findingStatistics(rows) {
  const identities = rows.map(row => (row['Rule ID'] || row['Source Reference']) && row['Changed in SDK']
    ? JSON.stringify([row['Rule ID'] || row['Source Reference'], row['Changed in SDK']]) : null);
  return { ruleCount: identities.every(Boolean) ? new Set(identities).size : null,
    rowCount: rows.length, codeLocationCount: new Set(rows.map(row => row['Code Location'])).size };
}
