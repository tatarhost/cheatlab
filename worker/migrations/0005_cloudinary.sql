-- Byte storage moves off Workers KV onto Cloudinary, and an item learns which
-- game it belongs to.
--
-- `store` is 'kv' for every file uploaded before this migration, so the old
-- blobs keep serving and nothing has to be re-uploaded. New uploads land in
-- Cloudinary and carry their delivery URL in `url` and the public id in `rid`
-- (the public id is what a takedown has to hand to the destroy API).
--
-- The game fields are all free-form on purpose: a game id is only meaningful to
-- the site that can resolve it, and the site that resolves it changes. They are
-- filled in by the browser from the game's own public API, not by the Worker,
-- because the Worker must stay free of outbound calls it cannot cache.
ALTER TABLE files ADD COLUMN store TEXT NOT NULL DEFAULT 'kv';
ALTER TABLE files ADD COLUMN url   TEXT NOT NULL DEFAULT '';
ALTER TABLE files ADD COLUMN rid   TEXT NOT NULL DEFAULT '';

-- `game_id` is the id on the game's own platform, `game_name` / `game_author`
-- the names as they were when the paste was written (a rename upstream must not
-- rewrite history), `game_cover` a cover url and `key_system` the name of the
-- key system the script talks to.
ALTER TABLE items ADD COLUMN game_id     TEXT NOT NULL DEFAULT '';
ALTER TABLE items ADD COLUMN game_name   TEXT NOT NULL DEFAULT '';
ALTER TABLE items ADD COLUMN game_author TEXT NOT NULL DEFAULT '';
ALTER TABLE items ADD COLUMN game_cover  TEXT NOT NULL DEFAULT '';
ALTER TABLE items ADD COLUMN key_system  TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS items_game ON items (game_id) WHERE game_id <> '';
