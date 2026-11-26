-- V41 · Solicitudes y viajes de Traslados. Requiere V40 y conserva su bloqueo público.
begin;
set local lock_timeout = '3s';
set local statement_timeout = '30s';

do $$
begin
  if not exists (select 1 from pg_constraint
      where conrelid = 'public.transport_settings'::regclass
        and conname = 'transport_settings_requests_disabled_v40'
        and convalidated
        and pg_get_constraintdef(oid) = 'CHECK ((NOT requests_enabled))') then
    raise exception 'V41 requiere la protección de solicitudes públicas de V40';
  end if;
end $$;

create table public.transport_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.transport_settings(organization_id) on delete cascade,
  pickup text not null check (length(btrim(pickup)) between 1 and 200),
  destination text not null check (length(btrim(destination)) between 1 and 200),
  pickup_lat double precision,
  pickup_lng double precision,
  check ((pickup_lat is null and pickup_lng is null) or
    (pickup_lat is not null and pickup_lng is not null and pickup_lat between -90 and 90 and pickup_lng between -180 and 180)),
  schedule_kind text not null check (schedule_kind in ('now','10','20','30','60','scheduled')),
  pickup_at timestamptz not null,
  status text not null default 'pending' check (status in ('pending','delayed','confirmed','rejected','completed')),
  delay_minutes integer check (delay_minutes in (10,20,30,45,60)),
  amount numeric(12,2) check (amount between 0 and 99999999.99),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id,id)
);
create index transport_requests_org_updated on public.transport_requests(organization_id,updated_at desc);
create index transport_requests_org_created on public.transport_requests(organization_id,created_at desc);

create table public.transport_trips (
  request_id uuid primary key,
  organization_id uuid not null,
  foreign key (organization_id,request_id) references public.transport_requests(organization_id,id) on delete cascade,
  confirmed_at timestamptz not null,
  completed_at timestamptz,
  amount numeric(12,2) check (amount between 0 and 99999999.99)
);

-- La huella del comprobante queda fuera de la tabla publicada en Realtime.
create table public.transport_receipts (
  request_id uuid primary key references public.transport_requests(id) on delete cascade,
  receipt_hash bytea not null unique
);

alter table public.transport_requests enable row level security;
alter table public.transport_trips enable row level security;
alter table public.transport_receipts enable row level security;
revoke all on public.transport_requests, public.transport_trips, public.transport_receipts
  from public, anon, authenticated, service_role;
grant select on public.transport_requests, public.transport_trips to authenticated;

