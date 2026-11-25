# Quality Import Peças — site público e intranet

Sistema web responsivo com duas áreas integradas:

- **Site público** (`/`): apresentação da empresa, principais linhas de autopeças, busca de lojas (endereço, telefone, horário, mapa) e os botões **“Solicitar orçamento pelo WhatsApp”** e **“Encontrar uma loja”**. O botão **“Área do Colaborador”** no cabeçalho leva ao login.
- **Intranet** (`/intranet`): avisos prioritários, informativos, calendário (mês e lista), galeria de fotos, busca por palavra‑chave, filtros por categoria e data, e indicação das leituras a confirmar.
- **Painel do Marketing** (`/painel`): Informativos, Galeria de fotos e Calendário, com “Salvar rascunho”, “Pré‑visualizar”, “Agendar” e “Publicar”.
- **Administração da TI** (`/admin`): usuários, convites, perfis, filiais, setores, categorias, linhas de peças, dados do site público, histórico de alterações e e‑mails enviados.

Tudo em português do Brasil, datas DD/MM/AAAA, horários em 24 horas (fuso America/Sao_Paulo).

## Tecnologia

- Node.js 20+ com Express e páginas renderizadas no servidor (EJS) — funciona sem JavaScript no navegador; o JS só melhora a experiência (editor de texto, visualização ampliada de fotos, busca instantânea de lojas).
- Banco SQLite (arquivo único, `data/quality.db`), criado automaticamente na primeira execução.
- Arquivos enviados ficam em `data/uploads/` e **nunca são servidos diretamente**: passam pela rota `/arquivos/:id`, que confere a permissão.

## Como rodar

```bash
npm install
npm run criar-admin          # cria o primeiro Administrador de TI (veja docs/PRIMEIROS-PASSOS.md)
npm start                    # http://localhost:3000
```

Para ver o sistema com dados fictícios de demonstração (em um banco separado):

```bash
DB_PATH=data/demo.db npm run dados-exemplo
DB_PATH=data/demo.db npm start
# entre com ti@exemplo.com, marketing@exemplo.com ou colaborador@exemplo.com — senha Exemplo123
```

## Testes

```bash
npm test
```

Os testes (`test/cenarios.test.js`) validam, com dados gravados no banco, os cinco cenários de aceite:

1. Um visitante encontra a filial desejada e abre o canal de orçamento.
2. A TI cadastra um colaborador, atribui o perfil e libera o acesso (convite → criação de senha → login).
3. O Marketing publica um aviso para uma única filial; um colaborador dessa filial lê e confirma; colaboradores de outra filial recebem 404 mesmo com o link direto (página, capa e anexo).
4. O Marketing cria um álbum (várias fotos, capa, legenda, ordem) e altera a data de um treinamento; o público selecionado vê as duas atualizações, com o aviso “Data alterada de … para …”.
5. A TI desativa uma conta e o usuário perde o acesso imediatamente, inclusive na sessão já aberta; o histórico é preservado.

Também cobrem agendamento, retirada de circulação com confirmação, recuperação de senha, proteção CSRF e registro de mudança de perfil.

## Configuração (variáveis de ambiente)

| Variável | Para quê | Padrão |
|---|---|---|
| `PORT` | Porta HTTP | `3000` |
| `DB_PATH` | Arquivo do banco SQLite | `data/quality.db` |
| `UPLOAD_DIR` | Pasta dos arquivos enviados | `data/uploads` |
| `APP_URL` | Endereço público usado nos links dos e‑mails (ex.: `https://intranet.qualityimport.com.br`) | endereço da requisição |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, `SMTP_SECURE` | Envio de convites e redefinição de senha por e‑mail | sem SMTP: as mensagens ficam em **Administração › E‑mails** para a TI repassar |
| `COOKIE_SECURE=true` | Cookie de sessão só em HTTPS (use em produção) | — |
| `TRUST_PROXY=true` | Quando estiver atrás de proxy/HTTPS (Nginx, Render, etc.) | — |

Faça backup periódico da pasta `data/` (banco + arquivos).

## Perfis e permissões

| Perfil | Pode |
|---|---|
| Colaborador | Ver informativos, galerias e calendário destinados a ele; confirmar leituras |
| Marketing | Tudo do colaborador + painel editorial (criar, revisar, agendar, publicar, editar, arquivar informativos, álbuns e eventos). **Não** acessa a gestão de usuários |
| Administrador de TI | Tudo + usuários, perfis, filiais, setores, configurações do site e histórico de alterações |

As permissões são verificadas **no servidor** em todas as rotas, inclusive acesso direto a páginas, fotos e anexos. Público‑alvo: “Toda a empresa” ou filiais/setores selecionados (se escolher filiais e setores, vale quem estiver em uma das filiais **e** em um dos setores).

A conta desativada perde o acesso na hora: a sessão é validada no banco a cada requisição e todas as sessões dela são apagadas. Usuários nunca são excluídos, para preservar a autoria e o histórico.

## Dados pendentes de cadastro

A logomarca oficial já está aplicada (`public/img/logo-quality.png`; a TI pode trocá-la em **Administração › Site público**). Os dados oficiais já vêm preenchidos: WhatsApp e telefone (81) 2119-0161, e-mail contato@qualityimport.net.br, CNPJ 24.422.016/0001-50 e a Matriz (endereço e horário). As demais filiais e as redes sociais **não foram fornecidas**. Eles ficam configuráveis pela TI em **Administração › Site público** e **Administração › Filiais**; enquanto estiverem vazios, o site mostra “Pendente de cadastro”. As linhas de autopeças iniciais são sugestões editáveis em **Administração › Linhas de peças**. As ilustrações do site são provisórias; a TI pode enviar uma foto real da loja como “Imagem de destaque”.

Instruções rápidas: [docs/PRIMEIROS-PASSOS.md](docs/PRIMEIROS-PASSOS.md).
