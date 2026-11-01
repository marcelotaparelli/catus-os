-- Defense in depth for project/client and scope-origin associations.
ALTER TABLE projects ADD CONSTRAINT projects_client_org_unique UNIQUE(id,client_id,organization_id);
ALTER TABLE contracts ADD CONSTRAINT contracts_project_client_fk FOREIGN KEY(project_id,client_id,organization_id) REFERENCES projects(id,client_id,organization_id);
CREATE FUNCTION guard_scope_origin() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE pid uuid;
BEGIN
 SELECT project_id INTO pid FROM scope_versions WHERE id=NEW.scope_id AND organization_id=NEW.organization_id;
 IF NEW.origin_interaction_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM interactions WHERE id=NEW.origin_interaction_id AND organization_id=NEW.organization_id AND project_id=pid) THEN RAISE EXCEPTION 'Invalid scope origin project' USING ERRCODE='23514'; END IF;
 IF NEW.origin_request_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM requests r JOIN interactions i ON i.id=r.interaction_id AND i.organization_id=r.organization_id WHERE r.id=NEW.origin_request_id AND r.organization_id=NEW.organization_id AND i.project_id=pid AND (NEW.origin_interaction_id IS NULL OR i.id=NEW.origin_interaction_id)) THEN RAISE EXCEPTION 'Invalid request origin project' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER scope_origin_guard BEFORE INSERT ON scope_items FOR EACH ROW EXECUTE FUNCTION guard_scope_origin();
CREATE FUNCTION guard_request_coverage() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.scope_item_id IS NULL THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND NEW.scope_item_id IS NOT DISTINCT FROM OLD.scope_item_id THEN RETURN NEW; END IF;
 PERFORM s.id FROM scope_items si JOIN scope_versions s ON s.id=si.scope_id AND s.organization_id=si.organization_id JOIN contracts c ON c.id=s.contract_id AND c.organization_id=s.organization_id JOIN interactions i ON i.project_id=s.project_id AND i.organization_id=s.organization_id
 WHERE si.id=NEW.scope_item_id AND si.organization_id=NEW.organization_id AND i.id=NEW.interaction_id AND s.state='approved' AND c.state='active' AND (now() AT TIME ZONE 'UTC')::date BETWEEN c.valid_from AND c.valid_until FOR SHARE OF s,c;
 IF NOT FOUND THEN RAISE EXCEPTION 'Coverage requires an approved, current scope in the same project' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER request_coverage_guard BEFORE INSERT OR UPDATE OF scope_item_id ON requests FOR EACH ROW EXECUTE FUNCTION guard_request_coverage();
