# Decisões do projeto

Registro das decisões tomadas com o Eduardo, em ordem cronológica. Cada uma vale
até ser revista aqui.

---

## D1 — Escopo inicial: só texto (11/08/2026)

Áudio fica fora da primeira versão. **Fase 4 (Whisper) sai do caminho crítico.**

**Por quê:** simplifica o parser (some o mapeamento mensagem↔arquivo de mídia,
risco 1.2), elimina o custo de transcrição e — o mais relevante — tira do projeto
a parte mais pesada do problema legal, já que voz identificável tende a ser tratada
como dado sensível e texto não tem esse agravante.

**Como aplicar:** o schema já nasce com o tipo `audio_transcrito` previsto na coluna
de tipo da mensagem. Plugar áudio depois não exige migração.

**Ordem revisada:** Fase 0 → 1 → 2 → 3 → 5 → 6.

---

## D2 — Ingestão continua por export manual (11/08/2026)

O Eduardo perguntou se dava para vincular o WhatsApp ao painel, "tipo WhatsApp Web
ou WhatsApp Meta", para ler o histórico do grupo automaticamente. **Não dá — nem
pelo caminho oficial.** Verificado em 11/08/2026:

- **Coexistence** (liberada mundialmente em 2026) sincroniza até 6 meses de
  histórico, mas **só de conversas 1:1**. Grupos são explicitamente excluídos da
  sincronização, e mídia também.
- **Groups API** (nova em 2026) só opera grupos que a **própria empresa cria**, com
  até 8 membros. Não permite entrar num grupo existente nem ler o passado dele.
- Nenhum dos dois faz *backfill*: webhook entrega a partir da conexão, nunca o
  histórico anterior.

O caminho não oficial (`whatsapp-web.js`, Baileys, bot no WhatsApp Web) faria o que
foi pedido, mas **viola os Termos e bane o número** — e o brief manda recusar. Num
projeto onde o WhatsApp é o canal comercial da ERA, perder o número é risco de
operação, não de projeto.

**Conclusão:** o export manual não é limitação do nosso desenho — é a única porta
que a Meta deixou aberta.

---

## D3 — Coleta programada: agenda tudo, menos o clique (11/08/2026)

O painel **não dispara** o export (ele é um clique dentro do app, no celular). Tudo
o resto é automático:

| Etapa | Automático? | Como |
|---|---|---|
| Exportar no celular | **não** | continua manual, ~20s |
| Lembrar de exportar | sim | notificação na frequência configurada — **pelo WhatsApp oficial da ERA**, não por e-mail |
| Receber o arquivo | sim | destino fixo (e-mail de coleta ou pasta compartilhada); o Eduardo só encaminha |
| Processar e deduplicar | sim | dispara ao detectar arquivo novo |
| Gerar o resumo | sim | roda após a ingestão e pode ser entregue pronto |
| Cobrar quem atrasou | sim | painel de saúde da coleta: "3 grupos sem coleta há mais de X dias" |

**Frequência: semanal por padrão**, configurável por grupo. Diário só para grupo
muito ativo — o ganho é pequeno e o custo de reprocessar o mesmo arquivo grande se
multiplica.

### Consequência técnica (afeta Fases 1 e 2)

O WhatsApp **não exporta por período — exporta a conversa inteira, sempre**. Cada
coleta contém tudo o que veio antes. Daí:

1. O arquivo **cresce a cada coleta**; num grupo antigo, a maior parte de cada
   export já é conhecida.
2. Dedup por mensagem deixa de ser refinamento e vira **obrigatório**: sem ele, a
   segunda coleta duplica o histórico inteiro.
3. O parser precisa **descartar rápido o que já conhece** (índice sobre o hash da
   mensagem), senão cada coleta reprocessa o passado todo e fica mais lenta com o
   tempo. Isso reforça a decisão de parser em streaming.

---

## D4 — Banco: Supabase self-hosted, em banco próprio (11/08/2026)

Aprovado o self-hosted do servidor 138.59.144.162, pelo tipo de dado (mensagens de
várias pessoas). Criado o banco **`whatsapp_monitor`**, separado do `postgres`
(EraLearn) e do `erareason` — mesmo padrão de isolamento já adotado.

