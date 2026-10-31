import type { PoolClient } from 'pg';
import type { Duplicate } from '../../shared/extraction';
const normalize = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
export async function findDuplicates(
  db: PoolClient,
  org: string,
  project: string,
  title: string,
  exclude?: string,
): Promise<Duplicate[]> {
  const candidates = (
    await db.query(
      `SELECT r.id,'request' type,r.title FROM requests r JOIN interactions i ON i.id=r.interaction_id AND i.organization_id=r.organization_id WHERE r.organization_id=$1 AND i.project_id=$2
 UNION ALL SELECT p.id,'proposal' type,p.title FROM ai_proposals p JOIN extraction_jobs j ON j.id=p.extraction_id AND j.organization_id=p.organization_id WHERE p.organization_id=$1 AND j.project_id=$2 AND p.state='proposed' AND ($3::uuid IS NULL OR p.id<>$3) LIMIT 500`,
      [org, project, exclude ?? null],
    )
  ).rows;
  const needle = normalize(title);
  const words = new Set(needle.split(' '));
  return candidates
    .flatMap((c) => {
      const normalized = normalize(c.title);
      if (normalized === needle) return [{ ...c, reason: 'same_title' }];
      const other = new Set(normalized.split(' '));
      const overlap = [...words].filter((w) => other.has(w)).length;
      return words.size >= 3 &&
        overlap / new Set([...words, ...other]).size >= 0.6
        ? [{ ...c, reason: 'similar_text' }]
        : [];
    })
    .slice(0, 10);
}
