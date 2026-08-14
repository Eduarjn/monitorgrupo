# Riscos não previstos no brief + ordem de construção revisada

> Resposta ao PROMPT-MESTRE, 11/08/2026. Nenhum código foi escrito ainda.

## 1. Riscos que o brief não cobre

### 1.1 Ambiguidade de data — o mais perigoso, porque é silencioso

O export não traz o fuso nem o formato de data de forma explícita. Ele usa o que
estava configurado **no celular de quem exportou**. Em `03/08/2026` não dá para
saber, só olhando a linha, se é 3 de agosto (pt-BR) ou 8 de março (en-US).

Isso não gera erro: gera um histórico inteiro deslocado. Todo resumo por dia, todo
gráfico por data e todo "horário de pico" ficam errados sem nenhum aviso.

**Mitigação:** detectar o formato por inferência (procurar um dia > 12 no conjunto)
e, quando ambíguo, **perguntar ao usuário no upload** e gravar a escolha junto ao
upload. Guardar timestamp com fuso explícito no banco.

### 1.2 O vínculo entre a mensagem e o arquivo de áudio é frágil — e é da Fase 2

O brief coloca áudio na Fase 4, mas o **mapeamento** mensagem↔arquivo nasce no
parser. As formas mudam por plataforma:

- **Android:** a linha cita o nome do arquivo (`PTT-20260811-WA0001.opus (arquivo anexado)`)
- **iOS:** vem como `<anexado: 00000042-AUDIO-2026-08-11-10-30-00.opus>`
- **Export "sem mídia":** a linha vira `áudio ocultado` / `audio omitted` e **não existe arquivo nenhum**

Se o parser não extrair o nome do arquivo, a Fase 4 não sabe qual áudio pertence a
qual mensagem — e a transcrição entra sem autor e sem horário corretos.

**Mitigação:** o parser devolve, por mensagem, o nome do arquivo de mídia quando
houver. E a tela de upload precisa avisar quando o export veio sem mídia.

### 1.3 Nome de autor não é identidade

O autor aparece como está na agenda de quem exportou: `João`, `João Silva`,
`+55 19 99999-9999`. A mesma pessoa aparece diferente em exports de celulares
diferentes, e quem não está na agenda aparece só como número.

Isso quebra exatamente a pergunta que o Eduardo quer responder — "quantas vezes me
citaram" e "ranking de participantes".

**Mitigação:** tabela `pessoas` + tabela `aliases` (nome-como-aparece → pessoa), com
uma tela de conciliação. Isso precisa entrar na **Fase 1**, não depois.

### 1.4 Dedup por hash do arquivo não resolve export incremental

Hash do arquivo só evita subir **o mesmo arquivo** duas vezes. Mas o uso real é:
exportar hoje, exportar de novo daqui a duas semanas. O segundo export **contém todo
o primeiro**. O hash é diferente, e todas as mensagens antigas entram duplicadas.

**Mitigação:** dedup em dois níveis — hash do arquivo (evita reprocessar) **e** hash
por mensagem (`grupo + timestamp + autor + conteúdo`) com índice único.

### 1.5 Embedding por mensagem individual arruína a busca

Mensagem de WhatsApp é curtíssima: "ok", "kkkk", "manda aí", "é isso". Vetorizar
cada uma isolada gera ruído — a busca recupera fragmentos sem sentido e o modelo
responde mal, mesmo com o RAG "funcionando".

**Mitigação:** agrupar mensagens em **janelas de conversa** (por proximidade de
tempo, ex. blocos de 10–15 min ou N mensagens) e embutir o bloco, guardando os ids
das mensagens de origem para citar depois. Muda o desenho da Fase 5 e o schema da
Fase 1 (tabela de `blocos`, não embedding na própria mensagem).

### 1.6 RLS não protege se o backend usar `service_role`

RLS no Supabase vale para quem acessa com a chave anon. Se o backend Node usar a
chave `service_role` — que é o normal — o RLS é **ignorado por completo**, e a
autorização passa a ser responsabilidade do código do backend.

