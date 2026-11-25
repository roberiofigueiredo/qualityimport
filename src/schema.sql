-- Esquema do banco de dados (SQLite). Todas as datas/horas em ISO 8601 (UTC),
-- exceto datas e horários de eventos, guardados no horário local (America/Sao_Paulo).

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS branches (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  city        TEXT,
  address     TEXT,
  phone       TEXT,
  whatsapp    TEXT,
  hours       TEXT,
  map_url     TEXT,
  show_on_site INTEGER NOT NULL DEFAULT 1,
  active      INTEGER NOT NULL DEFAULT 1,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS sectors (
  id     INTEGER PRIMARY KEY,
  name   TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS product_lines (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  icon        TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  active      INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT,
  role          TEXT NOT NULL CHECK (role IN ('colaborador','marketing','ti')),
  branch_id     INTEGER REFERENCES branches(id),
  sector_id     INTEGER REFERENCES sectors(id),
  status        TEXT NOT NULL DEFAULT 'convidado' CHECK (status IN ('convidado','ativo','desativado')),
  last_login_at TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deactivated_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,           -- hash SHA-256 do token do cookie
  user_id    INTEGER NOT NULL REFERENCES users(id),
  csrf       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

-- Convites e redefinições de senha (uso único)
CREATE TABLE IF NOT EXISTS password_tokens (
  id         TEXT PRIMARY KEY,           -- hash SHA-256 do token
  user_id    INTEGER NOT NULL REFERENCES users(id),
  kind       TEXT NOT NULL CHECK (kind IN ('convite','redefinicao')),
  expires_at TEXT NOT NULL,
  used_at    TEXT,
  created_at TEXT NOT NULL
);

-- E-mails enviados (ou que seriam enviados, quando o SMTP não está configurado)
CREATE TABLE IF NOT EXISTS email_outbox (
  id         INTEGER PRIMARY KEY,
  to_email   TEXT NOT NULL,
  subject    TEXT NOT NULL,
  body       TEXT NOT NULL,
  delivered  INTEGER NOT NULL DEFAULT 0,
  error      TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS categories (
  id     INTEGER PRIMARY KEY,
  name   TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1
);

-- Arquivos enviados (capas, anexos, fotos, logomarca). Nunca servidos diretamente:
-- passam pela rota /arquivos/:id, que verifica a permissão.
CREATE TABLE IF NOT EXISTS files (
  id            TEXT PRIMARY KEY,
  original_name TEXT NOT NULL,
  mime          TEXT NOT NULL,
  size          INTEGER NOT NULL,
  storage_name  TEXT NOT NULL,
  owner_type    TEXT,                    -- 'post_cover','post_attachment','photo','site'
  owner_id      INTEGER,
  uploaded_by   INTEGER REFERENCES users(id),
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS files_owner ON files(owner_type, owner_id);

-- Conteúdo: informativos (posts), álbuns e eventos compartilham o fluxo de publicação.
-- status: rascunho | agendado | publicado | arquivado
CREATE TABLE IF NOT EXISTS posts (
  id            INTEGER PRIMARY KEY,
  title         TEXT NOT NULL,
  summary       TEXT,
  body_html     TEXT,
  category_id   INTEGER REFERENCES categories(id),
  cover_file_id TEXT REFERENCES files(id),
  priority      INTEGER NOT NULL DEFAULT 0,
  requires_ack  INTEGER NOT NULL DEFAULT 0,
  audience_all  INTEGER NOT NULL DEFAULT 1,
  status        TEXT NOT NULL DEFAULT 'rascunho',
  starts_at     TEXT,                    -- início da exibição
  ends_at       TEXT,                    -- fim da exibição (opcional)
  published_at  TEXT,
  created_by    INTEGER NOT NULL REFERENCES users(id),
  updated_by    INTEGER REFERENCES users(id),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS post_reads (
  post_id      INTEGER NOT NULL REFERENCES posts(id),
  user_id      INTEGER NOT NULL REFERENCES users(id),
  first_read_at TEXT NOT NULL,
  confirmed_at TEXT,
  PRIMARY KEY (post_id, user_id)
);

CREATE TABLE IF NOT EXISTS albums (
  id            INTEGER PRIMARY KEY,
  title         TEXT NOT NULL,
  description   TEXT,
  album_date    TEXT,                    -- AAAA-MM-DD
  cover_photo_id INTEGER,
  audience_all  INTEGER NOT NULL DEFAULT 1,
  status        TEXT NOT NULL DEFAULT 'rascunho',
  starts_at     TEXT,
  ends_at       TEXT,
  published_at  TEXT,
  created_by    INTEGER NOT NULL REFERENCES users(id),
  updated_by    INTEGER REFERENCES users(id),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS photos (
  id         INTEGER PRIMARY KEY,
  album_id   INTEGER NOT NULL REFERENCES albums(id),
  file_id    TEXT NOT NULL REFERENCES files(id),
  caption    TEXT,
  position   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id            INTEGER PRIMARY KEY,
  title         TEXT NOT NULL,
  description   TEXT,
  event_date    TEXT NOT NULL,           -- AAAA-MM-DD (horário local)
  start_time    TEXT,                    -- HH:MM
  end_time      TEXT,                    -- HH:MM
  location      TEXT,
  audience_all  INTEGER NOT NULL DEFAULT 1,
  status        TEXT NOT NULL DEFAULT 'rascunho',
  starts_at     TEXT,
  ends_at       TEXT,
  published_at  TEXT,
  cancelled     INTEGER NOT NULL DEFAULT 0,
  cancel_reason TEXT,
  created_by    INTEGER NOT NULL REFERENCES users(id),
  updated_by    INTEGER REFERENCES users(id),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- Mudanças de agenda exibidas aos colaboradores afetados
CREATE TABLE IF NOT EXISTS event_changes (
  id          INTEGER PRIMARY KEY,
  event_id    INTEGER NOT NULL REFERENCES events(id),
  description TEXT NOT NULL,
  changed_by  INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL
);

-- Público-alvo: se audience_all = 0, o conteúdo é visível para quem estiver
-- em uma das filiais selecionadas (se houver) E em um dos setores selecionados (se houver).
CREATE TABLE IF NOT EXISTS audiences (
  content_type TEXT NOT NULL CHECK (content_type IN ('post','album','event')),
  content_id   INTEGER NOT NULL,
  branch_id    INTEGER REFERENCES branches(id),
  sector_id    INTEGER REFERENCES sectors(id)
);
CREATE INDEX IF NOT EXISTS audiences_content ON audiences(content_type, content_id);

-- Histórico de alterações (permissões e conteúdo)
CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER REFERENCES users(id),
  action      TEXT NOT NULL,
  entity_type TEXT,
  entity_id   TEXT,
  details     TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_created ON audit_log(created_at);
