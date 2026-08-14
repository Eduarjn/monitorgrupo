# Monitor de Grupos — ERA

Painel de análise de histórico de grupos de WhatsApp: upload do export oficial
(`.txt`), estatísticas em SQL, resumo do dia por IA e busca em linguagem natural
com citação das fontes (RAG).

> **Ingestão é sempre por export manual.** Automação não oficial (Baileys,
> whatsapp-web.js, bot no WhatsApp Web) viola os Termos do WhatsApp e bane o
> número — está descartada por decisão de projeto (`docs/02-decisoes.md`, D2).

## Arquitetura

| Camada | Onde roda |
|---|---|
| `web/` — React + Vite + TS + Tailwind | Vercel — https://whatsapp-monitor-era.vercel.app |
| `api/` — Node + TS (bundle esbuild) | servidor próprio, `whatsapp-monitor.service` em 127.0.0.1:3020 |
| `db/` — Postgres + pgvector + RLS | banco `whatsapp_monitor`, self-hosted |

O navegador fala direto com a API no servidor (CORS por lista branca). Nenhuma
mensagem passa pela Vercel: o frontend são só arquivos estáticos.

## Estrutura

```
api/ingestion/   parser do .txt (iOS/Android × pt/en) + dedup por mensagem
api/stats/       estatísticas em SQL puro — sem IA
api/ai/          provider.ts (OpenAI ↔ mock), embed, summarize, search (RAG)
api/auth/        scrypt + JWT HS256 compatível com auth.uid() do RLS
db/              schema.sql e rls-policies.sql
shared/          tipos comuns ao front e à API
docs/            brief, riscos e o registro de decisões (leia o 02 primeiro)
```

## Desenvolvimento

```bash
cd web && npm install && npm run dev
```

O front em dev usa `web/.env.development`, que aponta para a API do servidor.
Sem esse arquivo o Vite cai no padrão `http://localhost:3020` e o login falha
com *Failed to fetch*.

Testes da API (não precisam de banco nem de chave de IA):

```bash
npm test
```

Sem `OPENAI_API_KEY`, `criarProvider()` cai no **MockProvider**: todo o pipeline
de resumo e busca roda e é testado sem custo. Basta definir a chave no serviço
para ativar os modelos de verdade.

## Build da API

```bash
npx esbuild api/server.ts --bundle --platform=node --format=esm --outfile=dist/server.mjs
```

O Node do servidor é v20 e não executa TypeScript direto — daí o bundle.

## Variáveis de ambiente da API

| Variável | Para quê |
|---|---|
| `JWT_SECRET` | mesmo segredo do PostgREST; assina o token que o RLS lê |
| `DATABASE_URL` | conexão com o banco `whatsapp_monitor` |
| `ORIGENS_PERMITIDAS` | lista branca de CORS, separada por vírgula |
| `OPENAI_API_KEY` | opcional; sem ela o provider é o mock |
| `PORTA` | padrão 3020 |