**Mitigação:** decidir explicitamente quem fala com o banco. Sugestão: frontend lê
direto com anon + RLS (leitura), backend usa service_role só para ingestão. E o
backend precisa validar autorização por conta própria em cada rota.

### 1.7 LGPD: o brief trata como aviso, mas é mais que isso

Mensagens de várias pessoas e **gravações de voz** — voz identificável tende a ser
tratada como dado sensível. Três pontos que o campo "aviso" não cobre:

- **Terceiros citados:** quem não é do grupo mas é mencionado (cliente, fornecedor)
  não consentiu nada.
- **Revogação e exclusão:** membro que sai precisa poder pedir remoção dos dados dele.
- **Retenção:** guardar para sempre é difícil de justificar. Definir prazo.

**Mitigação:** registrar consentimento **por pessoa**, com data, base legal e versão
do texto; ter rotina de exclusão por titular; definir política de retenção antes de
ingerir o primeiro export.

### 1.8 Custo do Whisper sem teto

Grupo ativo com muito áudio pode custar bem mais que o esperado, e o brief só pede
o custo **depois**. Precisa de estimativa antes de processar (duração total dos
arquivos × preço/min), teto configurável e confirmação do usuário acima do teto.

### 1.9 Arquivo grande

Grupo antigo gera `.txt` de dezenas de MB. Ler tudo em memória e fazer split por
linha trava. O parser precisa ser **streaming**, processando linha a linha.

### 1.10 Outras variações que os testes precisam cobrir

- "Esta mensagem foi apagada" / mensagens editadas
- Caracteres invisíveis (LTR/RTL marks) que o WhatsApp insere no começo das linhas
- Mensagens de sistema em idiomas diferentes **do mesmo grupo** (cada export sai no
  idioma do celular de quem exportou)

## 2. Decisão que precisa ser tomada antes da Fase 1

**Qual Supabase?** Existem dois disponíveis:

| Opção | A favor | Contra |
|---|---|---|
| Supabase self-hosted no servidor 138.59.144.162 | dado sensível fica em casa; sem custo por volume; já tem `pgvector`; melhor defesa LGPD | RAM apertada (~2,3 GB livres); backup é responsabilidade nossa |
| Supabase da nuvem | zero manutenção, backup automático | voz e mensagens de terceiros num serviço externo; custo cresce com volume |

Recomendação: **self-hosted**, pelo tipo de dado — mas com banco separado, como foi
feito no ERAREASON, e só depois de resolver o backup.

## 3. Ordem de construção revisada

A ordem do brief está boa. Faço três ajustes:

| Fase | O quê | Entrega testável | Mudança |
|---|---|---|---|
| **0** | **Coletar exports reais**: iOS-pt, Android-pt e o que houver em inglês, com e sem mídia, + uma amostra de áudios | 4 arquivos em `/fixtures`, anonimizados se preciso | **NOVA** |
| 1 | Schema + RLS + tipos | SQL roda, tabelas criadas | += `pessoas`/`aliases`, `blocos`, dedup por mensagem |
| 2 | Parser + dedup | Testes passando nos 4 formatos reais | += extrair nome do arquivo de mídia; streaming |
| 3 | Estatísticas em SQL | Queries respondendo com dado real | sem mudança |
| 4 | Áudio (Whisper) | Áudios transcritos, sem duplicar | += estimativa de custo **antes** |
| 5 | IA: resumo + RAG | Pergunta em linguagem natural com citação | += embutir blocos, não mensagens |
| 6 | Frontend | Painel navegável com acesso controlado | sem mudança |

### Por que a Fase 0 existe

Escrever o parser sem um export real na mão é ficção: os testes ficam com o formato
que a gente **imagina**, não com o que o WhatsApp de fato gera. Como o parser é o
coração do projeto e tudo depois dele recebe o que ele produzir, meia hora coletando
arquivos de verdade economiza dias de retrabalho.

O ideal são exports do mesmo grupo feitos por celulares diferentes — é aí que
aparecem as divergências de nome de autor e de formato de data.