Confirmado no servidor antes de escrever o schema: **pgvector 0.8.0 já instalado**,
Postgres 15.8, `pg_trgm` e `unaccent` disponíveis, configuração de busca em
português presente.

**Detalhe de implementação:** num banco separado o schema `auth` do Supabase não
existe, então `schema.sql` recria `auth.uid()` e `auth.role()` lendo o JWT do GUC
`request.jwt.claims` — o mesmo comportamento do Supabase hospedado. Assim as
políticas de RLS ficam idênticas às de um projeto Supabase normal.

---

## Fase 1 — concluída e validada (11/08/2026)

Arquivos: `db/schema.sql`, `db/rls-policies.sql`, `shared/types.ts`.

Aplicado no banco `whatsapp_monitor` com **0 erros**: 9 tabelas, 23 índices,
15 políticas de RLS.

**Testes executados (não é só "rodou"):**

| Teste | Resultado |
|---|---|
| Dedup por mensagem: reinserir a mesma linha | continua 3 — não duplica |
| RLS: usuário do grupo Comercial | vê 3 mensagens, só o grupo Comercial |
| RLS: usuário do grupo Financeiro | vê 1 mensagem, só o grupo Financeiro |
| RLS: usuário sem acesso | vê 0 mensagens e nenhum grupo |
| Leitor do grupo 2 tentando apagar o grupo 1 | **0 linhas apagadas**; grupo 1 intacto (conferido por fora do RLS) |
| Gestor apagando no próprio grupo (direito LGPD) | 1 linha — permitido |
| Busca textual em português, sem IA | acha 2 mensagens citando "Eduardo" |

⚠️ Duas armadilhas encontradas ao testar, que valem para o resto do projeto:
1. `set local role` só funciona **dentro de transação** — fora dela a sessão segue
   como superusuário, que **ignora RLS**. Um teste mal escrito "passa" sem provar nada.
2. Contar linhas depois de um DELETE **sob RLS** não prova nada: a contagem também
   é filtrada. Verificar sempre por fora, com superusuário.

Dados de teste removidos ao final; o banco está vazio e pronto.

---

## Fase 2 — parser concluído, 12/12 testes (11/08/2026)

Arquivos: `api/ingestion/parser.ts`, `api/ingestion/dedup.ts`,
`api/ingestion/__tests__/` (4 fixtures + 12 testes, `npm test`).

Estrutura conforme o plano do Eduardo (array de validadores, buffer para
multilinha, streaming por iterável de linhas, `ON CONFLICT DO NOTHING` no banco),
com **quatro correções** que os exports reais exigem:

1. **Regexes tolerantes**: dia/mês com 1 dígito (`8/3/26`, padrão en-US), vírgula
   após a data, segundos opcionais, AM/PM (inclusive com U+202F antes do sufixo,
   que é o que o iOS gera em inglês), separadores `/.` `-` e en/em-dash no Android.
   As regexes originais do plano (`\d{2}` fixo, sem AM/PM) falhariam nesses casos.
2. **Marcas invisíveis** (U+200E/200F/202A-E/2066-69, BOM) removidas antes do
   match — o iOS espalha isso pelo arquivo; sem a limpeza, nem a regex do iOS casa.
3. **Sistema não é só "sem dois-pontos"**: no iOS o aviso de criptografia vem como
   `NomeDoGrupo: ‎texto` — TEM dois-pontos. A classificação usa a heurística do
   plano E uma lista bilíngue de frases de sistema.
4. **DMY×MDY resolvido no fim do arquivo**: o parser acumula os campos crus e só
   materializa timestamps depois de varrer tudo (uma data com valor > 12 prova o
   formato). Ambíguo → opção do usuário ou DMY com aviso; opção que contradiz o
   arquivo é ignorada com aviso.

**Divergência do plano, decidida a favor das estatísticas:** o plano mandava
*dropar* `<Mídia omitida>`. O padrão aqui é MANTER como `tipo='midia'` com
conteúdo vazio: a linha custa bytes e preserva o volume real por autor na Fase 3
("João mandou 40 fotos" é atividade). Mídia nunca vai para o LLM/embedding.
`descartarMidiaSemArquivo: true` habilita o comportamento do plano.

