import type { Pool } from 'pg';
import { ProviderError, fingerprint, estimateCost } from './provider';
import type {
  ExtractionProvider,
  ProviderResult,
  ModelConfig,
} from './provider';
import { findDuplicates } from './duplicates';
async function systemEvent(
  db: import('pg').PoolClient,
  org: string,
  id: string,
  action: string,
) {
  await db.query(
    "INSERT INTO audit_events(organization_id,actor,entity_type,entity_id,action) VALUES($1,'ai-worker','extraction',$2,$3)",
    [org, id, action],
  );
}
async function settle(
  db: import('pg').PoolClient,
  job: {
    organization_id: unknown;
    budget_day: unknown;
    reserved_micro_usd: unknown;
  },
  amount: number,
) {
  await db.query(
    'UPDATE ai_budget_days SET reserved_micro_usd=reserved_micro_usd-$3,spent_micro_usd=spent_micro_usd+$4 WHERE organization_id=$1 AND day=$2',
    [job.organization_id, job.budget_day, job.reserved_micro_usd, amount],
  );
}
export async function processOne(
  db: Pool,
  provider: ExtractionProvider | undefined,
) {
  // Ambiguous crashed attempts are terminal, conservatively charged; never auto-resend a paid request.
  const c = await db.connect();
  let job:
    | {
        id: string;
        organization_id: string;
        interaction_id: string;
        project_id: string;
        requested_by: string;
        source_text: string;
        provider_config: ModelConfig;
        policy_reference: string;
        data_scope: string;
        budget_day: string | Date;
        reserved_micro_usd: string;
      }
    | undefined;
  try {
    await c.query('BEGIN');
    const expired = (
      await c.query(
        "SELECT * FROM extraction_jobs WHERE state='running' AND lease_until<now() ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED",
      )
    ).rows;
    for (const j of expired) {
      await settle(c, j, Number(j.reserved_micro_usd));
      await c.query(
        "UPDATE extraction_jobs SET state='failed',failure_code='worker_interrupted',consumed_micro_usd=reserved_micro_usd,completed_at=now() WHERE id=$1",
        [j.id],
      );
      await systemEvent(
        c,
        j.organization_id,
        j.id,
        'failed:worker_interrupted',
      );
    }
    if (provider) {
      job = (
        await c.query(
          "SELECT * FROM extraction_jobs WHERE state='queued' AND attempts=0 ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED",
        )
      ).rows[0];
      if (job)
        await c.query(
          "UPDATE extraction_jobs SET state='running',attempts=1,lease_until=now()+interval '90 seconds' WHERE id=$1",
          [job.id],
        );
    }
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
  if (!job || !provider) return false;
  let output: ProviderResult | undefined;
  let failure: string | undefined;
  let sent = false;
  let usage: { inputTokens: number; outputTokens: number } | undefined;
  const started = performance.now();
  try {
    const policy = (
      await db.query(
        `SELECT p.*,m.role,m.active member_active,u.active user_active FROM ai_policies p JOIN memberships m ON m.organization_id=p.organization_id AND m.user_id=$2 JOIN users u ON u.id=m.user_id WHERE p.organization_id=$1`,
        [job.organization_id, job.requested_by],
      )
    ).rows[0];
    if (
      !policy?.enabled ||
      !policy.member_active ||
      !policy.user_active ||
      !['administrator', 'manager', 'po'].includes(policy.role) ||
      policy.policy_reference !== job.policy_reference ||
      (job.data_scope === 'authorized_client' &&
        (policy.data_scope !== 'authorized_client' ||
          !provider.config.clientDataAllowed))
    )
      throw new ProviderError('authorization_changed');
    if (
      fingerprint(job.provider_config as ModelConfig) !==
      fingerprint(provider.config)
    )
      throw new ProviderError('configuration_changed');
    const budget = (
      await db.query(
        "SELECT *,day=(now() AT TIME ZONE 'UTC')::date valid_day FROM ai_budget_days WHERE organization_id=$1 AND day=$2",
        [job.organization_id, job.budget_day],
      )
    ).rows[0];
    if (!budget?.valid_day) throw new ProviderError('reservation_day_expired');
    if (
      Number(job.reserved_micro_usd) >
        Number(policy.per_job_budget_micro_usd) ||
      Number(budget.reserved_micro_usd) + Number(budget.spent_micro_usd) >
        Number(policy.daily_budget_micro_usd)
    )
      throw new ProviderError('budget_policy_changed');
    sent = true;
    output = await provider.extract(job.source_text);
    if (output.inputTokens !== null && output.outputTokens !== null)
      usage = {
        inputTokens: output.inputTokens,
        outputTokens: output.outputTokens,
      };
  } catch (e) {
    failure = e instanceof ProviderError ? e.code : 'provider_failure';
    if (e instanceof ProviderError) {
      usage = e.usage;
      if (e.code === 'input_limit') sent = false;
    }
  }
  const result = await db.connect();
  try {
    await result.query('BEGIN');
    const current = (
      await result.query(
        "SELECT state FROM extraction_jobs WHERE id=$1 AND state='running' AND lease_until>now() FOR UPDATE",
        [job.id],
      )
    ).rows[0];
    if (!current) {
      await result.query('ROLLBACK');
      return true;
    }
    const policy = (
      await result.query(
        'SELECT p.enabled,p.data_scope,p.policy_reference,m.active member_active,u.active user_active,m.role FROM ai_policies p JOIN memberships m ON m.organization_id=p.organization_id AND m.user_id=$2 JOIN users u ON u.id=m.user_id WHERE p.organization_id=$1',
        [job.organization_id, job.requested_by],
      )
    ).rows[0];
    if (
      !policy?.enabled ||
      !policy.member_active ||
      !policy.user_active ||
      !['administrator', 'manager', 'po'].includes(policy.role) ||
      policy.policy_reference !== job.policy_reference ||
      (job.data_scope === 'authorized_client' &&
        policy.data_scope !== 'authorized_client')
    ) {
      failure = 'authorization_changed';
      output = undefined;
    }
    const measured =
      output && output.inputTokens !== null && output.outputTokens !== null
        ? { inputTokens: output.inputTokens, outputTokens: output.outputTokens }
        : usage;
    const estimate = measured
      ? estimateCost(
          provider.config,
          measured.inputTokens,
          measured.outputTokens,
        )
      : null;
    const consumed = sent ? (estimate ?? Number(job.reserved_micro_usd)) : 0;
    await settle(result, job, consumed);
    if (output && !failure) {
      for (const p of output.result.proposals) {
        const id = crypto.randomUUID();
        const duplicates = await findDuplicates(
          result,
          job.organization_id,
          job.project_id,
          p.title,
        );
        await result.query(
          'INSERT INTO ai_proposals(id,organization_id,extraction_id,title,description,evidence,acceptance_criteria,duplicates) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
          [
            id,
            job.organization_id,
            job.id,
            p.title,
            p.description,
            JSON.stringify(p.evidence),
            JSON.stringify(p.acceptance_criteria),
            JSON.stringify(duplicates),
          ],
        );
      }
      await result.query(
        "UPDATE extraction_jobs SET state='succeeded',result=$2,input_tokens=$3,output_tokens=$4,latency_ms=$5,estimated_cost_micro_usd=$6,consumed_micro_usd=$7,completed_at=now(),lease_until=NULL WHERE id=$1",
        [
          job.id,
          output.result,
          output.inputTokens,
          output.outputTokens,
          output.latencyMs,
          estimate,
          consumed,
        ],
      );
      await systemEvent(
        result,
        job.organization_id,
        job.id,
        'completed:unreviewed-proposals',
      );
    } else {
      await result.query(
        "UPDATE extraction_jobs SET state='failed',failure_code=$2,latency_ms=$3,consumed_micro_usd=$4,input_tokens=$5,output_tokens=$6,estimated_cost_micro_usd=$7,completed_at=now(),lease_until=NULL WHERE id=$1",
        [
          job.id,
          failure ?? 'provider_failure',
          Math.round(performance.now() - started),
          consumed,
          measured?.inputTokens ?? null,
          measured?.outputTokens ?? null,
          estimate,
        ],
      );
      await systemEvent(
        result,
        job.organization_id,
        job.id,
        'failed:' + (failure ?? 'provider_failure'),
      );
    }
    await result.query('COMMIT');
  } catch (e) {
    await result.query('ROLLBACK');
    throw e;
  } finally {
    result.release();
  }
  return true;
}
