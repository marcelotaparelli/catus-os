-- Alinhamento e Aceite. Additive only: a new append-only table and a wider alert list. The
-- previous application version keeps working on this schema, so a rollback of the code does
-- not need a rollback of the data. Existing demands stay without any row: nothing is assumed.
CREATE TABLE request_alignment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  request_id uuid NOT NULL,
  kind text NOT NULL CHECK(kind IN ('agreement','confirmation','risk_authorization','delivered','accepted','rejected','closed_without_acceptance')),
  agreement_version integer CHECK(agreement_version>0),
  criteria text CHECK(length(criteria) BETWEEN 1 AND 4000),
  high_risk boolean,
  reason text CHECK(length(reason) BETWEEN 1 AND 2000),
  evidence_interaction_id uuid,
  recorded_by uuid NOT NULL REFERENCES users(id),
  -- The person recording owns the demand, marked it as delivered or logged hours on it.
  recorded_by_executor boolean NOT NULL DEFAULT false,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(request_id,organization_id) REFERENCES requests(id,organization_id),
  FOREIGN KEY(evidence_interaction_id,organization_id) REFERENCES interactions(id,organization_id),
  CHECK(kind<>'agreement' OR (agreement_version IS NOT NULL AND criteria IS NOT NULL AND high_risk IS NOT NULL)),
  CHECK(kind NOT IN ('confirmation','risk_authorization') OR agreement_version IS NOT NULL),
  -- Silence is never acceptance: a client's answer always points at what the client said.
  CHECK(kind NOT IN ('confirmation','accepted','rejected') OR evidence_interaction_id IS NOT NULL),
  CHECK(kind<>'rejected' OR reason IS NOT NULL)
);
CREATE UNIQUE INDEX request_alignment_one_version ON request_alignment(request_id,agreement_version) WHERE kind='agreement';
CREATE INDEX request_alignment_request_idx ON request_alignment(organization_id,request_id,recorded_at);
-- Same rule and same error as request_events: the trail cannot be rewritten.
CREATE TRIGGER request_alignment_immutable BEFORE UPDATE OR DELETE ON request_alignment FOR EACH ROW EXECUTE FUNCTION forbid_request_event_rewrite();

-- Wider list only: every value the previous version writes stays valid.
ALTER TABLE demand_alerts DROP CONSTRAINT demand_alerts_kind_check;
ALTER TABLE demand_alerts ADD CONSTRAINT demand_alerts_kind_check CHECK(kind IN ('no_owner','overdue','client_delay','over_hours','no_coverage','stalled','blocked','no_follow_up','no_agreement','unconfirmed','awaiting_acceptance','repeated_change','risk_unauthorized'));
