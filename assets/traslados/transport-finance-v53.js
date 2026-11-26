(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const paymentLabels = { cash: 'Efectivo', transfer: 'Transferencia', qr: 'QR', other: 'Otro' };
  const categories = { fuel: 'Combustible', maintenance: 'Mantenimiento', parking: 'Estacionamiento', tolls: 'Peajes', other: 'Otro' };
  const historyLabels = { completed: 'Realizado', cancelled: 'Cancelado', rejected: 'Rechazado' };
  const weekdays = ['Lunes','Martes','Miércoles','Jueves','Viernes','Sábado','Domingo'];
  const money = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' });
  const dateTime = new Intl.DateTimeFormat('es-AR', {
    dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Argentina/Buenos_Aires',
  });
  const dateOnly = new Intl.DateTimeFormat('es-AR', { dateStyle: 'medium', timeZone: 'UTC' });
  const metricIds = {
    day: ['transportDailyIncome','transportDailyExpenses','transportDailyNet','transportDailyTrips','transportDailyPending'],
    stats: ['transportStatsIncome','transportStatsExpenses','transportStatsNet','transportStatsTrips','transportStatsAverage',
      'transportStatsPeakHour','transportStatsPeakDay'],
  };
  const listings = {
    history: { list: 'transportHistoryList', more: 'transportMoreHistory' },
    expenses: { list: 'transportExpensesList', more: 'transportMoreExpenses' },
  };

  function node(tag, text, className) {
    const item = document.createElement(tag);
    item.textContent = text;
    if (className) item.className = className;
    return item;
  }

  async function dataOf(request) {
    const { data, error } = await request;
    if (error) throw error;
    return data;
  }

  function updateMetrics(ids, values) {
    ids.forEach((id, index) => { $(id).textContent = values[index] ?? '—'; });
  }

  function historyCard(row) {
    const card = node('article', '', 'transport-order');
    const details = document.createElement('details');
    const method = paymentLabels[row.payment_method] || 'Sin medio registrado';
    details.append(node('summary', [row.pickup + ' → ' + row.destination, historyLabels[row.status],
      row.amount != null ? money.format(row.amount) : null].filter(Boolean).join(' · ')));
    details.append(node('p', 'Origen del registro: ' + (row.source === 'manual' ? 'Manual' : 'Enlace de pasajeros')));
    details.append(node('p', 'Fecha del viaje o respuesta: ' + dateTime.format(new Date(row.recorded_at))));
    if (row.source === 'public') details.append(node('p', 'Recogida solicitada: ' + dateTime.format(new Date(row.pickup_at))));
    if (row.status === 'completed') details.append(node('p', 'Medio de pago: ' + method));
    card.append(details);
    return card;
  }

  function expenseCard(row) {
    const card = node('article', '', 'transport-order');
    const title = row.category === 'other' ? row.description : categories[row.category];
    card.append(node('h3', title));
    card.append(node('p', dateTime.format(new Date(row.occurred_at)) + ' · ' + money.format(row.amount)));
    if (row.category !== 'other' && row.description) card.append(node('p', row.description));
    return card;
  }

  function drawChart(series, range = '') {
    const chart = $('transportChart');
    const scroll = chart.scrollLeft;
    const max = Math.max(1, ...series.flatMap(row => [Number(row.income), Number(row.expenses)]));
    const groups = [];
    const data = [];
    let latest;
    for (const row of series) {
      const group = node('div', '', 'transport-bar-group');
      group.setAttribute('aria-hidden', 'true');
      const pair = node('div', '', 'transport-bar-pair');
      for (const amount of [row.income, row.expenses]) {
        const bar = node('span', '', 'transport-bar');
        bar.style.height = (Number(amount) / max * 100) + '%';
        pair.append(bar);
      }
      group.append(pair, node('span', row.label));
      groups.push(group);
      if (Number(row.income) || Number(row.expenses) || Number(row.trips)) latest = group;
      data.push(node('li', row.label + ' · Ingresos ' + money.format(row.income) +
        ' · Egresos ' + money.format(row.expenses) + ' · Viajes ' + row.trips));
    }
    chart.replaceChildren(...groups);
    $('transportChartData').replaceChildren(...data);
    chart.scrollLeft = chart.dataset.range === range ? scroll
      : latest ? latest.offsetLeft - (chart.clientWidth - latest.offsetWidth) / 2 : 0;
    chart.dataset.range = range;
  }

  function create(sb, current, notice) {
    const dialog = $('transportEntryDialog');
    const entryForm = $('transportEntryForm');
    const filterForm = $('transportHistoryFilters');
    const entryFeedback = $('transportEntryFeedback');

    function valid(session) { return current() === session; }

    async function loadSummary(session, daily) {
      const view = daily ? 'home' : 'stats';
      const finance = session.finance;
      const serial = ++finance.summaryVersion;
      const period = daily ? 'day' : $('transportStatsPeriod').value;
      const anchor = daily ? null : $('transportStatsDate').value || null;
      try {
        const row = await dataOf(sb.rpc('gestok_transport_finance_v42', {
          p_org: session.orgId, p_period: period, p_anchor: anchor,
        }));
        if (!valid(session) || session.view !== view || serial !== finance.summaryVersion) return;
        const base = [money.format(row.income), money.format(row.expenses), money.format(row.net), row.trips];
        if (daily) {
          updateMetrics(metricIds.day, [...base, row.pending]);
          return;
        }
        updateMetrics(metricIds.stats, [...base, row.average == null ? null : money.format(row.average),
          row.peak_hour == null ? null : String(row.peak_hour).padStart(2, '0') + ':00', weekdays[row.peak_weekday - 1]]);
        const start = dateOnly.format(new Date(row.from));
        $('transportStatsRange').textContent = row.from === row.through
          ? start : start + ' – ' + dateOnly.format(new Date(row.through));
        $('transportStatsLegacy').hidden = !row.unpriced;
        $('transportStatsLegacy').textContent = row.unpriced ? row.unpriced + ' viajes históricos sin importe registrado.' : '';
        drawChart(row.series, period + ':' + row.from);
      } catch {
        if (!valid(session) || session.view !== view || serial !== finance.summaryVersion) return;
        if (daily) updateMetrics(metricIds.day, []);
        else {
          updateMetrics(metricIds.stats, []);
          $('transportStatsRange').textContent = '';
          $('transportStatsLegacy').hidden = true;
          drawChart([]);
        }
        notice(session, 'No se pudo consultar el balance de Traslados.');
      }
    }

    async function loadList(session, view, reset) {
      const isHistory = view === 'history';
      const state = session.finance[view];
      const serial = ++state.serial;
      const offset = reset ? 0 : state.offset;
      const list = $(listings[view].list);
      const more = $(listings[view].more);
      more.disabled = true;
      try {
        const query = isHistory
          ? sb.rpc('gestok_transport_history_v42', {
              p_org: session.orgId, p_from: $('transportHistoryFrom').value || null,
              p_to: $('transportHistoryTo').value || null,
              p_status: $('transportHistoryStatus').value || null,
              p_payment: $('transportHistoryPayment').value || null, p_offset: offset,
            })
          : sb.from('transport_expenses').select('id,category,description,amount,occurred_at')
              .eq('organization_id', session.orgId).order('occurred_at', { ascending: false })
              .order('id').range(offset, offset + 20);
        const rows = await dataOf(query);
        if (!valid(session) || session.view !== view || serial !== state.serial) return;
        if (reset) list.replaceChildren();
        list.append(...rows.slice(0, 20).map(isHistory ? historyCard : expenseCard));
        if (reset && !rows.length) list.append(node('p', isHistory ? 'No hay viajes con estos filtros.' : 'Todavía no hay gastos registrados.'));
        state.offset = offset + Math.min(rows.length, 20);
        more.hidden = rows.length <= 20;
      } catch {
        if (valid(session) && session.view === view && serial === state.serial) {
          if (reset) {
            list.replaceChildren();
            state.offset = 0;
            more.hidden = true;
          }
          notice(session, isHistory ? 'No se pudo actualizar el historial.' : 'No se pudieron cargar los gastos.');
        }
      } finally {
        if (valid(session) && serial === state.serial) more.disabled = false;
      }
    }

    function configureEntry(session) {
      const expense = session.finance.entry.kind === 'expense';
      const paidTrip = !expense && $('transportEntryStatus').value === 'completed';
      $('transportEntryTrip').hidden = expense;
      $('transportEntryExpense').hidden = !expense;
      for (const id of ['transportEntryPickup', 'transportEntryDestination']) $(id).required = !expense;
      $('transportEntryDescription').required = expense && $('transportEntryCategory').value === 'other';
      $('transportEntryAmountField').hidden = !expense && !paidTrip;
      $('transportEntryAmount').disabled = !expense && !paidTrip;
      $('transportEntryAmount').required = expense || paidTrip;
      $('transportEntryAmount').min = expense ? '0.01' : '0';
      $('transportEntryPaymentField').hidden = !paidTrip;
      $('transportEntryPayment').disabled = !paidTrip;
      $('transportEntryPayment').required = paidTrip;
    }

    function openEntry(session, kind) {
      if (!valid(session) || !['trip','expense'].includes(kind)) return;
      session.finance.entry = { kind, key: crypto.randomUUID(), saving: false };
      entryForm.reset();
      const localDate = new Date(Date.now() - new Date().getTimezoneOffset() * 60_000);
      $('transportEntryDate').value = localDate.toISOString().slice(0,16);
      $('transportEntryTitle').textContent = kind === 'expense' ? 'Registrar gasto' : 'Registrar viaje manual';
      $('transportEntrySubmit').disabled = false;
      $('transportEntryCancel').disabled = false;
      entryFeedback.textContent = '';
      configureEntry(session);
      dialog.showModal();
    }

    $('transportApp').addEventListener('click', event => {
      const button = event.target.closest('[data-transport-entry]');
      const session = current();
      if (session && button) openEntry(session, button.dataset.transportEntry);
    });
    for (const id of ['transportEntryStatus','transportEntryCategory']) {
      $(id).onchange = () => { const session = current(); if (session?.finance.entry) configureEntry(session); };
    }
    $('transportEntryCancel').onclick = () => dialog.close();
    dialog.addEventListener('cancel', event => {
      if (current()?.finance.entry?.saving) event.preventDefault();
    });
    entryForm.onsubmit = async event => {
      event.preventDefault();
      const session = current();
      const entry = session?.finance.entry;
      if (!entry || entry.saving) return;
      const at = new Date($('transportEntryDate').value);
      if (!Number.isFinite(at.getTime()) || at.getTime() > Date.now()) {
        entryFeedback.textContent = 'Elegí una fecha y hora que ya hayan pasado.';
        return;
      }
      const expense = entry.kind === 'expense';
      const amount = $('transportEntryAmount');
      const args = {
        p_id: entry.key, p_org: session.orgId, p_at: at.toISOString(),
        p_amount: amount.disabled ? null : Number(amount.value),
      };
      const rpc = expense ? 'gestok_transport_add_expense_v42' : 'gestok_transport_manual_trip_v42';
      if (expense) {
        args.p_category = $('transportEntryCategory').value;
        args.p_description = $('transportEntryDescription').value;
      } else {
        args.p_pickup = $('transportEntryPickup').value;
        args.p_destination = $('transportEntryDestination').value;
        args.p_status = $('transportEntryStatus').value;
        args.p_payment = $('transportEntryPayment').value || null;
      }
      const submit = $('transportEntrySubmit');
      const cancel = $('transportEntryCancel');
      entry.saving = true;
      submit.disabled = true;
      cancel.disabled = true;
      entryFeedback.textContent = '';
      try {
        await dataOf(sb.rpc(rpc, args));
        if (!valid(session) || session.finance.entry !== entry) return;
        dialog.close();
        notice(session, expense ? 'Gasto registrado.' : 'Viaje registrado.');
        show(session, session.view);
      } catch {
        if (valid(session) && session.finance.entry === entry) {
          entryFeedback.textContent = 'No se pudo confirmar el registro. Revisá los datos y reintentá en este formulario.';
        }
      } finally {
        entry.saving = false;
        if (valid(session) && session.finance.entry === entry) {
          submit.disabled = false;
          cancel.disabled = false;
        }
      }
    };

    for (const [view, config] of Object.entries(listings)) {
      $(config.more).onclick = () => { const session = current(); if (session) void loadList(session, view, false); };
    }
    filterForm.onsubmit = event => {
      event.preventDefault();
      const session = current();
      if (!session) return;
      const from = $('transportHistoryFrom').value;
      const to = $('transportHistoryTo').value;
      if (from && to && from > to) {
        notice(session, 'La fecha Desde debe ser anterior o igual a Hasta.');
        return;
      }
      notice(session, '');
      void loadList(session, 'history', true);
    };
    filterForm.onreset = () => setTimeout(() => {
      const session = current();
      if (session?.view === 'history') {
        notice(session, '');
        void loadList(session, 'history', true);
      }
    },0);
    for (const id of ['transportStatsPeriod','transportStatsDate']) {
      $(id).onchange = () => { const session = current(); if (session) void loadSummary(session, false); };
    }

    function show(session, view) {
      if (view === 'home' || view === 'stats') void loadSummary(session, view === 'home');
      if (view === 'history' || view === 'expenses') void loadList(session, view, true);
    }

    function updated(session, refreshHistory = false) {
      if (session.view === 'home' || session.view === 'stats') show(session, session.view);
      if (refreshHistory && session.view === 'history' && session.finance.history.offset <= 20) show(session, 'history');
    }

    function start(session) {
      session.finance = { summaryVersion: 0, history: { serial: 0, offset: 0 }, expenses: { serial: 0, offset: 0 } };
    }

    function stop() {
      dialog.close();
      entryForm.reset();
      entryFeedback.textContent = '';
      filterForm.reset();
      $('transportStatsPeriod').value = 'day';
      $('transportStatsDate').value = '';
      $('transportStatsRange').textContent = '';
      $('transportStatsLegacy').hidden = true;
      for (const ids of Object.values(metricIds)) updateMetrics(ids, []);
      for (const config of Object.values(listings)) {
        $(config.list).replaceChildren();
        $(config.more).hidden = true;
      }
      drawChart([]);
    }

    return { start, stop, show, updated };
  }

  window.GestokTransportFinance = { create };
})();
