-- V42 · Operación y finanzas de Traslados. Aplicar después de V40 y V41.
begin;
set local lock_timeout = '3s';
set local statement_timeout = '30s';

alter table public.transport_requests
  add column source text not null default 'public' check (source in ('public','manual'));
alter table public.transport_requests drop constraint transport_requests_status_check;
alter table public.transport_requests add constraint transport_requests_status_check
  check (status in ('pending','delayed','confirmed','rejected','completed','cancelled'));

alter table public.transport_trips add column payment_method text
  check (payment_method in ('cash','transfer','qr','other'));
create index transport_trips_org_completed_v42
  on public.transport_trips(organization_id,completed_at) where completed_at is not null;

-- Los viajes históricos conservan sus importes y el medio desconocido.
-- Las finalizaciones nuevas requieren importe y método, incluso desde un cliente V41 en caché.
create function public.gestok_transport_require_payment_v42()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.completed_at is not null and (new.amount is null or new.payment_method is null) then
    raise exception 'La finalización requiere importe y medio de pago';
  end if;
  return new;
end $$;
revoke all on function public.gestok_transport_require_payment_v42() from public, anon, authenticated, service_role;
create trigger transport_trips_require_payment_v42
  before insert or update of completed_at,payment_method,amount on public.transport_trips
  for each row execute function public.gestok_transport_require_payment_v42();

create table public.transport_expenses (
  id uuid primary key,
  organization_id uuid not null references public.transport_settings(organization_id) on delete cascade,
  category text not null check (category in ('fuel','maintenance','parking','tolls','other')),
  description text check (length(description) between 1 and 200),
  check (category <> 'other' or description is not null),
  amount numeric(12,2) not null check (amount > 0 and amount <= 99999999.99),
  occurred_at timestamptz not null check (isfinite(occurred_at)),
  created_at timestamptz not null default now()
);
create index transport_expenses_org_date_v42
  on public.transport_expenses(organization_id,occurred_at desc,id);
alter table public.transport_expenses enable row level security;
revoke all on public.transport_expenses from public, anon, authenticated, service_role;
grant select on public.transport_expenses to authenticated;
create policy transport_member_read_expenses_v42 on public.transport_expenses
  for select to authenticated using ((select public.gestok_transport_can_drive(organization_id)));

create function public.gestok_transport_close_v42(
  p_org uuid,p_request uuid,p_version timestamptz,p_outcome text,p_amount numeric,p_payment text
)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_request public.transport_requests%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  if not public.gestok_transport_can_drive(p_org) then
    raise exception 'Operación no autorizada' using errcode = '42501';
  end if;
  if p_outcome is null or p_outcome not in ('completed','cancelled') then
    raise exception 'Resultado inválido';
  end if;
  if p_outcome = 'completed' and (
      p_amount is null or p_amount not between 0 and 99999999.99 or trunc(p_amount,2) <> p_amount
      or p_payment is null or p_payment not in ('cash','transfer','qr','other')) then
    raise exception 'Ingresá un importe válido y elegí un medio de pago';
  end if;

  select * into v_request from public.transport_requests
    where id = p_request and organization_id = p_org for update;
  if not found then raise exception 'Pedido no disponible' using errcode = '42501'; end if;

  if v_request.status = p_outcome and (
    p_outcome = 'cancelled' or exists (select 1 from public.transport_trips
      where request_id = p_request and organization_id = p_org and completed_at is not null
        and amount = p_amount and payment_method = p_payment)) then
    return;
  end if;
  if v_request.status <> 'confirmed' or v_request.updated_at is distinct from p_version then
    raise exception 'El viaje ya cambió. Revisá su estado';
  end if;
  if p_outcome = 'completed' then
    update public.transport_trips set completed_at = v_now, amount = p_amount, payment_method = p_payment
      where request_id = p_request and organization_id = p_org and completed_at is null;
    if not found then raise exception 'Viaje no disponible'; end if;
  end if;
  update public.transport_requests set status = p_outcome, delay_minutes = null,
    amount = case when p_outcome = 'completed' then p_amount end,
    updated_at = greatest(v_now,v_request.updated_at + interval '1 microsecond')
    where id = p_request and organization_id = p_org;
end $$;

