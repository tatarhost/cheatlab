-- 0003 — access keys on items, style fields on profiles, deduped views.
--
-- LootLabs-style lock: an item can carry an access key. Only the SHA-256 hex is
-- stored (never the key), so a database leak does not hand out the key either;
-- this is the same posture as edit secrets. A non-NULL value locks the body and
-- files behind the key. The key is not recoverable, including by the author -
-- setting a new one replaces it.

ALTER TABLE items ADD COLUMN access_key_hash TEXT;
ALTER TABLE items ADD COLUMN key_hint       TEXT NOT NULL DEFAULT '';

-- Profile design: logo is an https image URL, accent a #hex colour, bg a safe
-- CSS background value (gradients allowed, no url()).
ALTER TABLE user ADD COLUMN logo   TEXT NOT NULL DEFAULT '';
ALTER TABLE user ADD COLUMN accent TEXT NOT NULL DEFAULT '';
ALTER TABLE user ADD COLUMN bg     TEXT NOT NULL DEFAULT '';

-- View counting. Rows are never deleted: one row per (item, client id) means
-- refresh from the same browser counts once, and each additional identity can
-- still be counted. The primary key is what keeps the count honest.
CREATE TABLE IF NOT EXISTS item_view (
  item_id   TEXT NOT NULL,
  client_id TEXT NOT NULL,
  first_at  INTEGER NOT NULL,
  PRIMARY KEY (item_id, client_id)
);
CREATE INDEX IF NOT EXISTS idx_item_view_item ON item_view(item_id);