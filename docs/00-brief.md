# Painel de Análise de Histórico de Grupo WhatsApp — brief

> Documento de origem do projeto, colado pelo Eduardo em 11/08/2026. As fases
> abaixo são o plano original; a ordem revisada (com a Fase 0) está em
> `01-riscos-e-ordem.md`.

## Objetivo

Ferramenta web onde se faz upload do `.txt` exportado de um grupo de WhatsApp
(função oficial "Exportar conversa") junto com os áudios, e o sistema:

- estrutura e armazena todo o histórico;
- transcreve os áudios;
- gera resumos por dia de um chat específico;
- responde perguntas em linguagem natural sobre o histórico
  (ex.: "o que falaram sobre X?", "quantas vezes me citaram?");
- exibe um painel com estatísticas (volume por autor, por dia, horários de pico).

## Contexto legal (respeitar no design)

- O grupo é do Eduardo / da equipe, e os membros estão cientes de que as conversas
  são analisadas por IA para fins de gestão. O sistema precisa registrar esse
  aviso/consentimento.
- Ingestão **sempre** por upload manual do export oficial. **Nunca** propor nem usar
  automação não oficial (Baileys, whatsapp-web.js, bot lendo o WhatsApp Web): viola
  os Termos do WhatsApp, bane o número e é incompatível com o projeto. Se for pedido
  mais tarde, recusar e lembrar o motivo.
- Dados sensíveis (mensagens e voz de várias pessoas). Controle de acesso é
  obrigatório, não opcional.

## Stack (definida pelo Eduardo — não trocar sem avisar)

- **Backend:** Node.js + TypeScript
- **Banco / Auth:** Supabase (Postgres), com `pgvector` para busca semântica e
  Row Level Security para controle de acesso
- **Frontend:** React + TypeScript
- **Transcrição:** Whisper (OpenAI API)
- **Resumo / busca / embeddings:** atrás de uma interface `AIProvider` única, para
  trocar OpenAI ↔ Claude sem reescrever o resto. Começar com OpenAI, mas isolar.

## Arquitetura de pastas alvo

```
whatsapp-monitor/
├── /web        (React/TS: upload, dashboard, resumo-dia, busca)
├── /api        (Node/TS: ingestion, ai, stats, auth)
│   ├── /ingestion  (parser.ts, dedup.ts, audio.ts)
│   ├── /ai         (provider.ts, summarize.ts, embed.ts, search.ts)
│   ├── /stats      (queries.ts — contagens em SQL puro, SEM IA)
│   └── /auth       (Supabase Auth + RLS)
├── /db         (schema.sql, rls-policies.sql)
└── /shared     (types.ts)
```

## Princípios de design

1. O parser do `.txt` é o maior risco. O formato varia entre iOS e Android e entre
   idiomas do celular. Precisa ser robusto e ter testes.
2. Não usar IA onde SQL basta. "Quantas vezes me citaram" e as estatísticas são
   consulta, não chamada de modelo. IA só para resumo e busca semântica.
3. Transcrever cada áudio uma única vez e guardar o texto; nunca re-transcrever.
4. Deduplicar uploads para não reprocessar o mesmo export.
5. Isolar o provedor de IA atrás de uma interface.

## Fases previstas no brief original

| Fase | Entrega |
|---|---|
| 1 | Modelo de dados: `db/schema.sql`, `db/rls-policies.sql`, `shared/types.ts` |
| 2 | Parser do `.txt` + `dedup.ts` + testes por formato (iOS/Android × pt/en) |
| 3 | Estatísticas em SQL puro (`api/stats/queries.ts`), sem IA |
| 4 | Áudio: `api/ingestion/audio.ts` com Whisper, sem re-transcrição |
| 5 | IA: `provider.ts`, `summarize.ts`, `embed.ts`, `search.ts` (RAG com citação) |
| 6 | Frontend React/TS: upload, dashboard, resumo do dia, busca, consentimento |

**Regra de avanço:** uma fase por vez, só quando a anterior estiver testada.
O estilo visual deve seguir o outro projeto do Eduardo, o **pana-learn** (EraLearn).