create function public.gestok_transport_manual_trip_v42(
  p_org uuid,p_id uuid,p_pickup text,p_destination text,p_at timestamptz,
  p_status text,p_amount numeric,p_payment text
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
begin
  if not public.gestok_transport_can_drive(p_org) then
    raise exception 'Operación no autorizada' using errcode = '42501';
  end if;
  if p_id is null or p_at is null or not isfinite(p_at) or p_at > now()
    or p_status is null or p_status not in ('completed','cancelled') then
    raise exception 'Fecha o estado del viaje inválido';
  end if;
  if p_status = 'completed' and (
    p_amount is null or p_amount not between 0 and 99999999.99 or trunc(p_amount,2) <> p_amount
    or p_payment is null or p_payment not in ('cash','transfer','qr','other')) then
    raise exception 'Ingresá un importe válido y elegí un medio de pago';
  end if;
  if p_status = 'cancelled' then
    p_amount := null;
    p_payment := null;
  end if;

  insert into public.transport_requests
    (id,organization_id,pickup,destination,schedule_kind,pickup_at,status,amount,source)
    values (p_id,p_org,btrim(p_pickup),btrim(p_destination),'scheduled',p_at,p_status,p_amount,'manual')
    on conflict (id) do nothing returning id into v_id;
  if v_id is null then
    if exists (select 1 from public.transport_requests r
      left join public.transport_trips t on t.organization_id = r.organization_id and t.request_id = r.id
      where r.id = p_id and r.organization_id = p_org and r.source = 'manual'
        and r.pickup = btrim(p_pickup) and r.destination = btrim(p_destination)
        and r.pickup_at = p_at and r.status = p_status and r.amount is not distinct from p_amount
        and t.payment_method is not distinct from p_payment) then
      return p_id;
    end if;
    raise exception 'El identificador ya corresponde a otra operación';
  end if;
  if p_status = 'completed' then
    insert into public.transport_trips(request_id,organization_id,confirmed_at,completed_at,amount,payment_method)
      values (p_id,p_org,p_at,p_at,p_amount,p_payment);
  end if;
  return p_id;
end $$;

create function public.gestok_transport_add_expense_v42(
  p_org uuid,p_id uuid,p_category text,p_description text,p_amount numeric,p_at timestamptz
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
begin
  if not public.gestok_transport_can_drive(p_org) then
    raise exception 'Operación no autorizada' using errcode = '42501';
  end if;
  if p_id is null or p_at is null or not isfinite(p_at) or p_at > now() or p_amount is null
    or p_amount <= 0 or p_amount > 99999999.99 or trunc(p_amount,2) <> p_amount then
    raise exception 'Fecha o importe del gasto inválido';
  end if;

  p_description := nullif(btrim(p_description),'');
  insert into public.transport_expenses(id,organization_id,category,description,amount,occurred_at)
    values(p_id,p_org,p_category,p_description,p_amount,p_at)
    on conflict (id) do nothing returning id into v_id;
  if v_id is null and not exists (
    select 1 from public.transport_expenses
    where id = p_id and organization_id = p_org and category = p_category
      and description is not distinct from p_description and amount = p_amount and occurred_at = p_at
  ) then raise exception 'El identificador ya corresponde a otra operación'; end if;
  return p_id;
end $$;

create function public.gestok_transport_history_v42(
  p_org uuid,p_from date,p_to date,p_status text,p_payment text,p_offset integer
)
returns table(id uuid,pickup text,destination text,pickup_at timestamptz,status text,
  source text,recorded_at timestamptz,amount numeric,payment_method text)
language sql stable security definer set search_path = '' as $$
  select r.id,r.pickup,r.destination,r.pickup_at,r.status,r.source,d.recorded_at,
    case when r.status = 'completed' then t.amount end,t.payment_method
  from public.transport_requests r
  left join public.transport_trips t on t.organization_id = r.organization_id and t.request_id = r.id
  cross join lateral (select coalesce(t.completed_at,
    case when r.source = 'manual' then r.pickup_at else r.updated_at end) as recorded_at) d
  where r.organization_id = p_org and public.gestok_transport_can_drive(p_org)
    and r.status in ('completed','cancelled','rejected')
    and (p_status is null or r.status = p_status)
    and (p_payment is null or t.payment_method = p_payment or
      (p_payment = 'unknown' and r.status = 'completed' and t.payment_method is null))
    and (p_from is null or d.recorded_at >= p_from::timestamp at time zone 'America/Argentina/Buenos_Aires')
    and (p_to is null or d.recorded_at < (p_to + 1)::timestamp at time zone 'America/Argentina/Buenos_Aires')
  order by d.recorded_at desc,r.id
  limit 21 offset greatest(coalesce(p_offset,0),0);
$$;

create function public.gestok_transport_finance_v42(p_org uuid,p_period text,p_anchor date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_zone constant text := 'America/Argentina/Buenos_Aires';
  v_start timestamp;
  v_end timestamp;
  v_anchor date := coalesce(p_anchor,(now() at time zone v_zone)::date);
  v_group text := case when p_period = 'day' then 'hour' else 'day' end;
  v_step interval := case when p_period = 'day' then interval '1 hour' else interval '1 day' end;
  v_result jsonb;
begin
  if not public.gestok_transport_can_drive(p_org) then
    raise exception 'Operación no autorizada' using errcode = '42501';
  end if;
  if p_period is null or p_period not in ('day','week','month') or not isfinite(v_anchor) then
    raise exception 'Período inválido';
  end if;
  v_start := date_trunc(p_period,v_anchor::timestamp);
  v_end := v_start + case p_period when 'day' then interval '1 day' when 'week' then interval '1 week' else interval '1 month' end;

  with trips as (
    select completed_at at time zone v_zone as local_time,amount
    from public.transport_trips where organization_id = p_org
      and completed_at >= v_start at time zone v_zone and completed_at < v_end at time zone v_zone
  ), expenses as (
    select occurred_at at time zone v_zone as local_time,amount
    from public.transport_expenses where organization_id = p_org
      and occurred_at >= v_start at time zone v_zone and occurred_at < v_end at time zone v_zone
  ), income_groups as (
    select date_trunc(v_group,local_time) as bucket,coalesce(sum(amount),0) as total,count(*) as trips
    from trips group by 1
  ), expense_groups as (
    select date_trunc(v_group,local_time) as bucket,sum(amount) as total from expenses group by 1
  ), totals as (
    select count(*) as trips,count(*) filter (where amount is null) as unpriced,
      coalesce(sum(amount),0) as income from trips
  )
  select jsonb_build_object(
    'from',v_start::date,'through',(v_end - interval '1 day')::date,
    'income',t.income,'expenses',e.total,'net',t.income - e.total,
    'trips',t.trips,'unpriced',t.unpriced,
    'average',case when t.trips > t.unpriced then round(t.income / (t.trips-t.unpriced),2) end,
    'pending',(select count(*) from public.transport_requests
      where organization_id = p_org and status in ('pending','delayed')),
    'peak_hour',(select extract(hour from local_time)::integer from trips group by 1 order by count(*) desc,1 limit 1),
    'peak_weekday',(select extract(isodow from local_time)::integer from trips group by 1 order by count(*) desc,1 limit 1),
    'series',(select jsonb_agg(jsonb_build_object(
        'label',to_char(b.bucket,case when p_period = 'day' then 'HH24:MI' else 'DD/MM' end),
        'income',coalesce(i.total,0),'expenses',coalesce(x.total,0),'trips',coalesce(i.trips,0)
      ) order by b.bucket)
      from generate_series(v_start,v_end-v_step,v_step) b(bucket)
      left join income_groups i on i.bucket = b.bucket
      left join expense_groups x on x.bucket = b.bucket)
  ) into v_result
  from totals t cross join (select coalesce(sum(amount),0) as total from expenses) e;
  return v_result;
end $$;

revoke all on function public.gestok_transport_close_v42(uuid,uuid,timestamptz,text,numeric,text),
  public.gestok_transport_manual_trip_v42(uuid,uuid,text,text,timestamptz,text,numeric,text),
  public.gestok_transport_add_expense_v42(uuid,uuid,text,text,numeric,timestamptz),
  public.gestok_transport_history_v42(uuid,date,date,text,text,integer),
  public.gestok_transport_finance_v42(uuid,text,date) from public, anon, authenticated, service_role;
grant execute on function public.gestok_transport_close_v42(uuid,uuid,timestamptz,text,numeric,text),
  public.gestok_transport_manual_trip_v42(uuid,uuid,text,text,timestamptz,text,numeric,text),
  public.gestok_transport_add_expense_v42(uuid,uuid,text,text,numeric,timestamptz),
  public.gestok_transport_history_v42(uuid,date,date,text,text,integer),
  public.gestok_transport_finance_v42(uuid,text,date) to authenticated;

notify pgrst,'reload schema';
commit;
