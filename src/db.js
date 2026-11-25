const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { nowIso } = require('./lib/dates');

const DEFAULT_SETTINGS = {
  company_name: 'Quality Import Peças',
  slogan: 'Há mais de 30 anos no mercado de autopeças.',
  subtitle:
    'Peças automotivas e acessórios para veículos nacionais e importados. Encontre a loja mais próxima ou peça seu orçamento agora mesmo pelo WhatsApp.',
  about_text:
    'A Quality Import Peças atua no mercado de peças automotivas e acessórios para veículos nacionais e importados há mais de 30 anos. ' +
    'Fazemos parte da Rede Âncora, uma das maiores distribuidoras de autopeças do Brasil, e atendemos em duas unidades: ' +
    'Recife (matriz) e Abreu e Lima (filial).',
  rede_ancora: '1',
  differentials: 'Os melhores preços do mercado\nRetire na loja ou receba em casa\nMarcas nacionais e internacionais\nDivida sua compra em até 10x',
  stats: '+30 | anos no mercado\n+80 mil | itens cadastrados\n+3 mi | clientes atendidos\n+100 | fornecedores',
  delivery_note: 'Prazos médios de segunda a sexta. Se a peça precisar ser retirada no Centro de Distribuição, acrescente 1 hora.',
  whatsapp_number: '(81) 2119-0161',
  whatsapp_message: 'Olá! Gostaria de solicitar um orçamento de peças.',
  contact_email: 'contato@qualityimport.net.br',
  contact_phone: '(81) 2119-0161',
  instagram_url: '',
  facebook_url: '',
  cnpj: '24.422.016/0001-50',
  logo_file_id: '',
  hero_file_id: '',
};

// Colunas adicionadas depois da primeira versão (migração simples e idempotente)
const BRANCH_EXTRA_COLUMNS = {
  lat: 'REAL',
  lng: 'REAL',
  map_embed: 'TEXT',
  delivery_start: 'TEXT',
  delivery_regions: 'TEXT',
};

const SEED_BRANCHES = [
  {
    name: 'Matriz — Avenida Norte',
    city: 'Recife - PE',
    address: 'Av. Norte Miguel Arraes de Alencar, 1048 - Santo Amaro, Recife - PE',
    phone: '(81) 2119-0161',
    whatsapp: '(81) 2119-0161',
    hours: 'Segunda a sexta: 07:00 às 17:00\nSábado: 07:00 às 13:00',
    lat: -8.0441855,
    lng: -34.8814488,
    map_embed:
      'https://www.google.com/maps/embed?pb=!1m18!1m12!1m3!1d3950.560289249693!2d-34.8814488!3d-8.0441855!2m3!1f0!2f0!3f0!3m2!1i1024!2i768!4f13.1!3m3!1m2!1s0x7ab18523b48bf35%3A0x5080431021882d4c!2sQuality%20Pe%C3%A7as%20Automotivas!5e0!3m2!1spt-BR!2sbr!4v1736815119915!5m2!1spt-BR!2sbr',
    delivery_start: '08:00',
    delivery_regions: 'Recife | 1h30 | 16:00 | 12:00\nOlinda | 1h30 | 16:00 | 12:00\nPraia Sul | 2h | 16:00 | 11:00\nJaboatão | 3h | 15:00 | 11:00\nCamaragibe | 3h | 15:00 | 11:00',
  },
  {
    name: 'Filial Abreu e Lima',
    city: 'Abreu e Lima - PE',
    address: 'Av. Brasil, 2 - Alto da Bela Vista, Abreu e Lima - PE, 53525-790',
    phone: '',
    whatsapp: '',
    hours: '',
    lat: -7.90888,
    lng: -34.9019392,
    map_embed:
      'https://www.google.com/maps/embed?pb=!1m18!1m12!1m3!1d3951.8677648244015!2d-34.9019392!3d-7.90888!2m3!1f0!2f0!3f0!3m2!1i1024!2i768!4f13.1!3m3!1m2!1s0x7ab15ca3a66216f%3A0xeee8925cf2bc70b0!2sAv.%20Brasil%2C%202%20-%20Alto%20da%20Bela%20Vista%2C%20Abreu%20e%20Lima%20-%20PE%2C%2053525-790!5e0!3m2!1spt-BR!2sbr!4v1760106930531!5m2!1spt-BR!2sbr',
    delivery_start: '08:00',
    delivery_regions: 'Abreu e Lima | 1h | 16:00 | 12:00\nPaulista | 1h | 16:00 | 12:00\nPaulista Praia | 1h30 | 16:00 | 12:00\nIgarassu | 1h30 | 16:00 | 12:00',
  },
];

