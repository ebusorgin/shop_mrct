-- ============================================================
-- 034 — один номер накладной = один действующий документ.
-- Проверка в ingestWaybill даёт человекочитаемый 409, этот индекс —
-- страховка от гонки («два клика одновременно», два устройства):
-- уникальность по btrim(number) среди НЕотменённых накладных.
-- Отменённые ('reversed') номер не занимают — после отката документ
-- можно принять заново с тем же номером.
-- Если в исторических данных уже есть дубли — создание индекса пропускается
-- (миграция не должна ронять старт сервера); после чистки дублей
-- индекс можно завести вручную этим же create.
-- ============================================================

do $$
declare
  dups integer;
begin
  select count(*) into dups from (
    select btrim(number) as n
      from waybills
     where status <> 'reversed'
     group by btrim(number)
    having count(*) > 1
  ) d;
  if dups = 0 then
    create unique index if not exists waybills_number_active_uniq
      on waybills (btrim(number))
      where status <> 'reversed';
    raise notice '[migrate] 034: уникальный индекс по номеру накладной создан';
  else
    raise notice '[migrate] 034: дублей номеров: % — индекс НЕ создан, чисти данные и создай вручную', dups;
  end if;
end $$;
