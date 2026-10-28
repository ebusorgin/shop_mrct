-- 002: полуфабрикат может делаться из ДРУГИХ полуфабрикатов.
-- semi_inputs.product_id -> полиморфный (source_type, ref_id) по образцу tech_card_items.

alter table semi_inputs add column if not exists source_type text not null default 'raw'
  check (source_type in ('raw','semi'));
alter table semi_inputs add column if not exists ref_id int;

-- переносим существующие связи (все они были сырьём)
update semi_inputs set ref_id = product_id where ref_id is null;

-- убираем старый FK и колонку product_id
alter table semi_inputs drop constraint if exists semi_inputs_product_id_fkey;
alter table semi_inputs drop column if exists product_id;

alter table semi_inputs alter column ref_id set not null;

comment on column semi_inputs.source_type is 'raw = складское сырьё (products.id), semi = другой полуфабрикат (semi_products.id)';
