-- dsh-companion schema v14 fixture (generated from git 1fdfcbd)
CREATE TABLE schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE entities (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN ('person','org','place','pet','thing','project')),
  name          TEXT NOT NULL,
  aliases_json  TEXT NOT NULL DEFAULT '[]',
  relation      TEXT,
  privacy       TEXT NOT NULL DEFAULT 'normal' CHECK (privacy IN ('normal','sensitive','secret')),
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  deleted_at    INTEGER
);
CREATE TABLE consolidations (
  id            TEXT PRIMARY KEY,
  scope         TEXT NOT NULL,
  session_id    TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('nap','deep','forget_flush')),
  trigger       TEXT NOT NULL,
  upto_seq      INTEGER NOT NULL,
  turn_from     INTEGER,
  turn_to       INTEGER,
  tokens_in     INTEGER,
  tokens_out    INTEGER,
  status        TEXT NOT NULL CHECK (status IN ('running','written','compacted','failed')),
  error         TEXT,
  started_at    INTEGER NOT NULL,
  finished_at   INTEGER,
  compaction_start_seq INTEGER
);
CREATE TABLE episodes (
  id                  TEXT PRIMARY KEY,
  scope               TEXT NOT NULL DEFAULT 'main',
  session_id          TEXT NOT NULL,
  consolidation_id    TEXT REFERENCES consolidations(id),
  started_at          INTEGER NOT NULL,
  ended_at            INTEGER NOT NULL,
  title               TEXT NOT NULL,
  summary             TEXT,
  evidence            TEXT,
  topics_json         TEXT NOT NULL DEFAULT '[]',
  entities_json       TEXT NOT NULL DEFAULT '[]',
  mood                TEXT CHECK (mood IN ('positive','neutral','tired','anxious','low','excited')),
  mood_evidence       TEXT,
  salience            TEXT NOT NULL CHECK (salience IN ('trivial','normal','notable','explicit','pinned')),
  privacy             TEXT NOT NULL DEFAULT 'normal' CHECK (privacy IN ('normal','sensitive','secret')),
  strength_days       REAL,
  last_reinforced_at  INTEGER NOT NULL,
  recall_count        INTEGER NOT NULL DEFAULT 0,
  fidelity            TEXT NOT NULL DEFAULT 'full' CHECK (fidelity IN ('full','gist','index')),
  status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','dormant','tombstoned')),
  deleted_at          INTEGER,
  purge_payload       TEXT,
  created_at          INTEGER NOT NULL DEFAULT (unixepoch()),
  CONSTRAINT ck_ep_pin_decay CHECK ((salience = 'pinned' AND strength_days IS NULL)
                                 OR (salience <> 'pinned' AND strength_days IS NOT NULL))
);
CREATE TABLE facts (
  id                  TEXT PRIMARY KEY,
  scope               TEXT NOT NULL DEFAULT 'main',
  kind                TEXT NOT NULL CHECK (kind IN ('identity','relation','preference','project','knowledge','other')),
  subject_id          TEXT REFERENCES entities(id),
  subject_text        TEXT NOT NULL,
  predicate           TEXT NOT NULL,
  object_text         TEXT,
  statement           TEXT NOT NULL,
  source_kind         TEXT NOT NULL CHECK (source_kind IN ('user_explicit','turn','task','consolidated','inferred')),
  source_episode_id   TEXT REFERENCES episodes(id),
  source_excerpt      TEXT,
  salience            TEXT NOT NULL CHECK (salience IN ('trivial','normal','notable','explicit','pinned')),
  privacy             TEXT NOT NULL DEFAULT 'normal' CHECK (privacy IN ('normal','sensitive','secret')),
  observed_at         INTEGER NOT NULL,
  valid_from          INTEGER,
  valid_to            INTEGER,
  strength_days       REAL,
  last_reinforced_at  INTEGER NOT NULL,
  recall_count        INTEGER NOT NULL DEFAULT 0,
  fidelity            TEXT NOT NULL DEFAULT 'full' CHECK (fidelity IN ('full','gist','index')),
  status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','dormant','superseded','tombstoned')),
  superseded_by       TEXT REFERENCES facts(id),
  deleted_at          INTEGER,
  purge_payload       TEXT,
  created_at          INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at          INTEGER NOT NULL DEFAULT (unixepoch()),
  first_reneed_at     INTEGER,
  first_reneed_tier   TEXT,
  reneed_kind         TEXT,
  same_context        INTEGER NOT NULL DEFAULT 0 CHECK (same_context IN (0,1)),
  first_used_at       INTEGER,
  first_used_tier     TEXT,
  used_same_context   INTEGER CHECK (used_same_context IN (0,1)),
  CONSTRAINT ck_fact_pin_decay CHECK ((salience = 'pinned' AND strength_days IS NULL)
                                   OR (salience <> 'pinned' AND strength_days IS NOT NULL))
);
CREATE TABLE fact_vectors (
  fact_id     TEXT PRIMARY KEY REFERENCES facts(id) ON DELETE CASCADE,
  dim         INTEGER NOT NULL,
  vec         BLOB NOT NULL,
  embedder_id TEXT NOT NULL DEFAULT '',
  updated_at  INTEGER NOT NULL
);
CREATE TABLE reminders (
  id                TEXT PRIMARY KEY,
  scope             TEXT NOT NULL DEFAULT 'main',
  kind              TEXT NOT NULL CHECK (kind IN ('todo','schedule','repeat','commitment')),
  title             TEXT NOT NULL,
  detail            TEXT,
  counterparty      TEXT,
  due_at            INTEGER,
  due_granularity   TEXT CHECK (due_granularity IN ('exact','day','week','month','none')),
  rrule             TEXT,
  next_fire_at      INTEGER,
  retry_at          INTEGER,
  last_fire_key     TEXT,
  occurrence_key    TEXT,
  status            TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','delivering','fired','snoozed','done','cancelled','expired')),
  closed_at         INTEGER,
  source_episode_id TEXT REFERENCES episodes(id),
  delivery_attempts INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at        INTEGER NOT NULL DEFAULT (unixepoch()),
  deleted_at        INTEGER
);
CREATE TABLE state_board (
  id                TEXT PRIMARY KEY,
  scope             TEXT NOT NULL,
  section           TEXT NOT NULL CHECK (section IN ('in_progress','decided','open_question','upcoming','threads')),
  line              TEXT NOT NULL,
  ref_episode_id    TEXT REFERENCES episodes(id),
  ref_thread_key    TEXT,
  last_mentioned_at INTEGER NOT NULL,
  created_at        INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at        INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE state_board_rev (
  scope            TEXT PRIMARY KEY,
  revision         INTEGER NOT NULL,
  rendered         TEXT NOT NULL,
  staged_revision  INTEGER,
  staged_rendered  TEXT,
  staged_at        INTEGER,
  updated_at       INTEGER NOT NULL
);
CREATE TABLE emotion_state (
  scope         TEXT PRIMARY KEY,
  pleasure      REAL NOT NULL,
  arousal       REAL NOT NULL,
  dominance     REAL NOT NULL,
  energy        REAL NOT NULL,
  updated_at    INTEGER NOT NULL,  -- 毫秒
  last_event_at INTEGER            -- 毫秒，可空
);
CREATE TABLE emotion_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  scope       TEXT NOT NULL,
  at          INTEGER NOT NULL,    -- 毫秒
  type        TEXT NOT NULL,
  deltas_json TEXT NOT NULL,       -- {"pleasure":..,"arousal":..,"dominance":..,"energy":..}
  note        TEXT
);
CREATE TABLE threads (
  key             TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  session_id      TEXT NOT NULL,
  description     TEXT NOT NULL,
  last_progress   TEXT,
  last_active_at  INTEGER NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived','retired')),
  created_at      INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE memory_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          INTEGER NOT NULL DEFAULT (unixepoch()),
  action      TEXT NOT NULL CHECK (action IN (
                'ADD','UPDATE','SUPERSEDE','MERGE','NOOP','SKIP',
                'REINFORCE','DECAY','DEGRADE','TOMBSTONE','RESTORE','PURGED',
                'READ','USED','EXPORT')),
  table_name  TEXT NOT NULL,
  row_id      TEXT,
  actor       TEXT NOT NULL CHECK (actor IN ('consolidator','user','scheduler','migrator')),
  reason      TEXT,
  detail_json TEXT
);
CREATE VIRTUAL TABLE fts_facts USING fts5(txt, tokenize = 'unicode61');
CREATE TABLE 'fts_facts_data'(id INTEGER PRIMARY KEY, block BLOB);
CREATE TABLE 'fts_facts_idx'(segid, term, pgno, PRIMARY KEY(segid, term)) WITHOUT ROWID;
CREATE TABLE 'fts_facts_content'(id INTEGER PRIMARY KEY, c0);
CREATE TABLE 'fts_facts_docsize'(id INTEGER PRIMARY KEY, sz BLOB);
CREATE TABLE 'fts_facts_config'(k PRIMARY KEY, v) WITHOUT ROWID;
CREATE VIRTUAL TABLE fts_episodes USING fts5(txt, tokenize = 'unicode61');
CREATE TABLE 'fts_episodes_data'(id INTEGER PRIMARY KEY, block BLOB);
CREATE TABLE 'fts_episodes_idx'(segid, term, pgno, PRIMARY KEY(segid, term)) WITHOUT ROWID;
CREATE TABLE 'fts_episodes_content'(id INTEGER PRIMARY KEY, c0);
CREATE TABLE 'fts_episodes_docsize'(id INTEGER PRIMARY KEY, sz BLOB);
CREATE TABLE 'fts_episodes_config'(k PRIMARY KEY, v) WITHOUT ROWID;
CREATE INDEX ix_ent_name ON entities(name);
CREATE UNIQUE INDEX ux_consolidations_scope_upto ON consolidations(scope, upto_seq, kind);
CREATE INDEX ix_consolidations_scope ON consolidations(scope, upto_seq);
CREATE INDEX ix_ep_scope_time ON episodes(scope, started_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX ix_ep_decay ON episodes(status, last_reinforced_at) WHERE strength_days IS NOT NULL;
CREATE INDEX ix_ep_purge ON episodes(deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX ix_facts_key ON facts(subject_text, predicate, status);
CREATE INDEX ix_facts_scope ON facts(scope, status) WHERE deleted_at IS NULL;
CREATE INDEX ix_facts_decay ON facts(status, last_reinforced_at) WHERE strength_days IS NOT NULL;
CREATE INDEX ix_facts_purge ON facts(deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX ix_fact_vectors_dim ON fact_vectors(dim);
CREATE INDEX ix_rm_done ON reminders(closed_at) WHERE status IN ('done','cancelled');
CREATE INDEX ix_sb_scope ON state_board(scope, section, last_mentioned_at DESC);
CREATE INDEX ix_emotion_events ON emotion_events (scope, at);
CREATE UNIQUE INDEX ux_threads_session ON threads(session_id);
CREATE INDEX ix_ev_row ON memory_events(table_name, row_id, at DESC);
CREATE INDEX ix_rm_due ON reminders(status, max(COALESCE(next_fire_at, 0), COALESCE(retry_at, 0)))
        WHERE status IN ('pending','snoozed');
CREATE INDEX ix_fact_vectors_embedder ON fact_vectors(embedder_id);
CREATE INDEX ix_facts_reneed ON facts(scope, first_reneed_at);
CREATE INDEX ix_facts_used ON facts(scope, first_used_at);
CREATE TRIGGER ev_no_update BEFORE UPDATE ON memory_events
BEGIN SELECT RAISE(ABORT,'append-only'); END;
CREATE TRIGGER ev_no_delete BEFORE DELETE ON memory_events
BEGIN SELECT RAISE(ABORT,'append-only'); END;
CREATE TRIGGER trg_reminders_reschedule_clear_retry
      AFTER UPDATE OF next_fire_at ON reminders
      WHEN NEW.next_fire_at IS NOT OLD.next_fire_at
       AND NEW.retry_at IS NOT NULL
      BEGIN
        UPDATE reminders SET retry_at = NULL WHERE id = NEW.id;
      END;
CREATE TRIGGER trg_facts_reneed_kind_ins
      BEFORE INSERT ON facts
      WHEN NEW.reneed_kind IS NOT NULL
       AND NEW.reneed_kind NOT IN ('recall', 'dedupe', 'correction', 'used')
      BEGIN
        SELECT RAISE(ABORT, 'invalid facts.reneed_kind');
      END;
CREATE TRIGGER trg_facts_reneed_kind_upd
      BEFORE UPDATE OF reneed_kind ON facts
      WHEN NEW.reneed_kind IS NOT NULL
       AND NEW.reneed_kind NOT IN ('recall', 'dedupe', 'correction', 'used')
      BEGIN
        SELECT RAISE(ABORT, 'invalid facts.reneed_kind');
      END;
