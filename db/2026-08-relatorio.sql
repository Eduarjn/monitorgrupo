-- ============================================================================
-- Relatorio executivo em Markdown (18/08/2026)
--
-- Nova natureza de consulta: 'relatorio'. O SQL apura TODOS os agregados e a
-- IA escreve a leitura de negocio por nicho. O modelo nunca calcula numero.
-- `parametro` guarda o nicho do cliente (provedor, imobiliaria, saude, varejo).
-- ============================================================================

alter table consultas drop constraint if exists consultas_natureza_check;
alter table consultas add constraint consultas_natureza_check
  check (natureza in ('metrica', 'pergunta', 'mista', 'relatorio'));

alter table consultas drop constraint if exists consultas_visual_check;
alter table consultas add constraint consultas_visual_check
  check (visual in ('auto', 'numero', 'barra', 'linha', 'pizza', 'tabela', 'texto', 'markdown'));

-- Card padrao, global. O nicho fica em `parametro` e o usuario ajusta por grupo.
insert into consultas (grupo_id, titulo, descricao, natureza, parametro, visual, dias, icone, ordem)
select null, 'Relatorio executivo',
       'Dashboard completo em Markdown, com graficos e alertas do nicho. Numeros apurados no banco.',
       'relatorio', 'geral', 'markdown', 30, 'file-text', 5
where not exists (select 1 from consultas where natureza = 'relatorio');
