const { createApp } = require('./app');

const port = Number(process.env.PORT || 3000);
const app = createApp();
app.listen(port, () => {
  console.log(`Quality Import Peças rodando em http://localhost:${port}`);
  if (!process.env.SMTP_HOST) console.log('Aviso: SMTP não configurado. Os e-mails ficam em Administração > E-mails enviados.');
});
