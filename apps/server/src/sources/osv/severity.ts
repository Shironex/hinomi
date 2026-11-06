import type { AdvisoryCvss, AdvisorySeverity, OsvVulnerability } from '@hinomi/shared'

const WEIGHTS = {
  AV: { N: 0.85, A: 0.62, L: 0.55, P: 0.2 },
  AC: { L: 0.77, H: 0.44 },
  UI: { N: 0.85, R: 0.62 },
  CIA: { H: 0.56, L: 0.22, N: 0 },
} as const

/** CVSS 3.1 "Roundup": smallest one decimal number >= the input, float safe. */
function roundUp(value: number): number {
  const int = Math.round(value * 100000)
  return int % 10000 === 0 ? int / 100000 : (Math.floor(int / 10000) + 1) / 10
}

/** Base score of a CVSS 3.0 or 3.1 vector, or null when the vector is not v3 or is malformed. */
export function cvss3BaseScore(vector: string): number | null {
  if (!/^CVSS:3\.[01]\//.test(vector)) return null
  const m: Record<string, string> = {}
  for (const part of vector.split('/').slice(1)) {
    const [k, v] = part.split(':')
    if (k && v) m[k] = v
  }
  const pick = <T extends Record<string, number>>(table: T, key: string | undefined) =>
    key !== undefined && key in table ? table[key as keyof T] : undefined
  const changed = m.S === 'C'
  const av = pick(WEIGHTS.AV, m.AV)
  const ac = pick(WEIGHTS.AC, m.AC)
  const ui = pick(WEIGHTS.UI, m.UI)
  const pr = pick(changed ? { N: 0.85, L: 0.68, H: 0.5 } : { N: 0.85, L: 0.62, H: 0.27 }, m.PR)
  const c = pick(WEIGHTS.CIA, m.C)
  const i = pick(WEIGHTS.CIA, m.I)
  const a = pick(WEIGHTS.CIA, m.A)
  if (
    av === undefined ||
    ac === undefined ||
    ui === undefined ||
    pr === undefined ||
    c === undefined ||
    i === undefined ||
    a === undefined ||
    (m.S !== 'U' && m.S !== 'C')
  ) {
    return null
  }
  const iss = 1 - (1 - c) * (1 - i) * (1 - a)
  const impact = changed ? 7.52 * (iss - 0.029) - 3.25 * Math.pow(iss - 0.02, 15) : 6.42 * iss
  const exploitability = 8.22 * av * ac * pr * ui
  if (impact <= 0) return 0
  return changed
    ? roundUp(Math.min(1.08 * (impact + exploitability), 10))
    : roundUp(Math.min(impact + exploitability, 10))
}

/** CVSS qualitative bands, with GitHub's word "moderate" for medium. */
export function severityFromScore(score: number): AdvisorySeverity {
  if (score >= 9) return 'critical'
  if (score >= 7) return 'high'
  if (score >= 4) return 'moderate'
  return 'low'
}

const WORDS: Record<string, AdvisorySeverity> = {
  CRITICAL: 'critical',
  HIGH: 'high',
  MODERATE: 'moderate',
  MEDIUM: 'moderate',
  LOW: 'low',
}

export interface DerivedSeverity {
  severity: AdvisorySeverity
  severityRaw: string | null
  cvss: AdvisoryCvss | null
}

/**
 * Severity from the database's own word (`database_specific.severity`, as GHSA
 * records carry) first, then the CVSS v3 vector score. A v4 only vector is kept
 * but not scored, so it yields `unknown` unless the database word exists.
 */
export function deriveSeverity(vuln: OsvVulnerability): DerivedSeverity {
  const vectors = vuln.severity ?? []
  const v3 = vectors.find((s) => s.type === 'CVSS_V3')
  const v4 = vectors.find((s) => s.type === 'CVSS_V4')
  const v3Score = v3 ? cvss3BaseScore(v3.score) : null
  const cvss: AdvisoryCvss | null = v3
    ? { score: v3Score, vector: v3.score }
    : v4
      ? { score: null, vector: v4.score }
      : null

  const word = vuln.database_specific?.severity
  if (typeof word === 'string' && WORDS[word.toUpperCase()]) {
    return { severity: WORDS[word.toUpperCase()]!, severityRaw: word, cvss }
  }
  if (v3Score !== null && v3) {
    return { severity: severityFromScore(v3Score), severityRaw: v3.score, cvss }
  }
  return { severity: 'unknown', severityRaw: cvss?.vector ?? null, cvss }
}