create function public.gestok_transport_can_drive(p_org uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and exists (
    select 1 from public.organizations o
    join public.organization_members m on m.organization_id = o.id
    join public.subscriptions s on s.organization_id = o.id
    where o.id = p_org and o.type = 'transport' and m.active and m.auth_user_id = auth.uid()
  ) and public.gestok_org_access_allowed(p_org);
$$;

create policy transport_member_read_requests on public.transport_requests
  for select to authenticated using ((select public.gestok_transport_can_drive(organization_id)));
create policy transport_member_read_trips on public.transport_trips
  for select to authenticated using ((select public.gestok_transport_can_drive(organization_id)));

create function public.gestok_transport_driver_settings(p_org uuid)
returns table(public_code uuid, requests_enabled boolean)
language sql stable security definer set search_path = '' as $$
  select s.public_code, s.requests_enabled from public.transport_settings s
  where s.organization_id = p_org and public.gestok_transport_can_drive(p_org);
$$;

create function public.gestok_transport_public_available(p_code uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.transport_settings s
    join public.organizations o on o.id = s.organization_id
    join public.subscriptions b on b.organization_id = o.id
    where s.public_code = p_code and s.requests_enabled and o.type = 'transport'
      and public.gestok_org_access_allowed(o.id)
  );
$$;

create function public.gestok_transport_request_status(p_code uuid,p_receipt text)
returns table(id uuid,status text,pickup_at timestamptz,delay_minutes integer,amount numeric,updated_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select r.id, r.status, r.pickup_at, r.delay_minutes, r.amount, r.updated_at
  from public.transport_receipts k
  join public.transport_requests r on r.id = k.request_id
  join public.transport_settings s on s.organization_id = r.organization_id
  join public.organizations o on o.id = r.organization_id
  where s.public_code = p_code and o.type = 'transport'
    and p_receipt ~ '^[a-f0-9]{64}$' and k.receipt_hash = sha256(convert_to(p_receipt,'UTF8'));
$$;

create function public.gestok_transport_submit(
  p_code uuid,p_receipt text,p_pickup text,p_destination text,
  p_lat double precision,p_lng double precision,p_schedule text,p_at timestamptz
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid;
  v_id uuid;
  v_hash bytea;
  v_now timestamptz := clock_timestamp();
  v_at timestamptz;
begin
  if p_receipt is null or p_receipt !~ '^[a-f0-9]{64}$' then
    raise exception 'Comprobante inválido';
  end if;
  select organization_id into v_org from public.transport_settings where public_code = p_code;
  if v_org is null then raise exception 'Las solicitudes están desactivadas'; end if;
  v_hash := sha256(convert_to(p_receipt,'UTF8'));

  -- Serializa el reintento con el mismo comprobante y el límite por organización.
  perform pg_advisory_xact_lock(hashtextextended(v_org::text,41341));
  select r.id into v_id from public.transport_receipts k
    join public.transport_requests r on r.id = k.request_id
    where k.receipt_hash = v_hash and r.organization_id = v_org;
  if found then return v_id; end if;
  if not public.gestok_transport_public_available(p_code) then
    raise exception 'Las solicitudes están desactivadas';
  end if;
  if (select count(*) from public.transport_requests
      where organization_id = v_org and created_at > v_now - interval '10 minutes') >= 30 then
    raise exception 'Hay muchas solicitudes recientes. Volvé a intentar más tarde';
  end if;
  if p_pickup is null or length(btrim(p_pickup)) not between 1 and 200
    or p_destination is null or length(btrim(p_destination)) not between 1 and 200 then
    raise exception 'Completá el punto de recogida y el destino';
  end if;

  if p_schedule = 'now' then
    v_at := v_now;
  elsif p_schedule in ('10','20','30','60') then
    v_at := v_now + make_interval(mins => p_schedule::integer);
  elsif p_schedule = 'scheduled' and p_at > v_now and isfinite(p_at) then
    v_at := p_at;
  else
    raise exception 'Elegí una fecha y hora futuras';
  end if;

  insert into public.transport_requests
    (organization_id,pickup,destination,pickup_lat,pickup_lng,schedule_kind,pickup_at)
    values (v_org,btrim(p_pickup),btrim(p_destination),p_lat,p_lng,p_schedule,v_at)
    returning id into v_id;
  insert into public.transport_receipts(request_id,receipt_hash) values(v_id,v_hash);
  return v_id;
end $$;

create function public.gestok_transport_driver_action(
  p_org uuid,p_request uuid,p_version timestamptz,p_action text,p_delay integer,p_amount numeric
)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_request public.transport_requests%rowtype;
  v_now timestamptz := clock_timestamp();
  v_status text;
  v_delay integer;
  v_amount numeric;
begin
  if not public.gestok_transport_can_drive(p_org) then
    raise exception 'Operación no autorizada' using errcode = '42501';
  end if;
  select * into v_request from public.transport_requests
    where id = p_request and organization_id = p_org for update;
  if not found then raise exception 'Pedido no disponible' using errcode = '42501'; end if;
  if v_request.updated_at is distinct from p_version then raise exception 'El pedido ya cambió'; end if;

  v_delay := v_request.delay_minutes;
  v_amount := v_request.amount;
  if p_action = 'delay' and v_request.status in ('pending','delayed','confirmed')
    and p_delay in (10,20,30,45,60) then
    v_status := case when v_request.status = 'confirmed' then 'confirmed' else 'delayed' end;
    v_delay := p_delay;
  elsif p_action = 'reject' and v_request.status in ('pending','delayed') then
    v_status := 'rejected';
    v_delay := null;
  elsif p_action = 'confirm' and v_request.status in ('pending','delayed') then
    v_status := 'confirmed';
    v_delay := null;
    v_amount := p_amount;
    insert into public.transport_trips(request_id,organization_id,confirmed_at,amount)
      values(p_request,p_org,v_now,v_amount);
  elsif p_action = 'complete' and v_request.status = 'confirmed' then
    v_status := 'completed';
    v_delay := null;
    v_amount := coalesce(p_amount,v_amount);
    update public.transport_trips set completed_at = v_now, amount = v_amount
      where request_id = p_request and organization_id = p_org;
    if not found then raise exception 'Viaje no disponible'; end if;
  else
    raise exception 'La acción no está disponible para este pedido';
  end if;
  update public.transport_requests set status = v_status, delay_minutes = v_delay, amount = v_amount,
    updated_at = greatest(v_now,v_request.updated_at + interval '1 microsecond')
    where id = p_request and organization_id = p_org;
end $$;

create function public.gestok_transport_driver_stats(p_org uuid)
returns table(completed bigint,rejected bigint,total_amount numeric)
language sql stable security definer set search_path = '' as $$
  select count(*) filter (where status = 'completed'), count(*) filter (where status = 'rejected'),
    coalesce(sum(amount) filter (where status = 'completed'),0)
  from public.transport_requests r
  where r.organization_id = p_org and public.gestok_transport_can_drive(p_org)
  having public.gestok_transport_can_drive(p_org);
$$;

revoke all on function public.gestok_transport_can_drive(uuid),
  public.gestok_transport_driver_settings(uuid),
  public.gestok_transport_public_available(uuid),
  public.gestok_transport_request_status(uuid,text),
  public.gestok_transport_submit(uuid,text,text,text,double precision,double precision,text,timestamptz),
  public.gestok_transport_driver_action(uuid,uuid,timestamptz,text,integer,numeric),
  public.gestok_transport_driver_stats(uuid) from public, anon, authenticated, service_role;
grant execute on function public.gestok_transport_can_drive(uuid),
  public.gestok_transport_driver_settings(uuid),
  public.gestok_transport_driver_action(uuid,uuid,timestamptz,text,integer,numeric),
  public.gestok_transport_driver_stats(uuid) to authenticated;
grant execute on function public.gestok_transport_public_available(uuid),
  public.gestok_transport_request_status(uuid,text),
  public.gestok_transport_submit(uuid,text,text,text,double precision,double precision,text,timestamptz)
  to anon, authenticated;

do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    raise exception 'No existe la publicación supabase_realtime';
  end if;
  if not exists (select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'transport_requests') then
    alter publication supabase_realtime add table public.transport_requests;
  end if;
end $$;

notify pgrst,'reload schema';
commit;
