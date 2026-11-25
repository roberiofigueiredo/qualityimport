// Cenários de aceite (item 8 do pedido). Rodar com: npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qi-test-'));
process.env.UPLOAD_DIR = path.join(TMP, 'uploads');
process.env.DB_PATH = path.join(TMP, 'test.db');

const request = require('supertest');
const { createApp } = require('../src/app');
const { openDb } = require('../src/db');
const auth = require('../src/lib/auth');
const { todayLocal } = require('../src/lib/dates');

// PNG 1x1 válido
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');

let db;
let app;
const ids = {};

function csrfFrom(html) {
  const m = /name="_csrf" value="([^"]+)"/.exec(html);
  assert.ok(m, 'token CSRF não encontrado na página');
  return m[1];
}

async function login(email, senha) {
  const agent = request.agent(app);
  const r = await agent.post('/entrar').type('form').send({ email, senha });
  assert.equal(r.status, 302, `login de ${email} deveria redirecionar (status ${r.status})`);
  const home = await agent.get('/intranet');
  assert.equal(home.status, 200);
  agent.csrf = csrfFrom(home.text);
  return agent;
}

function addDays(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function lastLink(to) {
  const mail = db.prepare('SELECT body FROM email_outbox WHERE to_email = ? ORDER BY id DESC LIMIT 1').get(to);
  assert.ok(mail, `nenhum e-mail para ${to}`);
  const m = /(\/definir-senha\/[\w-]+)/.exec(mail.body);
  assert.ok(m, 'link não encontrado no e-mail');
  return m[1];
}

let ti; // sessão do administrador de TI

before(async () => {
  db = openDb(process.env.DB_PATH);
  app = createApp({ db });
  // Primeiro administrador (equivalente a `npm run criar-admin`)
  const matriz = db.prepare('SELECT id FROM branches ORDER BY id LIMIT 1').get().id;
  const setorTi = db.prepare("SELECT id FROM sectors WHERE name = 'TI'").get().id;
  db.prepare("INSERT INTO users (name, email, password_hash, role, branch_id, sector_id, status, created_at) VALUES (?, ?, ?, 'ti', ?, ?, 'ativo', ?)").run(
    'Admin TI',
    'ti@qualityimport.test',
    auth.hashPassword('SenhaTi123'),
    matriz,
    setorTi,
    new Date().toISOString()
  );
  ti = await login('ti@qualityimport.test', 'SenhaTi123');
  ids.matriz = matriz;
  ids.vendas = db.prepare("SELECT id FROM sectors WHERE name = 'Vendas'").get().id;
  ids.marketingSetor = db.prepare("SELECT id FROM sectors WHERE name = 'Marketing'").get().id;

  // A TI cadastra duas filiais (dados de exemplo)
  for (const [nome, cidade, whatsapp] of [
    ['Loja Centro', 'Fortaleza', '(85) 99999-1111'],
    ['Loja Aldeota', 'Fortaleza', ''],
  ]) {
    const r = await ti.post('/admin/filiais').type('form').send({
      _csrf: ti.csrf,
      nome,
      cidade,
      endereco: nome === 'Loja Centro' ? 'Rua das Peças, 100 - Centro' : '',
      telefone: nome === 'Loja Centro' ? '(85) 3333-1111' : '',
      whatsapp,
      horario: 'Seg. a sex.: 08:00 às 18:00',
      mapa: '',
      exibir_no_site: '1',
      ativa: '1',
      ordem: '1',
    });
    assert.equal(r.status, 302);
  }
  ids.centro = db.prepare("SELECT id FROM branches WHERE name = 'Loja Centro'").get().id;
  ids.aldeota = db.prepare("SELECT id FROM branches WHERE name = 'Loja Aldeota'").get().id;
});

after(() => {
  db.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------
test('Cenário 1: visitante encontra a filial desejada e abre o canal de orçamento', async () => {
  const home = await request(app).get('/');
  assert.equal(home.status, 200);
  assert.match(home.text, /Solicitar orçamento pelo WhatsApp/);
  assert.match(home.text, /Encontrar uma loja/);
  assert.match(home.text, /Área do Colaborador/);
  assert.match(home.text, /href="\/entrar"/);
  assert.match(home.text, /Principais linhas de autopeças/);
  // dado oficial não informado aparece como pendente
  assert.match(home.text, /Pendente de cadastro/);

  // busca pela loja
  const busca = await request(app).get('/').query({ busca: 'centro' });
  assert.match(busca.text, /Loja Centro/);
  assert.match(busca.text, /Rua das Peças, 100 - Centro/);
  assert.match(busca.text, /\(85\) 3333-1111/);
  assert.match(busca.text, /Seg\. a sex\.: 08:00 às 18:00/);
  assert.match(busca.text, /google\.com\/maps\/search/); // link para o mapa
  assert.doesNotMatch(busca.text, /id="loja-\d+"[^>]*>\s*<h3>Loja Aldeota/);

  // abre o canal de orçamento daquela loja
  const orc = await request(app).get('/orcamento').query({ filial: ids.centro });
  assert.equal(orc.status, 302);
  assert.match(orc.headers.location, /^https:\/\/wa\.me\/5585999991111\?text=/);
  assert.match(decodeURIComponent(orc.headers.location), /Loja: Loja Centro/);

  // loja sem WhatsApp próprio usa o WhatsApp comercial geral (dado oficial)
  const geral = await request(app).get('/orcamento').query({ filial: ids.aldeota });
  assert.equal(geral.status, 302);
  assert.match(geral.headers.location, /^https:\/\/wa\.me\/558121190161\?text=/);
  assert.match(home.text, /contato@qualityimport\.net\.br/);

  // sem nenhum número cadastrado: canal pendente de cadastro, com alternativas
  db.prepare("UPDATE settings SET value = '' WHERE key = 'whatsapp_number'").run();
  const pend = await request(app).get('/orcamento').query({ filial: ids.aldeota });
  assert.equal(pend.status, 200);
  assert.match(pend.text, /Pendente de cadastro/);
  assert.match(pend.text, /Loja Centro/);
  db.prepare("UPDATE settings SET value = '(81) 2119-0161' WHERE key = 'whatsapp_number'").run();
});

// ---------------------------------------------------------------------------------------------
test('Cenário 2: a TI cadastra um colaborador, atribui seu perfil e libera o acesso', async () => {
  const novo = await ti.post('/admin/usuarios').type('form').send({
    _csrf: ti.csrf,
    nome: 'Ana Centro',
    email: 'ana@qualityimport.test',
    filial: ids.centro,
    setor: ids.vendas,
    perfil: 'colaborador',
    convite: '1',
  });
  assert.equal(novo.status, 302);
  const ana = db.prepare('SELECT * FROM users WHERE email = ?').get('ana@qualityimport.test');
  assert.equal(ana.role, 'colaborador');
  assert.equal(ana.status, 'convidado');
  assert.equal(ana.branch_id, ids.centro);
  assert.equal(ana.sector_id, ids.vendas);

  // antes de aceitar o convite não entra
  const antes = await request(app).post('/entrar').type('form').send({ email: 'ana@qualityimport.test', senha: 'qualquer1' });
  assert.equal(antes.status, 401);

  // convite por e-mail → define a senha → acesso liberado
  const link = lastLink('ana@qualityimport.test');
  const pagina = await request(app).get(link);
  assert.equal(pagina.status, 200);
  assert.match(pagina.text, /Ative seu acesso/);
  const def = await request(app).post(link).type('form').send({ senha: 'AnaSenha123', confirmacao: 'AnaSenha123' });
  assert.equal(def.status, 302);
  assert.equal(db.prepare('SELECT status FROM users WHERE id = ?').get(ana.id).status, 'ativo');
  // link é de uso único
  assert.equal((await request(app).get(link)).status, 410);

  const sessao = await login('ana@qualityimport.test', 'AnaSenha123');
  const home = await sessao.get('/intranet');
  assert.match(home.text, /Olá, Ana!/);
  assert.doesNotMatch(home.text, /Painel do Marketing/);
  assert.doesNotMatch(home.text, /Administração/);
  // colaborador não acessa painel nem administração (checagem no servidor)
  assert.equal((await sessao.get('/painel/informativos')).status, 403);
  assert.equal((await sessao.get('/admin/usuarios')).status, 403);
  assert.equal((await sessao.post('/admin/usuarios').type('form').send({ _csrf: sessao.csrf, nome: 'x', email: 'x@x.com', perfil: 'ti' })).status, 403);

  // Conta de Marketing sem acesso à gestão de usuários
  await ti.post('/admin/usuarios').type('form').send({
    _csrf: ti.csrf,
    nome: 'Marina Marketing',
    email: 'marketing@qualityimport.test',
    filial: ids.matriz,
    setor: ids.marketingSetor,
    perfil: 'marketing',
    convite: '1',
  });
  await request(app).post(lastLink('marketing@qualityimport.test')).type('form').send({ senha: 'Market1234', confirmacao: 'Market1234' });
  const mkt = await login('marketing@qualityimport.test', 'Market1234');
  assert.equal((await mkt.get('/painel')).status, 200);
  assert.equal((await mkt.get('/admin/usuarios')).status, 403);

  // Colaborador da outra filial (para os próximos cenários)
  await ti.post('/admin/usuarios').type('form').send({
    _csrf: ti.csrf,
    nome: 'Bruno Aldeota',
    email: 'bruno@qualityimport.test',
    filial: ids.aldeota,
    setor: ids.vendas,
    perfil: 'colaborador',
    convite: '1',
  });
  await request(app).post(lastLink('bruno@qualityimport.test')).type('form').send({ senha: 'Bruno12345', confirmacao: 'Bruno12345' });

  // mudança de permissão registrada no histórico
  const marina = db.prepare('SELECT id FROM users WHERE email = ?').get('marketing@qualityimport.test');
  const log = db.prepare("SELECT * FROM audit_log WHERE action = 'usuario.criado' AND entity_id = ?").get(String(marina.id));
  assert.ok(log.user_id && log.created_at, 'histórico deve registrar autor, data e hora');
});

// ---------------------------------------------------------------------------------------------
test('Cenário 3: aviso para uma única filial — quem é da filial lê e confirma; outras filiais não acessam nem pelo link', async () => {
  const mkt = await login('marketing@qualityimport.test', 'Market1234');
  const r = await mkt
    .post('/painel/informativos')
    .field('_csrf', mkt.csrf)
    .field('titulo', 'Inventário da Loja Centro')
    .field('resumo', 'Inventário no sábado. Leia e confirme.')
    .field('corpo', '<p>O inventário acontece no <strong>sábado</strong>.</p><script>alert(1)</script>')
    .field('categoria', String(db.prepare("SELECT id FROM categories WHERE name = 'Comunicados gerais'").get().id))
    .field('destaque', '1')
    .field('confirmacao', '1')
    .field('publico', 'selecionado')
    .field('filiais', String(ids.centro))
    .field('acao', 'publicar')
    .attach('capa', PNG, { filename: 'capa.png', contentType: 'image/png' })
    .attach('anexos', PDF, { filename: 'escala-inventário.pdf', contentType: 'application/pdf' });
  assert.equal(r.status, 302, r.text);
  const post = db.prepare("SELECT * FROM posts WHERE title = 'Inventário da Loja Centro'").get();
  assert.equal(post.status, 'publicado');
  assert.doesNotMatch(post.body_html, /script/); // texto formatado é higienizado
  const anexo = db.prepare("SELECT * FROM files WHERE owner_type = 'post_attachment' AND owner_id = ?").get(post.id);
  assert.equal(anexo.original_name, 'escala-inventário.pdf');

  // Colaboradora da Loja Centro
  const ana = await login('ana@qualityimport.test', 'AnaSenha123');
  const home = await ana.get('/intranet');
  assert.match(home.text, /Avisos prioritários/);
  assert.match(home.text, /Inventário da Loja Centro/);
  assert.match(home.text, /comunicado\(s\) com leitura a confirmar/);
  const pagina = await ana.get(`/intranet/informativos/${post.id}`);
  assert.equal(pagina.status, 200);
  assert.match(pagina.text, /Confirmo que li/);
  assert.equal((await ana.get(`/arquivos/${anexo.id}`)).status, 200);
  assert.equal((await ana.get(`/arquivos/${post.cover_file_id}`)).status, 200);
  const conf = await ana.post(`/intranet/informativos/${post.id}/confirmar`).type('form').send({ _csrf: ana.csrf });
  assert.equal(conf.status, 302);
  const lida = await ana.get(`/intranet/informativos/${post.id}`);
  assert.match(lida.text, /Você confirmou a leitura em \d{2}\/\d{2}\/\d{4} \d{2}:\d{2}/);
  const anaId = db.prepare('SELECT id FROM users WHERE email = ?').get('ana@qualityimport.test').id;
  assert.ok(db.prepare('SELECT confirmed_at FROM post_reads WHERE post_id = ? AND user_id = ?').get(post.id, anaId).confirmed_at);
  assert.doesNotMatch((await ana.get('/intranet')).text, /leitura a confirmar/);

  // Colaborador de outra filial: não vê, nem com link direto, nem os arquivos
  const bruno = await login('bruno@qualityimport.test', 'Bruno12345');
  assert.doesNotMatch((await bruno.get('/intranet')).text, /Inventário da Loja Centro/);
  assert.doesNotMatch((await bruno.get('/intranet/informativos').query({ q: 'Inventário' })).text, /Inventário da Loja Centro/);
  assert.equal((await bruno.get(`/intranet/informativos/${post.id}`)).status, 404);
  assert.equal((await bruno.get(`/arquivos/${anexo.id}`)).status, 404);
  assert.equal((await bruno.get(`/arquivos/${post.cover_file_id}`)).status, 404);
  assert.equal((await bruno.post(`/intranet/informativos/${post.id}/confirmar`).type('form').send({ _csrf: bruno.csrf })).status, 404);
  // Visitante sem login também não
  assert.equal((await request(app).get(`/intranet/informativos/${post.id}`)).status, 302);
  assert.equal((await request(app).get(`/arquivos/${anexo.id}`)).status, 302);

  // Relatório de leituras para o Marketing
  const leituras = await mkt.get(`/painel/informativos/${post.id}/leituras`);
  assert.match(leituras.text, /1 de 1 colaborador\(es\) confirmaram/);
});

// ---------------------------------------------------------------------------------------------
test('Cenário 4: Marketing cria álbum e altera a data de um treinamento; o público selecionado vê as duas atualizações', async () => {
  const mkt = await login('marketing@qualityimport.test', 'Market1234');

  // Álbum com várias fotos de uma vez, para a Loja Centro
  const alb = await mkt
    .post('/painel/galeria')
    .field('_csrf', mkt.csrf)
    .field('titulo', 'Confraternização Loja Centro')
    .field('descricao', 'Fotos da confraternização.')
    .field('data', todayLocal())
    .field('publico', 'selecionado')
    .field('filiais', String(ids.centro))
    .field('acao', 'publicar')
    .attach('fotos', PNG, { filename: 'f1.png', contentType: 'image/png' })
    .attach('fotos', PNG, { filename: 'f2.png', contentType: 'image/png' })
    .attach('fotos', PNG, { filename: 'f3.png', contentType: 'image/png' });
  assert.equal(alb.status, 302, alb.text);
  const album = db.prepare("SELECT * FROM albums WHERE title = 'Confraternização Loja Centro'").get();
  const fotos = db.prepare('SELECT * FROM photos WHERE album_id = ? ORDER BY position').all(album.id);
  assert.equal(fotos.length, 3);
  assert.equal(album.cover_photo_id, fotos[0].id);

  // capa, legenda e reordenação
  const org = await mkt
    .post(`/painel/galeria/${album.id}/fotos/organizar`)
    .type('form')
    .send({ _csrf: mkt.csrf, capa: fotos[2].id, [`legenda_${fotos[2].id}`]: 'Equipe reunida', [`ordem_${fotos[2].id}`]: '0', [`ordem_${fotos[0].id}`]: '1', [`ordem_${fotos[1].id}`]: '2' });
  assert.equal(org.status, 302);
  const depois = db.prepare('SELECT id, caption FROM photos WHERE album_id = ? ORDER BY position').all(album.id);
  assert.equal(depois[0].id, fotos[2].id);
  assert.equal(depois[0].caption, 'Equipe reunida');
  assert.equal(db.prepare('SELECT cover_photo_id FROM albums WHERE id = ?').get(album.id).cover_photo_id, fotos[2].id);

  // Treinamento publicado para a Loja Centro
  const data1 = addDays(todayLocal(), 10);
  const data2 = addDays(todayLocal(), 12);
  const ev = await mkt.post('/painel/calendario').type('form').send({
    _csrf: mkt.csrf,
    titulo: 'Treinamento de freios',
    descricao: 'Novidades da linha de freios.',
    data: data1,
    hora_inicio: '14:00',
    hora_fim: '17:30',
    local: 'Sala de treinamento',
    publico: 'selecionado',
    filiais: String(ids.centro),
    acao: 'publicar',
  });
  assert.equal(ev.status, 302);
  const evento = db.prepare("SELECT * FROM events WHERE title = 'Treinamento de freios'").get();

  // Marketing altera a data do treinamento
  const alt = await mkt.post(`/painel/calendario/${evento.id}`).type('form').send({
    _csrf: mkt.csrf,
    titulo: 'Treinamento de freios',
    descricao: 'Novidades da linha de freios.',
    data: data2,
    hora_inicio: '14:00',
    hora_fim: '17:30',
    local: 'Sala de treinamento',
    publico: 'selecionado',
    filiais: String(ids.centro),
    acao: 'salvar',
  });
  assert.equal(alt.status, 302);
  assert.equal(db.prepare('SELECT event_date FROM events WHERE id = ?').get(evento.id).event_date, data2);
  const fmt = (ymd) => ymd.split('-').reverse().join('/');

  // Colaboradora da Loja Centro vê o álbum e a nova data, com o aviso da mudança
  const ana = await login('ana@qualityimport.test', 'AnaSenha123');
  const home = await ana.get('/intranet');
  assert.match(home.text, /Confraternização Loja Centro/);
  assert.match(home.text, /Treinamento de freios/);
  assert.match(home.text, /Mudanças na agenda/);
  assert.ok(home.text.includes(`Data alterada de ${fmt(data1)} para ${fmt(data2)}`));
  assert.equal((await ana.get(`/intranet/galeria/${album.id}`)).status, 200);
  assert.match((await ana.get(`/intranet/galeria/${album.id}`)).text, /Equipe reunida/);
  assert.equal((await ana.get(`/arquivos/${fotos[0].file_id}`)).status, 200);
  const cal = await ana.get('/intranet/calendario').query({ visao: 'mes', mes: data2.slice(0, 7) });
  assert.match(cal.text, /Treinamento de freios/);
  const lista = await ana.get('/intranet/calendario').query({ visao: 'lista' });
  assert.ok(lista.text.includes(fmt(data2)));
  assert.match(lista.text, /14:00 às 17:30/);
  const det = await ana.get(`/intranet/calendario/${evento.id}`);
  assert.ok(det.text.includes(`Data alterada de ${fmt(data1)} para ${fmt(data2)}`));

  // Outra filial não vê nada disso
  const bruno = await login('bruno@qualityimport.test', 'Bruno12345');
  const homeB = await bruno.get('/intranet');
  assert.doesNotMatch(homeB.text, /Confraternização Loja Centro/);
  assert.doesNotMatch(homeB.text, /Treinamento de freios/);
  assert.equal((await bruno.get(`/intranet/galeria/${album.id}`)).status, 404);
  assert.equal((await bruno.get(`/arquivos/${fotos[0].file_id}`)).status, 404);
  assert.equal((await bruno.get(`/intranet/calendario/${evento.id}`)).status, 404);

  // Cancelamento fica identificado na agenda
  await mkt.post(`/painel/calendario/${evento.id}/cancelar`).type('form').send({ _csrf: mkt.csrf, confirmar: 'sim', motivo: 'Instrutor indisponível' });
  const canc = await ana.get(`/intranet/calendario/${evento.id}`);
  assert.match(canc.text, /Evento cancelado/);
  assert.match(canc.text, /Instrutor indisponível/);
});

// ---------------------------------------------------------------------------------------------
test('Cenário 5: a TI desativa uma conta e o usuário perde o acesso, inclusive na sessão já aberta', async () => {
  const ana = await login('ana@qualityimport.test', 'AnaSenha123');
  assert.equal((await ana.get('/intranet')).status, 200);
  const anaId = db.prepare('SELECT id FROM users WHERE email = ?').get('ana@qualityimport.test').id;

  // tela de confirmação antes de desativar
  const conf = await ti.get(`/admin/usuarios/${anaId}/desativar`);
  assert.match(conf.text, /Desativar a conta de Ana Centro\?/);
  const r = await ti.post(`/admin/usuarios/${anaId}/desativar`).type('form').send({ _csrf: ti.csrf, confirmar: 'sim' });
  assert.equal(r.status, 302);
  assert.equal(db.prepare('SELECT status FROM users WHERE id = ?').get(anaId).status, 'desativado');

  // a sessão que estava aberta deixa de funcionar
  const depois = await ana.get('/intranet');
  assert.equal(depois.status, 302);
  assert.match(depois.headers.location, /^\/entrar/);
  const post = db.prepare("SELECT id FROM posts WHERE title = 'Inventário da Loja Centro'").get();
  assert.equal((await ana.get(`/intranet/informativos/${post.id}`)).status, 302);
  // e não consegue entrar de novo nem recuperar a senha
  const relogin = await request(app).post('/entrar').type('form').send({ email: 'ana@qualityimport.test', senha: 'AnaSenha123' });
  assert.equal(relogin.status, 403);
  assert.match(relogin.text, /desativada/);
  const antes = db.prepare('SELECT COUNT(*) c FROM email_outbox').get().c;
  await request(app).post('/esqueci-senha').type('form').send({ email: 'ana@qualityimport.test' });
  assert.equal(db.prepare('SELECT COUNT(*) c FROM email_outbox').get().c, antes);

  // histórico preservado: confirmações de leitura e ações continuam registradas
  assert.ok(db.prepare('SELECT 1 FROM post_reads WHERE user_id = ?').get(anaId));
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE user_id = ? AND action = 'informativo.leitura_confirmada'").get(anaId));
  const log = db.prepare("SELECT * FROM audit_log WHERE action = 'usuario.desativado' AND entity_id = ?").get(String(anaId));
  assert.match(log.details, /sessoes_encerradas/);

  // Desativar o Marketing preserva as publicações e a autoria
  const marina = db.prepare('SELECT id FROM users WHERE email = ?').get('marketing@qualityimport.test');
  await ti.post(`/admin/usuarios/${marina.id}/desativar`).type('form').send({ _csrf: ti.csrf, confirmar: 'sim' });
  const bruno = await login('bruno@qualityimport.test', 'Bruno12345');
  assert.equal((await bruno.get('/intranet')).status, 200);
  const hist = await ti.get('/admin/historico');
  assert.match(hist.text, /Desativou conta/);
  assert.match(hist.text, /Marina Marketing/);
  assert.match(hist.text, /Publicou informativo/);
  assert.equal(db.prepare('SELECT created_by FROM posts WHERE id = ?').get(post.id).created_by, marina.id);
});

// ---------------------------------------------------------------------------------------------
test('Extras: agendamento, retirada de circulação com confirmação, recuperação de senha e CSRF', async () => {
  // reativa o Marketing para os testes extras
  const marina = db.prepare('SELECT id FROM users WHERE email = ?').get('marketing@qualityimport.test');
  await ti.post(`/admin/usuarios/${marina.id}/reativar`).type('form').send({ _csrf: ti.csrf });
  const mkt = await login('marketing@qualityimport.test', 'Market1234');
  const bruno = await login('bruno@qualityimport.test', 'Bruno12345');

  // agendado para o futuro: não aparece ainda
  const futuro = `${addDays(todayLocal(), 3)}T09:00`;
  await mkt.post('/painel/informativos').field('_csrf', mkt.csrf).field('titulo', 'Campanha de dezembro').field('publico', 'todos').field('inicio', futuro).field('acao', 'agendar');
  const ag = db.prepare("SELECT * FROM posts WHERE title = 'Campanha de dezembro'").get();
  assert.equal(ag.status, 'agendado');
  assert.equal((await bruno.get(`/intranet/informativos/${ag.id}`)).status, 404);
  assert.match((await mkt.get('/painel/informativos')).text, /Agendado/);

  // publicado para todos: aparece; retirar de circulação pede confirmação
  await mkt.post('/painel/informativos').field('_csrf', mkt.csrf).field('titulo', 'Manutenção programada do sistema').field('publico', 'todos').field('acao', 'publicar');
  const pub = db.prepare("SELECT * FROM posts WHERE title = 'Manutenção programada do sistema'").get();
  assert.equal((await bruno.get(`/intranet/informativos/${pub.id}`)).status, 200);
  const pergunta = await mkt.get(`/painel/informativos/${pub.id}/arquivar`);
  assert.match(pergunta.text, /Retirar “Manutenção programada do sistema” de circulação\?/);
  const semConfirmar = await mkt.post(`/painel/informativos/${pub.id}/arquivar`).type('form').send({ _csrf: mkt.csrf });
  assert.equal(semConfirmar.status, 302);
  assert.equal(db.prepare('SELECT status FROM posts WHERE id = ?').get(pub.id).status, 'publicado');
  await mkt.post(`/painel/informativos/${pub.id}/arquivar`).type('form').send({ _csrf: mkt.csrf, confirmar: 'sim' });
  assert.equal(db.prepare('SELECT status FROM posts WHERE id = ?').get(pub.id).status, 'arquivado');
  assert.equal((await bruno.get(`/intranet/informativos/${pub.id}`)).status, 404);

  // recuperação de senha pelo e-mail cadastrado
  const esq = await request(app).post('/esqueci-senha').type('form').send({ email: 'bruno@qualityimport.test' });
  assert.equal(esq.status, 200);
  const link = lastLink('bruno@qualityimport.test');
  await request(app).post(link).type('form').send({ senha: 'NovaSenha99', confirmacao: 'NovaSenha99' });
  await login('bruno@qualityimport.test', 'NovaSenha99');
  // a sessão antiga é encerrada com a troca de senha
  assert.equal((await bruno.get('/intranet')).status, 302);

  // formulário sem token CSRF é recusado
  const semToken = await mkt.post('/painel/calendario').type('form').send({ titulo: 'x', data: todayLocal(), acao: 'publicar' });
  assert.equal(semToken.status, 403);

  // mudança de perfil registrada
  const brunoId = db.prepare('SELECT id FROM users WHERE email = ?').get('bruno@qualityimport.test').id;
  await ti.post(`/admin/usuarios/${brunoId}`).type('form').send({ _csrf: ti.csrf, nome: 'Bruno Aldeota', email: 'bruno@qualityimport.test', filial: ids.aldeota, setor: ids.vendas, perfil: 'marketing' });
  const log = db.prepare("SELECT * FROM audit_log WHERE action = 'usuario.perfil_alterado' AND entity_id = ?").get(String(brunoId));
  assert.match(log.details, /"de":"Colaborador","para":"Marketing"/);
});