**Detalhe do dedup:** o hash usa os campos CRUS (data/hora/autor/conteúdo como
texto), não o timestamp interpretado — assim, corrigir DMY×MDY depois NÃO muda
os hashes e a recoleta não duplica nada. Testado: mesma linha com interpretações
de data diferentes → mesmo hash.

⚠️ Fixtures são sintéticos (montados dos formatos conhecidos). Exports reais da
Fase 0 entram como fixtures adicionais quando chegarem — os reais mandam.

---

## Fase 3 — estatísticas em SQL puro, validadas no banco real (11/08/2026)

Arquivo: `api/stats/queries.ts` — 5 funções (`getVolumePorAutor`, `getVolumePorDia`,
`getHorariosDePico`, `getRankingParticipantes`, `getMencoesTermo`), zero chamadas de
IA, executor injetado (`DB`) para testabilidade, período meio-aberto `[inicio, fim)`.

**Dois ajustes sobre a especificação original:**

1. **Agrupamento por identidade, não por string** (risco 1.3): `pessoa_id` quando a
   conciliação existe, `autor_raw` quando não. Validado: "Autor 1"+"Autor 2"
   conciliados numa pessoa aparecem como UMA linha ("João Silva", 19.601).
2. **Fuso explícito em dia/hora** (parente do risco 1.1): `AT TIME ZONE` antes de
   `date_trunc`/`extract`. Validado com mensagem de 23:30-03: com fuso cai em
   11/08 às 23h; sem fuso cairia em 12/08 às 02h — o bug silencioso foi
   demonstrado, não só teorizado.

**Validação sobre 60k mensagens semeadas no `whatsapp_monitor` (depois limpas):**

| Prova | Resultado |
|---|---|
| Menções "Eduardo" × recontagem ILIKE independente | 606 = 606 |
| Ocorrências múltiplas (3× na mesma linha) | mensagens 607, ocorrências 609 ✓ |
| Range de datas | **Bitmap Index Scan em `idx_mensagens_reais`** (parcial) — sem Seq Scan |
| Menções | **Bitmap Index Scan em `idx_mensagens_busca`** (GIN); stemming visível no plano (`'eduard'`) |

**Notas de semântica e custo (documentadas no arquivo):**
- `mensagens` (FTS, com stemming) e `ocorrencias` (literal, sem acento/caixa) podem
  divergir — os dois números existem de propósito.
- `websearch_to_tsquery` no lugar de `to_tsquery`: input humano não estoura sintaxe.
- Agregação do histórico COMPLETO lê tudo mesmo — é da natureza da operação; o
  índice parcial ainda poupa as linhas `sistema`.
- Índice B-Tree em `autor` foi pedido e **não** criado: não ajuda estas agregações
  (HashAggregate visita as linhas do período de qualquer forma) e custaria escrita
  a cada upload. Se surgir "linha do tempo de um autor", criar
  `(grupo_id, autor_raw, enviada_em)`.

---

## D5 — Entrega final: frontend na Vercel, dados no servidor (11/08/2026)

Pedido do Eduardo: ao final, painel acessível online com login
(`eduarjose.fajardo@era.com.br`). Arquitetura:

- **Frontend (React)** → Vercel, como pedido. São só arquivos estáticos — nenhum
  dado sensível passa pela Vercel.
- **API + banco** → servidor 138.59.144.162, onde o `whatsapp_monitor` já vive.
  O navegador fala direto com o servidor (CORS liberado para o domínio da Vercel).
  Isso preserva a razão da D4: mensagens da equipe não saem de casa.
- **Auth próprio** (padrão ERAREASON, adaptado ao RLS): tabela `usuarios` no banco
  `whatsapp_monitor`, senha com **scrypt**; o login emite um JWT assinado com o
  segredo do PostgREST contendo `sub = uuid do usuário` — exatamente o que
  `auth.uid()` da Fase 1 lê, então o RLS por `grupo_acessos` funciona sem mudar nada.
- Conta do Eduardo criada; senha inicial definida por ele. ⚠️ Senha fraca —
  recomendação registrada de trocá-la no primeiro acesso.

## Fase 5 — concluída: 27/27 unitários + 16/16 integração real (11/08/2026)

