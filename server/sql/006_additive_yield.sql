-- 006: добавка (role='additive') может иметь собственную уварку/выход yield_pct.
-- Семантика: qty_per_output — количество добавки в ГОТОВОМ (после её уварки) виде на 1 ед. выхода;
-- если yield_pct задан, сырой вход добавки = количество выхода × qty_per_output ÷ (yield_pct/100).
-- Без yield_pct добавка расходуется 1:1 (как раньше).

alter table semi_inputs drop constraint if exists semi_inputs_check;
alter table semi_inputs add constraint semi_inputs_check check (
    (role = 'base'     and yield_pct is not null and qty_per_output is null) or
    (role = 'additive' and qty_per_output is not null
        and (yield_pct is null or (yield_pct > 0 and yield_pct <= 100)))
  );

comment on column semi_inputs.yield_pct is 'base: выход после уварки/очистки, %; additive (опц.): выход своей уварки, % — сырой вход делится на него';
