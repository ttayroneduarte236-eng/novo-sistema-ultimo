# DUARTE MOTOS – Gestão

Sistema com login, estoque, notas, financeiro e pagamentos (Pix/cartão).

## Rodar
    npm install
    npm start        # http://localhost:3000

O primeiro cadastro vira administrador. Depois disso, novos usuários só entram com o
código de convite definido na variável CODIGO_CONVITE (sem ela, ninguém mais se cadastra).

## Variáveis de ambiente
- PORT: porta (a hospedagem costuma definir sozinha)
- CODIGO_CONVITE: código para cadastrar funcionários
- SECRET: texto longo e aleatório para assinar o login (opcional; se ausente é gerado em data/secret)
- DATA_DIR: pasta dos dados (padrão ./data). Em hospedagem, aponte para um disco persistente!

## Hospedar
Render, Railway, Fly.io ou VPS: Build `npm install`, Start `npm start`.
Use HTTPS e um disco/volume persistente em DATA_DIR, senão os dados somem a cada deploy.
Faça backup periódico do arquivo data/db.json.

## Mercado Pago (cobrança automática)
Crie uma aplicação no painel de desenvolvedores do Mercado Pago e copie o **Access Token de produção**.
No servidor, defina as variáveis:
- MP_ACCESS_TOKEN: o Access Token (nunca coloque no código nem no GitHub)
- MP_PAYER_EMAIL: e-mail genérico usado na cobrança Pix (opcional)
Depois, na aba Pagamentos, escolha uma nota e use "Gerar Pix" ou "Gerar link de cartão".
- PUBLIC_URL: endereço público do site (opcional; usado no retorno do Open Finance)

## Open Finance (monitorar a conta bancária)
Aba "Banco". Sem configurar nada você já pode **importar o extrato (OFX ou CSV)** baixado no app do banco.
Para sincronização automática, crie uma conta em dashboard.pluggy.ai (serviço Pluggy) e defina no servidor:
- PLUGGY_CLIENT_ID
- PLUGGY_CLIENT_SECRET
Depois use "Conectar banco" na aba Banco. O sistema busca as movimentações dos últimos 90 dias e atualiza a cada 15 minutos
enquanto o sistema estiver aberto. A senha do banco nunca passa pelo sistema: a autorização é feita na janela da Pluggy.
