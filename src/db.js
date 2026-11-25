const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { nowIso } = require('./lib/dates');

const DEFAULT_SETTINGS = {
  company_name: 'Quality Import Peças',
  slogan: 'Autopeças com qualidade e atendimento de quem entende do assunto.',
  about_text:
    'A Quality Import Peças atua no segmento de autopeças oferecendo componentes de qualidade para manutenção ' +
    'preventiva e corretiva de veículos. Nossa equipe ajuda você a encontrar a peça certa, com orientação ' +
    'técnica e atendimento próximo em nossas lojas.',
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
  seedDefaults(db);
  return db;
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
    // Matriz com os dados oficiais informados. O mapa é gerado a partir do endereço.
    db.prepare('INSERT INTO branches (name, city, address, phone, whatsapp, hours, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      'Matriz',
      'Recife - PE',
      'Av. Norte Miguel Arraes de Alencar, 1048 - Santo Amaro, Recife - PE',
      '(81) 2119-0161',
      '(81) 2119-0161',
      'Segunda a sexta: 07:00 às 17:00\nSábado: 07:00 às 13:00',
      nowIso()
    );
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

module.exports = { openDb, getSettings, setSetting, DEFAULT_SETTINGS };
