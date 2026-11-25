#!/usr/bin/env node
// Cria (ou promove) o primeiro Administrador de TI.
// Uso: npm run criar-admin -- --nome "Fulano" --email ti@empresa.com.br [--senha "Senha123"]
const readline = require('readline');
const { openDb } = require('../src/db');
const auth = require('../src/lib/auth');
const { audit } = require('../src/lib/audit');
const { nowIso } = require('../src/lib/dates');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

function ask(q, hidden = false) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  if (hidden) rl._writeToOutput = (s) => rl.output.write(s.includes(q) ? s : '*');
  return new Promise((r) => rl.question(q, (a) => (rl.close(), hidden && process.stdout.write('\n'), r(a.trim()))));
}

(async () => {
  const db = openDb();
  const name = arg('nome') || (await ask('Nome do administrador: '));
  const email = (arg('email') || (await ask('E-mail: '))).toLowerCase();
  const password = arg('senha') || (await ask('Senha (mín. 8 caracteres, letras e números): ', true));
  const problem = auth.passwordProblem(password);
  if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    console.error('Nome e e-mail válidos são obrigatórios.');
    process.exit(1);
  }
  if (problem) {
    console.error(problem);
    process.exit(1);
  }
  const branch = db.prepare('SELECT id FROM branches ORDER BY id LIMIT 1').get();
  const sector = db.prepare("SELECT id FROM sectors WHERE name = 'TI'").get() || db.prepare('SELECT id FROM sectors LIMIT 1').get();
  const existing = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  let id;
  if (existing) {
    db.prepare("UPDATE users SET name = ?, role = 'ti', status = 'ativo', password_hash = ?, deactivated_at = NULL WHERE id = ?").run(name, auth.hashPassword(password), existing.id);
    id = existing.id;
    console.log(`Conta existente promovida a Administrador de TI: ${email}`);
  } else {
    id = db
      .prepare("INSERT INTO users (name, email, password_hash, role, branch_id, sector_id, status, created_at) VALUES (?, ?, ?, 'ti', ?, ?, 'ativo', ?)")
      .run(name, email, auth.hashPassword(password), branch.id, sector.id, nowIso()).lastInsertRowid;
    console.log(`Administrador de TI criado: ${email}`);
  }
  audit(db, null, 'usuario.criado', 'usuario', id, { origem: 'linha de comando', perfil: 'ti' });
  console.log('Acesse /entrar e entre com esse e-mail e senha.');
})();
