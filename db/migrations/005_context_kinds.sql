ALTER TABLE interactions DROP CONSTRAINT interactions_kind_check;
ALTER TABLE interactions ADD CONSTRAINT interactions_kind_check CHECK(kind IN ('meeting','service','conversation','observation'));
