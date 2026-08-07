-- Expand entity_type check constraint to support granular types
-- Old: individual, trust, business
-- New: individual, trust, business (kept for existing rows), corp, partnership, llc

ALTER TABLE onboardings DROP CONSTRAINT onboardings_entity_type_check;

ALTER TABLE onboardings ADD CONSTRAINT onboardings_entity_type_check
  CHECK (entity_type IN ('individual', 'trust', 'business', 'corp', 'partnership', 'llc'));