const DEFAULT_SECTORS = ['Administrativo', 'Compras', 'Estoque e logística', 'Financeiro', 'Marketing', 'RH', 'TI', 'Vendas'];
const DEFAULT_CATEGORIES = ['RH', 'TI', 'Treinamentos', 'Campanhas internas', 'Manutenção programada', 'Comunicados gerais'];
const DEFAULT_LINES = [
  ['Motor', 'Juntas, correias, bombas, pistões e componentes de motor.', 'motor'],
  ['Freios', 'Pastilhas, discos, lonas, tambores e cilindros.', 'freio'],
  ['Suspensão e direção', 'Amortecedores, molas, pivôs, terminais e buchas.', 'suspensao'],
  ['Elétrica e ignição', 'Velas, cabos, bobinas, sensores e baterias.', 'eletrica'],
  ['Filtros e lubrificantes', 'Filtros de óleo, ar, combustível e cabine; óleos e fluidos.', 'filtro'],
  ['Embreagem e transmissão', 'Kits de embreagem, rolamentos, juntas homocinéticas.', 'transmissao'],
  ['Arrefecimento', 'Radiadores, bombas d’água, válvulas termostáticas e mangueiras.', 'arrefecimento'],
  ['Iluminação e acessórios', 'Lâmpadas, faróis, lanternas e acessórios.', 'iluminacao'],
];

function openDb(file) {
  const dbPath = file || process.env.DB_PATH || path.join(__dirname, '..', 'data', 'quality.db');
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  migrate(db);
  seedDefaults(db);
  return db;
}

function migrate(db) {
  const cols = new Set(db.prepare('PRAGMA table_info(branches)').all().map((c) => c.name));
  for (const [col, type] of Object.entries(BRANCH_EXTRA_COLUMNS)) {
    if (!cols.has(col)) db.exec(`ALTER TABLE branches ADD COLUMN ${col} ${type}`);
  }
}

/** "a | b | c" por linha -> [[a,b,c], ...] */
function parseLines(text, cols) {
  return String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const parts = l.split('|').map((p) => p.trim());
      while (parts.length < cols) parts.push('');
      return parts.slice(0, cols);
    });
}

function seedDefaults(db) {
  const insSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insSetting.run(k, v);

  if (db.prepare('SELECT COUNT(*) c FROM sectors').get().c === 0) {
    const ins = db.prepare('INSERT INTO sectors (name) VALUES (?)');
    DEFAULT_SECTORS.forEach((s) => ins.run(s));
  }
  if (db.prepare('SELECT COUNT(*) c FROM categories').get().c === 0) {
    const ins = db.prepare('INSERT INTO categories (name) VALUES (?)');
    DEFAULT_CATEGORIES.forEach((s) => ins.run(s));
  }
  if (db.prepare('SELECT COUNT(*) c FROM product_lines').get().c === 0) {
    const ins = db.prepare('INSERT INTO product_lines (name, description, icon, sort_order) VALUES (?, ?, ?, ?)');
    DEFAULT_LINES.forEach(([n, d, i], idx) => ins.run(n, d, i, idx));
  }
  if (db.prepare('SELECT COUNT(*) c FROM branches').get().c === 0) {
    // Lojas com os dados oficiais (o que não foi informado fica "Pendente de cadastro").
    const ins = db.prepare(
      `INSERT INTO branches (name, city, address, phone, whatsapp, hours, lat, lng, map_embed, delivery_start, delivery_regions, sort_order, created_at)
       VALUES (@name, @city, @address, @phone, @whatsapp, @hours, @lat, @lng, @map_embed, @delivery_start, @delivery_regions, @sort_order, @now)`
    );
    SEED_BRANCHES.forEach((b, i) => ins.run({ ...b, sort_order: i, now: nowIso() }));
  }
}

function getSettings(db) {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const s = { ...DEFAULT_SETTINGS };
  for (const r of rows) s[r.key] = r.value ?? '';
  return s;
}

function setSetting(db, key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    key,
    value ?? ''
  );
}

module.exports = { openDb, getSettings, setSetting, parseLines, DEFAULT_SETTINGS };