Arquivos: `api/ai/provider.ts`, `embed.ts`, `summarize.ts`, `search.ts`,
`__tests__/ai.test.ts` (unitário) e `__tests__/integracao-pgvector.ts` (integração).

`criarProvider()` cai no **MockProvider** sem `OPENAI_API_KEY` — todo o pipeline
roda e é testado sem chave e sem custo. O `OpenAIProvider` está pronto e ativa
sozinho quando a chave existir.

**Bloco, não mensagem** (risco 1.5): janela de conversa com corte por silêncio
(15 min), teto de mensagens (40) e de caracteres (4000). Validado contra o
pgvector real: 3 assuntos separados por silêncio viraram 3 blocos, a pergunta
sobre "orçamento da proposta" recuperou o bloco da proposta (sim. 0,381) e não o
do churrasco; "o servidor caiu?" recuperou o bloco do servidor (sim. 0,601).

**Cache de resumo**: tabela `resumos_dia` com assinatura = md5 dos hashes das
mensagens do dia. Provado que o modelo é chamado **uma vez só** em duas aberturas
seguidas, e que mensagem nova invalida e regenera sozinho.

**Recusa em vez de invenção**: sem bloco acima do corte de similaridade, responde
"Não encontrei isso no histórico recuperado" **sem chamar o modelo**.

⚠️ **Correção de uma afirmação minha:** a primeira execução "passou" um teste que
dizia usar o índice HNSW, mas o plano era `Limit → Sort` — a asserção casou por
acidente. Com 3 blocos o Postgres varrer é mais barato mesmo, e está certo.
Verifiquei à parte com **3.000 blocos**: aí o plano vira
`Index Scan using idx_blocos_embedding`, com e sem o filtro de `grupo_id`. O teste
agora só REPORTA o plano, em vez de exigir índice num volume onde ele não deve ser
usado.

**Por que RAG e não mandar tudo** (documentado em `search.ts`): 60 mil mensagens
≈ 2,5 mi de tokens — não cabe na janela de nenhum modelo e custaria ~US$ 0,38 por
pergunta. Com RAG: os vetores custam ~US$ 0,05 uma vez, e cada pergunta sai por
~US$ 0,0003. ~1.000× mais barato, e funciona em histórico de qualquer tamanho.

### Achado de segurança (não relacionado a este projeto)

A porta **5432 do Postgres do servidor está aberta para a internet**
(`0.0.0.0:5432`, via supavisor). Qualquer um pode tentar autenticar de fora.
Recomendação: restringir a porta no firewall a IPs conhecidos. Não mexi — é
infraestrutura compartilhada com o EraLearn.

---

## Fase 6 — concluída, faltando 1 registro de DNS (11/08/2026)

**Frontend** (`web/`): Vite + React + TS + Tailwind + recharts + lucide — a mesma
stack do pana-learn, com a paleta espelhada dele (primária `#34C759`, tema claro).
Telas: Login, Dashboard, Resumo e busca, Upload, Consentimento.
No ar em **https://whatsapp-monitor-era.vercel.app** (HTTP 200, renderiza o login).

⚠️ A URL longa do deploy (`whatsapp-monitor-<hash>-eduarjoses-projects.vercel.app`)
devolve **302** por causa da *Deployment Protection* da Vercel. A URL estável do
projeto não tem essa proteção — usar sempre `whatsapp-monitor-era.vercel.app`.

**Backend** (`api/server.ts` → bundle `dist/server.mjs`): o Node do servidor é v20 e
não roda TypeScript direto; o esbuild empacota para JS, evitando mexer na versão do
Node compartilhada com o EraLearn. Serviço `whatsapp-monitor.service` em
127.0.0.1:3020, nginx em `wa-api.sobreip.com.br` (bloco próprio; EraLearn e
ERAREASON conferidos em 200 depois do reload).

**Auth** (`api/auth/auth.ts`): scrypt + JWT HS256 com o segredo do PostgREST e
`sub` = uuid do usuário — compatível com o `auth.uid()` da Fase 1. Conta criada:
`eduarjose.fajardo@era.com.br`, papel admin no grupo "Comercial ERA".

### Validação ponta a ponta pela API real (curl com --resolve)

