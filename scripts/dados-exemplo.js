#!/usr/bin/env node
// Popula um banco de DEMONSTRAÇÃO com filiais, usuários e conteúdos fictícios.
// NÃO use em produção. Uso: DB_PATH=data/demo.db npm run dados-exemplo
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { openDb } = require('../src/db');
const auth = require('../src/lib/auth');
const { nowIso, todayLocal } = require('../src/lib/dates');
const { saveAudience } = require('../src/lib/content');
const { UPLOAD_DIR } = require('../src/lib/uploads');

const db = openDb();
if (db.prepare('SELECT COUNT(*) c FROM users').get().c > 0 && !process.argv.includes('--forcar')) {
  console.error('O banco já tem usuários. Use um banco vazio (DB_PATH=data/demo.db) ou --forcar.');
  process.exit(1);
}

// ---- gera fotos PNG simples (degradê) sem dependências
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(w, h, [r1, g1, b1], [r2, g2, b2]) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const t = (x / w + y / h) / 2;
      const o = y * (w * 3 + 1) + 1 + x * 3;
      const stripe = (x + y) % 80 < 6 ? 18 : 0;
      raw[o] = Math.min(255, r1 + (r2 - r1) * t + stripe);
      raw[o + 1] = Math.min(255, g1 + (g2 - g1) * t + stripe);
      raw[o + 2] = Math.min(255, b1 + (b2 - b1) * t + stripe);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
