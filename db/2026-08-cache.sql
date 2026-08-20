-- Cache da narrativa do relatório executivo.
--
-- O relatório só muda quando chega mensagem nova. Sem cache, abrir o mesmo card
-- três vezes numa reunião custava três chamadas de modelo — e devolvia três
-- textos ligeiramente diferentes para os mesmos números, o que é pior ainda:
-- o gestor não entende por que o relatório "mudou de opinião" sem nada ter
-- acontecido.
--
-- Guarda só a NARRATIVA (resumo, alertas, recomendações). Os números não entram
-- aqui: eles são recalculados sempre, porque são baratos e precisam estar certos.

begin;

create table if not exists relatorio_cache (
  grupo_id   bigint not null references grupos(id) on delete cascade,
  -- nicho|dias|total|participantes|inatividade|alertas — muda o dado, muda a chave
  chave      text   not null,
  narrativa  jsonb  not null,
  criado_em  timestamptz not null default now(),
  primary key (grupo_id, chave)
);

comment on table relatorio_cache is
  'Narrativa de IA do relatorio executivo. Descartavel: perder isto so custa uma chamada de modelo.';

-- A leitura filtra por idade; o índice evita varrer o histórico inteiro.
create index if not exists relatorio_cache_idade_idx on relatorio_cache (criado_em);

-- Segue a mesma política de isolamento das demais tabelas: o cache carrega
-- texto derivado de mensagem de cliente, então não pode vazar entre grupos.
alter table relatorio_cache enable row level security;

commit;
