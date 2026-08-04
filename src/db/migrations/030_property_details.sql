-- Add tax roll pre-fill columns to onboardings
ALTER TABLE onboardings
  ADD COLUMN IF NOT EXISTS year_built      integer,
  ADD COLUMN IF NOT EXISTS sq_ft           integer,
  ADD COLUMN IF NOT EXISTS bedrooms        integer,
  ADD COLUMN IF NOT EXISTS bathrooms       numeric(3,1),
  ADD COLUMN IF NOT EXISTS flood_zone      text,
  ADD COLUMN IF NOT EXISTS sfha            boolean DEFAULT false;
