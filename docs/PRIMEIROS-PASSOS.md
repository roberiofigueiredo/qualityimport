# Primeiros passos

## 1. Configurar o primeiro Administrador de TI

No servidor, dentro da pasta do sistema:

```bash
npm install
npm run criar-admin -- --nome "Nome do Responsável" --email ti@suaempresa.com.br
```

O comando pede a senha (mínimo de 8 caracteres, com letras e números). Depois:

1. Inicie o sistema com `npm start` e abra o site.
2. Clique em **Área do Colaborador** e entre com o e‑mail e a senha criados.
3. Em **Administração › Site público**, confira a logomarca (a oficial já vem aplicada) e preencha WhatsApp comercial, telefone, e‑mail, CNPJ e redes sociais.
4. Em **Administração › Filiais**, renomeie a “Matriz” e cadastre cada loja com endereço, telefone, WhatsApp, horário e link do mapa.
5. Confira **Setores** e **Categorias** (já vêm com sugestões).
6. Em **Administração › Usuários › Cadastrar colaborador**, informe nome, e‑mail, filial, setor e perfil, e deixe marcado **Enviar convite agora**. A pessoa recebe um link (válido por 72 horas) para criar a própria senha — é isso que libera o acesso.
   - Sem SMTP configurado, o link aparece na tela logo após o cadastro e em **Administração › E‑mails**, para você repassar.
   - Para a equipe de comunicação, escolha o perfil **Marketing**: ela terá o painel editorial, mas não a gestão de usuários.

Para desativar alguém: abra o usuário › **Desativar conta** › confirme. O acesso é encerrado imediatamente, inclusive em sessões abertas. Para redefinir a senha de alguém: **Iniciar redefinição de senha**.

## 2. Primeira publicação do Marketing

1. Entre pela **Área do Colaborador** com a conta de Marketing e clique em **Painel do Marketing**.
2. Em **Informativos**, clique em **+ Novo informativo**.
3. Preencha **Título**, **Resumo** e o **Texto** (use os botões de formatação acima do texto). Se quiser, adicione **Imagem de capa** e **Anexos**.
4. À direita, escolha a **Categoria** e, se for o caso:
   - marque **Destacar como aviso prioritário** (aparece no topo da intranet);
   - marque **Solicitar confirmação de leitura** (o colaborador vê o botão “Confirmo que li”).
5. Em **Público‑alvo**, deixe **Toda a empresa** ou escolha **Filiais e/ou setores selecionados** e marque quem deve ver.
6. Clique em **Pré‑visualizar** para ver como ficará. Volte com **Voltar para a edição**.
7. Clique em **Publicar** (ou preencha o **Início da exibição** com uma data futura e clique em **Agendar**).

Na lista de informativos você acompanha o status (Rascunho, Agendado, Publicado, Exibição encerrada, Arquivado) e quantas pessoas confirmaram a leitura. Para tirar um conteúdo do ar, use **Retirar de circulação** — o sistema pede confirmação antes.

Álbuns (**Galeria de fotos › + Novo álbum**) e eventos (**Calendário › + Novo evento**) seguem os mesmos passos. Em álbuns, selecione várias fotos de uma vez; depois de salvar, escolha a capa, escreva legendas e ajuste a ordem. Em eventos, mudanças de data, horário ou local e cancelamentos aparecem automaticamente em “Mudanças na agenda” para o público do evento.
