# Doações com Asaas — passo a passo

1. **Sandbox primeiro.** Crie uma conta sandbox em sandbox.asaas.com, gere a chave de API (Integrações > Chaves de API) e crie uma chave Pix aleatória (Pix > Minhas chaves, ou `POST /v3/pix/addressKeys` com `{"type":"EVP"}`).
2. **Variáveis no Render** (veja `.env.example`): `ASAAS_ENV=sandbox`, `ASAAS_API_KEY`, `ASAAS_PIX_KEY`, `ASAAS_WEBHOOK_TOKEN` (32+ caracteres aleatórios), `ADMIN_SECRET` e `FRONTEND_URL`.
3. **Webhook no Asaas** (Integrações > Webhooks): URL `https://SEU-BACKEND.onrender.com/api/webhooks/asaas`, o mesmo token em "Token de autenticação", fila sequencial e evento **PAYMENT_RECEIVED** (cobranças).
4. **Teste:** gere um Pix no site e pague no sandbox com `POST /v3/pix/qrCodes/pay` usando o `payload` retornado. O doador deve aparecer no mural em segundos.
5. **Produção:** repita a chave de API, a chave Pix e o webhook na conta real e troque `ASAAS_ENV=production`.

Observações
- O Asaas pausa a fila do webhook após 15 falhas seguidas. Se o Render estiver dormindo, o primeiro envio pode demorar, mas o Asaas tenta de novo (eventos ficam guardados por 14 dias).
- A coleção `donations` do Firestore não deve ser legível pelo navegador (`allow read, write: if false`).
