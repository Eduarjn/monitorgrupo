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
npx esbuild api/server.ts --bundle --platform=node --format=esm --external:pg --outfile=dist/server.mjs
```

O Node do servidor é v20 e não executa TypeScript direto — daí o bundle.

⚠️ **`--external:pg` não é opcional.** O `pg` é CommonJS e usa `require()`
dinâmico; empacotado dentro de um bundle ESM, o processo morre no boot com
*"Dynamic require of 'events' is not supported"*. O `pg` já está instalado em
`node_modules` no servidor. Este README já derrubou o serviço uma vez por omitir
essa flag (D7).

## Captura em tempo real (Evolution API)

A ingestão ao vivo usa a **Evolution API self-hosted**, no mesmo servidor, em
`127.0.0.1:8081`. O tráfego nunca sai da máquina — mesma premissa do resto do
projeto. Ver `docs/02-decisoes.md`, D8.

⚠️ **8081, não 8080.** A 8080 é o EraLearn (`vite --port 8080 --host`) e está
liberada no ufw. Subir a Evolution ali colidiria com ele.

⚠️ **A tag tem prefixo `v`.** No Docker Hub o release é `v2.3.7`; `2.3.7` sem o
`v` devolve *manifest unknown*. E `latest` aponta para a **2.4.0-rc**, que é
justamente a versão que exige licença.

> ⚠️ **A imagem fica fixada em `evoapicloud/evolution-api:v2.3.7`. Nunca `:latest`.**
> A partir da 2.4.0 toda instância exige ativação contra o servidor de
> licenciamento da Evolution Foundation, e sem ela a API responde **503
> LICENSE_REQUIRED em todas as rotas**. Um `docker compose pull` com `:latest`
> derruba a captura inteira, em silêncio, no meio da noite. Upgrade para 2.4.x é
> decisão de negócio, não de infraestrutura.

```yaml
# /opt/evolution/docker-compose.yml
services:
  evolution:
    image: evoapicloud/evolution-api:v2.3.7
    restart: unless-stopped
    network_mode: host               # ver nota abaixo
    env_file: /opt/evolution/.env
    volumes: ["evolution_instances:/evolution/instances"]
    mem_limit: 900m                  # estoura o container, não o servidor
    memswap_limit: 900m
    logging: { driver: json-file, options: { max-size: "10m", max-file: "3" } }
volumes:
  evolution_instances:
```

O `mem_limit` não é zelo: o dump de sincronização no pareamento pode inflar o
heap do Baileys, e sem limite o OOM killer levaria o EraLearn junto. O servidor
tem ~2 GB disponíveis — a folga é pequena, acompanhe com `docker stats`.

`network_mode: host` é necessário porque, na rede bridge, `127.0.0.1` dentro do
container é o próprio container: a Evolution não alcançaria nem o Postgres nem a
nossa API. Em contrapartida a 8081 fica exposta em todas as interfaces — o ufw
tem política DROP por padrão e a 8081 não está na lista de ALLOW, então ela já
nasce fechada. **Não adicione `ufw allow 8081`.**

`.env` mínimo (modo 0600):

```bash
SERVER_URL=http://127.0.0.1:8081
SERVER_PORT=8081
AUTHENTICATION_API_KEY=<48 bytes aleatórios — TROCAR o default do exemplo>
DATABASE_ENABLED=true
DATABASE_PROVIDER=postgresql
DATABASE_CONNECTION_URI=postgresql://evolution:***@127.0.0.1:5432/evolution?schema=evolution_api
DATABASE_SAVE_DATA_NEW_MESSAGE=true
DATABASE_SAVE_DATA_HISTORIC=false
CACHE_REDIS_ENABLED=false
CACHE_LOCAL_ENABLED=true
QRCODE_LIMIT=6
DEL_INSTANCE=false
TELEMETRY_ENABLED=false
WEBHOOK_GLOBAL_ENABLED=false      # ligar isto E o da instância = cada msg 2x
WEBHOOK_REQUEST_TIMEOUT_MS=15000
WEBHOOK_RETRY_MAX_ATTEMPTS=6
```

**Operação do número** (mitigação de banimento — o risco é real e documentado):
chip dedicado com SIM físico, entrar nos grupos **manualmente pelo celular**
antes de parear, e **nunca enviar** por API. O `DriverCaptura` não tem método de
envio de propósito.

## Variáveis de ambiente da API

| Variável | Para quê |
|---|---|
| `JWT_SECRET` | mesmo segredo do PostgREST; assina o token que o RLS lê |
| `PGURL` | conexão com o banco `whatsapp_monitor` |
| `ORIGENS_PERMITIDAS` | lista branca de CORS, separada por vírgula |
| `CONEXAO_CHAVE_V1` | 32 bytes em base64 — cifra o token do canal de aviso |
| `CONEXAO_CHAVE_ATIVA` | qual versão cifra os segredos novos (padrão `1`) |
| `OPENAI_API_KEY` | opcional; sem ela o provider é o mock |
| `LEMBRETES` | `off` desliga a rotina de cobrança da coleta |
| `PORTA` | padrão 3020 |

Gerar a chave de criptografia:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Ela vive **só** no `EnvironmentFile` do systemd, em modo 0600. Guardá-la no banco
tornaria a cifra inútil: quem lê a tabela leria a chave junto.

O restante da configuração — endereço da API do canal, token, template, cadência
e destino do lembrete — é cadastrado **pela interface**, na aba Coleta.
