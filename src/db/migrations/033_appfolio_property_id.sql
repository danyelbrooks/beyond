ALTER TABLE public.onboardings
  ADD COLUMN IF NOT EXISTS appfolio_property_id text;
