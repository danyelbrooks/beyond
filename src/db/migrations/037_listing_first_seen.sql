-- Tracks when each BPM website listing first appeared.
-- The daily sync inserts new listings (first_seen = today) and updates
-- last_seen each day the listing is still live. first_seen never changes
-- after the initial insert, giving an accurate "days on market" start date.

CREATE TABLE IF NOT EXISTS listing_first_seen (
  listing_id  TEXT PRIMARY KEY,       -- BPM website listing ID (e.g. "148")
  address     TEXT,                   -- Human-readable address parsed from URL slug
  unit_id     TEXT,                   -- AppFolio unit UUID
  property_id TEXT,                   -- AppFolio property UUID
  first_seen  DATE NOT NULL DEFAULT CURRENT_DATE,
  last_seen   DATE NOT NULL DEFAULT CURRENT_DATE
);

CREATE INDEX IF NOT EXISTS listing_first_seen_last_seen_idx ON listing_first_seen (last_seen);
CREATE INDEX IF NOT EXISTS listing_first_seen_unit_id_idx   ON listing_first_seen (unit_id);