function storeImage(name, buf, ownerType, ownerId, userId) {
  const storage = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(UPLOAD_DIR, storage), buf);
  const id = crypto.randomBytes(12).toString('hex');
  db.prepare('INSERT INTO files (id, original_name, mime, size, storage_name, owner_type, owner_id, uploaded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    id, name, 'image/png', buf.length, storage, ownerType, ownerId, userId, nowIso()
  );
  return id;
}
const addDays = (ymd, n) => {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
const isoMinus = (h) => new Date(Date.now() - h * 3600000).toISOString();

const now = nowIso();
const today = todayLocal();

// ---- filiais fictícias
const matriz = db.prepare('SELECT id FROM branches ORDER BY id LIMIT 1').get().id;
db.prepare('UPDATE branches SET name = ?, city = ? WHERE id = ?').run('Matriz (exemplo)', 'Cidade Exemplo', matriz);
const insB = db.prepare('INSERT INTO branches (name, city, address, phone, whatsapp, hours, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
const centro = insB.run('Loja Centro (exemplo)', 'Cidade Exemplo', 'Av. Exemplo, 1000 - Centro', '(00) 0000-0000', '(00) 90000-0000', 'Seg. a sex.: 08:00 às 18:00\nSábado: 08:00 às 12:00', 1, now).lastInsertRowid;
const norte = insB.run('Loja Zona Norte (exemplo)', 'Outra Cidade', '', '', '', '', 2, now).lastInsertRowid;
const sector = (n) => db.prepare('SELECT id FROM sectors WHERE name = ?').get(n).id;

// ---- usuários (senha de todos: Exemplo123)
const hash = auth.hashPassword('Exemplo123');
const insU = db.prepare("INSERT INTO users (name, email, password_hash, role, branch_id, sector_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'ativo', ?)");
const ti = insU.run('Tiago (TI)', 'ti@exemplo.com', hash, 'ti', matriz, sector('TI'), now).lastInsertRowid;
const mkt = insU.run('Marina (Marketing)', 'marketing@exemplo.com', hash, 'marketing', matriz, sector('Marketing'), now).lastInsertRowid;
insU.run('Carla Souza', 'colaborador@exemplo.com', hash, 'colaborador', centro, sector('Vendas'), now);
insU.run('Pedro Lima', 'norte@exemplo.com', hash, 'colaborador', norte, sector('Estoque e logística'), now);
db.prepare("INSERT INTO users (name, email, role, branch_id, sector_id, status, created_at) VALUES ('Rafael Alves', 'convidado@exemplo.com', 'colaborador', ?, ?, 'convidado', ?)").run(centro, sector('Vendas'), now);

// ---- informativos
const cat = (n) => db.prepare('SELECT id FROM categories WHERE name = ?').get(n).id;
const insP = db.prepare(`INSERT INTO posts (title, summary, body_html, category_id, priority, requires_ack, status, starts_at, published_at, created_by, updated_by, created_at, updated_at)
  VALUES (@title, @summary, @body, @cat, @priority, @ack, 'publicado', @starts, @starts, @uid, @uid, @starts, @starts)`);
function post(p, aud) {
  const id = insP.run({ priority: 0, ack: 0, uid: mkt, ...p }).lastInsertRowid;
  saveAudience(db, 'post', id, aud || { all: true, branchIds: [], sectorIds: [] });
  return id;
}
post(
  { title: 'Inventário geral na Loja Centro neste sábado', summary: 'O atendimento ao público será encerrado às 11:00. Confirme a leitura.', body: '<p>Prezados,</p><p>Neste sábado faremos o <strong>inventário geral</strong> da Loja Centro. O atendimento será encerrado às <strong>11:00</strong>.</p><ul><li>Chegada da equipe: 07:30</li><li>Início da contagem: 11:15</li></ul>', cat: cat('Comunicados gerais'), priority: 1, ack: 1, starts: isoMinus(2) },
  { all: false, branchIds: [centro], sectorIds: [] }
);
post({ title: 'Manutenção programada do sistema de vendas', summary: 'O sistema ficará indisponível na madrugada de domingo, das 00:00 às 04:00.', body: '<p>A equipe de TI fará a atualização do servidor. Planeje os pedidos com antecedência.</p>', cat: cat('Manutenção programada'), priority: 1, ack: 1, starts: isoMinus(5) });
post({ title: 'Campanha interna: indique um cliente', summary: 'Quem indicar novos clientes frotistas concorre a prêmios até o fim do mês.', body: '<p>Participe da campanha e ajude a loja a crescer!</p>', cat: cat('Campanhas internas'), starts: isoMinus(26) });
post({ title: 'Novo calendário de férias', summary: 'O RH publicou o calendário de férias do próximo semestre.', body: '<p>Consulte o seu gestor para ajustar as datas.</p>', cat: cat('RH'), starts: isoMinus(50) });
post({ title: 'Treinamento: linha de suspensão', summary: 'Inscrições abertas para o treinamento técnico de suspensão e direção.', body: '<p>Vagas limitadas.</p>', cat: cat('Treinamentos'), starts: isoMinus(80) }, { all: false, branchIds: [], sectorIds: [sector('Vendas')] });
post({ title: 'Troca de senha do Wi-Fi das lojas', summary: 'A nova senha está disponível com o gerente da sua loja.', body: '<p>Por segurança, não compartilhe a senha com clientes.</p>', cat: cat('TI'), starts: isoMinus(120) });

// ---- eventos
const insE = db.prepare(`INSERT INTO events (title, description, event_date, start_time, end_time, location, status, starts_at, published_at, cancelled, cancel_reason, created_by, updated_by, created_at, updated_at)
  VALUES (@title, @description, @date, @t1, @t2, @loc, 'publicado', @starts, @starts, @cancelled, @reason, @uid, @uid, @starts, @starts)`);
function event(e, aud) {
  const id = insE.run({ cancelled: 0, reason: null, uid: mkt, starts: isoMinus(24), t2: null, ...e }).lastInsertRowid;
  saveAudience(db, 'event', id, aud || { all: true, branchIds: [], sectorIds: [] });
  return id;
}
const tr = event({ title: 'Treinamento de freios', description: 'Novidades em pastilhas e discos.', date: addDays(today, 6), t1: '14:00', t2: '17:30', loc: 'Sala de treinamento — Matriz' }, { all: false, branchIds: [centro, matriz], sectorIds: [] });
db.prepare('INSERT INTO event_changes (event_id, description, changed_by, created_at) VALUES (?, ?, ?, ?)').run(tr, `Data alterada de ${addDays(today, 4).split('-').reverse().join('/')} para ${addDays(today, 6).split('-').reverse().join('/')}`, mkt, isoMinus(3));
event({ title: 'Reunião geral de resultados', description: 'Apresentação dos resultados do mês.', date: addDays(today, 2), t1: '08:30', t2: '09:30', loc: 'Online' });
event({ title: 'Integração de novos colaboradores', description: '', date: addDays(today, 9), t1: '09:00', t2: '12:00', loc: 'Matriz' });
event({ title: 'Ação de rua — Dia do Mecânico', description: '', date: addDays(today, 14), t1: null, loc: 'Loja Centro' }, { all: false, branchIds: [centro], sectorIds: [] });
event({ title: 'Palestra de segurança no trabalho', description: '', date: addDays(today, 4), t1: '15:00', t2: '16:00', loc: 'Auditório', cancelled: 1, reason: 'Palestrante remarcou' });

// ---- álbum
const album = db.prepare(`INSERT INTO albums (title, description, album_date, status, starts_at, published_at, created_by, updated_by, created_at, updated_at)
  VALUES (?, ?, ?, 'publicado', ?, ?, ?, ?, ?, ?)`).run('Confraternização de fim de ano', 'Fotos ilustrativas de demonstração.', addDays(today, -3), isoMinus(20), isoMinus(20), mkt, mkt, isoMinus(20), isoMinus(20)).lastInsertRowid;
saveAudience(db, 'album', album, { all: true, branchIds: [], sectorIds: [] });
const palette = [[[13, 59, 122], [91, 155, 240]], [[10, 42, 87], [201, 207, 216]], [[18, 80, 163], [238, 244, 252]], [[61, 71, 86], [26, 98, 196]], [[7, 29, 61], [122, 132, 148]], [[26, 98, 196], [220, 232, 248]]];
let cover = null;
palette.forEach(([a, b], i) => {
  const fid = storeImage(`foto-${i + 1}.png`, png(640, 480, a, b), 'photo', album, mkt);
  const pid = db.prepare('INSERT INTO photos (album_id, file_id, caption, position, created_at) VALUES (?, ?, ?, ?, ?)').run(album, fid, i === 0 ? 'Equipe reunida' : `Foto ${i + 1}`, i + 1, now).lastInsertRowid;
  if (!cover) cover = pid;
});
db.prepare('UPDATE albums SET cover_photo_id = ? WHERE id = ?').run(cover, album);

console.log('Dados de exemplo criados. Senha de todos: Exemplo123');
console.log('  TI:           ti@exemplo.com');
console.log('  Marketing:    marketing@exemplo.com');
console.log('  Colaborador:  colaborador@exemplo.com (Loja Centro)');
console.log('  Colaborador:  norte@exemplo.com (Loja Zona Norte)');
void ti;