| Prova | Resultado |
|---|---|
| Login correto | token emitido |
| Senha errada / sem token | 401 nos dois |
| Upload `android-pt` | android, DMY, 12 linhas → 9 mensagens (4 texto, 2 mídia, 3 sistema) |
| Reenvio do MESMO arquivo | `duplicado: true`, 0 novas |
| Upload `ios-pt` | ios detectado, 6 novas |
| Estatísticas | 11 mensagens, 4 autores, pico às 9h |
| Indexar + buscar | 4 blocos, resposta com 3 fontes citadas |
| Consentimento | registrado e listado |

### Dois bugs encontrados e corrigidos durante a verificação

1. **Fuso duplicado nos blocos.** `embed.ts` gravava a hora LOCAL como texto sem
   fuso numa coluna `timestamptz`; o Postgres a interpretava no fuso da sessão e o
   `search.ts` convertia de novo — a citação do RAG saía 3h deslocada (09:14 → 06:14).
   Agora o bloco guarda o INSTANTE em UTC e a hora local vai só no texto que o
   modelo lê. Teste de regressão adicionado (28/28 passando).
2. **Reindexação deixava bloco órfão.** O `delete` por janela não alcançava bloco
   cujo `inicio_em` caísse fora do intervalo. A rota `/indexar` agora apaga todos
   os blocos do grupo antes de recriar.

Também mordeu no caminho: o hash scrypt contém `$`, e passá-lo por heredoc não
citado fez o shell remoto comer `$4` e `$1` (168 → 164 chars), quebrando o login.
Corrigido gerando o SQL em arquivo, sem expansão de shell.

---

## D6 — Visual: design system ERA no lugar do pana-learn (14/08/2026)

A pedido do Eduardo, o front saiu da paleta clara do pana-learn e adotou o
**Design System ERA** (`brandingbook/ERA_DesignSystem.md`): dark industrial
(base `#1e262c`, superfícies `#2C353D`), Fulor `#CEFF00` como primária com texto
escuro por cima (regra de contraste do brandbook), Aqua `#97B9BC` em eyebrows,
Barlow Condensed uppercase em títulos/CTAs e Barlow no corpo (Google Fonts).
Tokens centralizados no `tailwind.config.ts` — as classes semânticas
(`bg-background`, `text-muted-foreground`…) foram mantidas, só o mapeamento mudou.
Gráficos do recharts com linha/barras Fulor e tooltip escuro. Publicado em
produção (`whatsapp-monitor-era.vercel.app`) no mesmo dia.

Sobre o DNS pendente da Fase 6: `wa-api.sobreip.com.br` resolve para
**189.113.38.45** (não é o servidor). Irrelevante na prática — a API já é servida
em `erareason.sobreip.com.br/wa-api`, que é o que o `.env.production` usa.

## D7 — Conexão por QR Code: não existe. Coleta assistida no lugar (14/08/2026)

O Eduardo pediu vincular o número por QR Code, para substituir o upload manual.
**Reverificado hoje contra a documentação primária da Meta, com três agentes
adversariais tentando derrubar a conclusão. Nenhum conseguiu.**

| Caminho oficial | Serve? |
|---|---|
| **Groups API** (GA em 16/06/2026) | Não. Só grupos que a própria empresa cria, teto de 8 participantes. Não há endpoint para entrar em grupo de terceiros nem para ler o passado. `POST /{group_id}/join_requests` engana pelo nome: é a empresa **aprovando** quem pede para entrar no grupo dela |
| **Coexistence** (webhook `history`) | Não. Sincroniza 180 dias, mas exclui grupos por texto expresso: *"Group chats will not be synchronized."* |
| **Cloud API** (webhooks) | Parcial. Conversa 1:1 em tempo real, nunca grupo |

**Razão de fundo:** o WhatsApp é E2EE. A Meta não tem o conteúdo no servidor — o
histórico existe só no aparelho e no backup. Não é política que mude num
changelog; é ausência do dado. Por isso o "Exportar conversa" continua sendo um
clique no celular.

**Correção de algo que circulava aqui:** *não existe QR Code oficial no fluxo de
Coexistence*. O fluxo real é código de verificação numérico dentro do app. O "QR"
de blogs de BSPs é interface deles.

**O QR que funciona é o proibido.** Whapi.Cloud, Maytapi, Periskope, Unipile e
Wassenger entregam monitoramento de grupo — e todos, checados na fonte primária,
conectam por leitura de QR (WhatsApp Web / linked device). A Unipile declara não
ter afiliação com a Meta; a Wassenger diz "parceiro oficial" e manda ler QR na
home. Isso **confirma** a D2 em vez de enfraquecê-la. Mantida a recusa do brief.

Detalhe que fecha o argumento: mesmo aceitando o risco de ban, **não resolveria o
histórico** — `fetchMessageHistory` do Baileys falha e desligar `syncFullHistory`
quebra o sync de grupos. O retroativo continuaria vindo do `.txt`.

### O que foi construído: Opção A — coleta assistida

Achado que reorientou a decisão: **a ERA já tem WhatsApp oficial** — o Omnichannel
Calliope, com API de template HSM em produção. O lembrete sai por ele, hoje, sem
Tech Provider, sem App Review e sem mexer no número comercial. (E se o número já
estiver na WABA do Calliope, o Embedded Signup nem seria executável sem migração
entre WABAs — pendente de confirmação.)

Entregue e no ar:

- `db/2026-08-coleta.sql` — `consentimento_vigente()`, `usuarios.papel_global`,
  `conexoes`, `conexao_eventos`, `lembretes_enviados`, colunas de lembrete em `grupos`.
- `api/conexao/cripto.ts` — AES-256-GCM versionado + `sanitizar()` de logs.
- `api/conexao/calliope.ts` — disparo de template e teste de canal.
- `api/coleta/queries.ts` — saúde da coleta e fila de cobrança, em SQL puro.
- Aba **Coleta** no painel: saúde de todos os grupos, cadência e destino por grupo,
  e cadastro do canal (endpoint, token, template) **pela interface**, não por env.
- Rotina de cobrança **dentro do processo** (de hora em hora). Um systemd timer
  exigiria credencial em disco ou rota sem autenticação — as duas pioram a segurança.

**O gate de consentimento deixou de ser decorativo.** Antes, nenhum ponto da
ingestão consultava a tabela e `revogado_em` não tinha caminho de escrita. Agora:
ligar o lembrete ou disparar manualmente sem aviso vigente devolve **409**; o
upload **avisa e não bloqueia** (ato humano deliberado, diferente do que roda
sozinho). Rota `/consentimentos/revogar` criada.

**Provado na API real:** 409 ao ligar cobrança sem consentimento; 409 no disparo
manual; 400 em telefone inválido; 200 com o lembrete desligado. 41/41 testes
unitários (13 novos: rotação de chave, chave errada falha em vez de devolver
lixo, adulteração detectada pela tag do GCM, sanitização de segredo em log).

⚠️ **Dois erros encontrados durante a implantação:**

1. **O comando de build do README derrubou o serviço.** `esbuild --bundle` sem
   `--external:pg` empacota o `pg`, que é CommonJS, e o processo morre com
   *"Dynamic require of events is not supported"*. Restaurado do backup em
   segundos; README corrigido. **Sempre `--external:pg`.**
2. **`bigint` volta como string do driver do Postgres.** `grupo_id` chegava como
   `"1"` e a comparação com o id numérico do seletor (`Number(...)`) falhava em
   silêncio — a tela ficaria vazia ao trocar de grupo. Corrigido com `::int` nas
   queries de `/grupos` e `/coleta/saude`. Bug latente que já existia.

**Pendente de você:** cadastrar o token do Calliope na aba Coleta e confirmar o
nome do template aprovado na Meta (o padrão é `lembrete_coleta`, com duas
variáveis: nome do grupo e há quanto tempo sem coleta).

## Pendentes de decisão

- **Export real para os fixtures** (Fase 0): valida o parser contra a realidade.
  O Eduardo ficou de enviar amostra anonimizada do `.txt` real.
- **Chave da OpenAI**: necessária só para ativar resumo/busca em produção.
- **Quem emite o JWT**: reaproveitar o gotrue do EraLearn (mesmo segredo) ou subir
  um Auth próprio. Não bloqueia a Fase 3 — o schema já é agnóstico, porque
  a autorização depende de `grupo_acessos`, não de quem assinou o token.
