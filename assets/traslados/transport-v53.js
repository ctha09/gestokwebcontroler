(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const statusNames = {
    pending: 'Pendiente', delayed: 'Demora informada', confirmed: 'Confirmado',
    rejected: 'Rechazado', completed: 'Completado', cancelled: 'Cancelado',
  };
  const actionNames = { confirm: 'Confirmar', reject: 'Rechazar', delay: 'Informar demora',
    complete: 'Completar viaje', cancel: 'Cancelar viaje' };
  const terminal = status => ['completed', 'rejected', 'cancelled'].includes(status);
  const dateFormat = new Intl.DateTimeFormat('es-AR', { dateStyle: 'medium', timeStyle: 'short' });
  const money = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' });
  const codeFormat = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const assets = new Map();

  function loadAsset(path, stylesheet = false) {
    if (assets.has(path)) return assets.get(path);
    const promise = new Promise((resolve, reject) => {
      const node = document.createElement(stylesheet ? 'link' : 'script');
      if (stylesheet) {
        node.rel = 'stylesheet';
        node.href = path;
      } else node.src = path;
      node.onload = resolve;
      node.onerror = () => {
        assets.delete(path);
        node.remove();
        reject(new Error('Recurso no disponible'));
      };
      document.head.append(node);
    });
    assets.set(path, promise);
    return promise;
  }

  async function checked(request) {
    const { data, error } = await request;
    if (error) throw error;
    return data;
  }

  function el(tag, text, className) {
    const node = document.createElement(tag);
    node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  function createDriver(sb) {
    const form = $('transportActionForm');
    const dialog = $('transportActionDialog');
    const soundButton = $('transportSound');
    const cancelAction = $('transportActionCancel');
    let scope;
    const finance = window.GestokTransportFinance.create(sb, () => scope, notice);

    function notice(session, message) {
      if (scope !== session) return;
      const node = $('transportDriverNotice');
      node.textContent = message;
      node.hidden = !message;
    }

    function stop() {
      if (!scope) return;
      const session = scope;
      scope = null;
      finance.stop();
      clearInterval(session.timer);
      if (session.channel) void sb.removeChannel(session.channel);
      if (session.map) session.map.remove();
      if (session.audio) void session.audio.close().catch(() => {});
      dialog.close();
      form.reset();
      $('transportActionTitle').textContent = '';
      $('transportMapStatus').textContent = 'Los pedidos con ubicación compartida aparecen en el mapa.';
      soundButton.setAttribute('aria-pressed', 'false');
      soundButton.textContent = 'Activar sonido';
      $('transportPending').replaceChildren();
      $('transportDriverNotice').hidden = true;
      $('transportDriverNotice').textContent = '';
      $('transportLinkControls').hidden = true;
      $('transportQr').hidden = true;
      $('transportQr').removeAttribute('src');
      $('transportShareUrl').value = '';
      $('transportShareFeedback').textContent = '';
    }

    function playNotification(session) {
      if (session.audio?.state !== 'running') return;
      const tone = session.audio.createOscillator();
      const volume = session.audio.createGain();
      const time = session.audio.currentTime;
      tone.frequency.setValueAtTime(660, time);
      tone.frequency.setValueAtTime(880, time + 0.12);
      volume.gain.setValueAtTime(0.08, time);
      volume.gain.exponentialRampToValueAtTime(0.001, time + 0.32);
      tone.connect(volume).connect(session.audio.destination);
      tone.start(time);
      tone.stop(time + 0.33);
    }

    soundButton.onclick = async () => {
      const session = scope;
      if (!session) return;
      try {
        if (session.audio?.state === 'running') await session.audio.suspend();
        else {
          session.audio ??= new AudioContext();
          await session.audio.resume();
        }
        if (scope !== session) return;
        const on = session.audio.state === 'running';
        soundButton.setAttribute('aria-pressed', String(on));
        soundButton.textContent = on ? 'Silenciar avisos' : 'Activar sonido';
      } catch {
        notice(session, 'El navegador no pudo activar el sonido.');
      }
    };

    function chooseAction(session, row, action) {
      session.action = { row, action };
      form.reset();
      const withAmount = action === 'confirm' || action === 'complete';
      const complete = action === 'complete';
      $('transportActionTitle').textContent = actionNames[action];
      $('transportDelayField').hidden = action !== 'delay';
      $('transportAmountField').hidden = !withAmount;
      $('transportAmount').disabled = !withAmount;
      $('transportAmount').required = complete;
      $('transportAmount').value = withAmount && row.amount != null ? row.amount : '';
      $('transportAmountLabel').textContent = complete ? 'Importe cobrado en pesos' : 'Importe estimado (opcional)';
      $('transportPaymentField').hidden = !complete;
      $('transportPayment').disabled = !complete;
      $('transportPayment').required = complete;
      $('transportActionSubmit').disabled = false;
      cancelAction.disabled = false;
      dialog.showModal();
    }

    cancelAction.onclick = () => dialog.close();
    dialog.addEventListener('cancel', event => {
      if ($('transportActionSubmit').disabled) event.preventDefault();
    });
    form.onsubmit = async event => {
      event.preventDefault();
      const session = scope;
      if (!session?.action) return;
      const { row, action } = session.action;
      const amount = $('transportAmount');
      const button = $('transportActionSubmit');
      if (button.disabled) return;
      button.disabled = true;
      cancelAction.disabled = true;
      try {
        const args = { p_org: session.orgId, p_request: row.id, p_version: row.updated_at,
          p_amount: !amount.disabled && amount.value !== '' ? Number(amount.value) : null };
        if (action === 'complete' || action === 'cancel') {
          await checked(sb.rpc('gestok_transport_close_v42', {
            ...args, p_outcome: action === 'complete' ? 'completed' : 'cancelled',
            p_payment: action === 'complete' ? $('transportPayment').value : null,
          }));
        } else {
          await checked(sb.rpc('gestok_transport_driver_action', {
            ...args, p_action: action, p_delay: action === 'delay' ? Number($('transportDelay').value) : null,
          }));
        }
        if (scope !== session) return;
        dialog.close();
        notice(session, action === 'complete' ? 'Viaje finalizado e ingreso registrado.' : 'Respuesta guardada.');
        await refresh(session);
      } catch {
        if (scope !== session) return;
        dialog.close();
        await refresh(session);
        notice(session, 'No se pudo guardar la respuesta. Revisá el estado actualizado antes de reintentar.');
      } finally {
        if (scope === session) {
          button.disabled = false;
          cancelAction.disabled = false;
        }
      }
    };

    function orderCard(session, row) {
      const card = el('article', '', 'transport-order');
      card.append(el('h3', row.pickup + ' → ' + row.destination));
      card.append(el('p', dateFormat.format(new Date(row.pickup_at)) + ' · ' + statusNames[row.status]));
      if (row.delay_minutes != null) card.append(el('p', 'Demora informada: ' + row.delay_minutes + ' min'));
      if (row.amount != null) card.append(el('p', 'Importe: ' + money.format(row.amount)));
      const buttons = el('div', '', 'transport-actions');
      const options = row.status === 'confirmed' ? ['complete', 'delay', 'cancel'] : ['confirm', 'reject', 'delay'];
      for (const action of options) {
        const button = el('button', actionNames[action], 'transport-action' + (action === 'confirm' ? ' transport-action-primary' : ''));
        button.type = 'button';
        button.onclick = () => chooseAction(session, row, action);
        buttons.append(button);
      }
      card.append(buttons);
      return card;
    }

    function updateMap(session) {
      if (!session.map || session.view !== 'map') return;
      const markers = session.rows.filter(row => row.status !== 'confirmed' && row.pickup_lat != null && row.pickup_lng != null);
      const countWithout = session.rows.filter(row => row.status !== 'confirmed').length - markers.length;
      session.map.invalidateSize();
      session.markers.clearLayers();
      for (const row of markers) {
        const popup = el('div', '');
        popup.append(el('strong', row.pickup), el('p', statusNames[row.status]));
        const button = el('button', 'Ver pedidos', 'transport-action');
        button.type = 'button';
        button.onclick = () => $('transportApp').querySelector('[data-transport-view="orders"]').click();
        popup.append(button);
        window.L.circleMarker([row.pickup_lat, row.pickup_lng], {
          radius: 10, color: '#f28c28', fillColor: '#f28c28', fillOpacity: 0.85, className: 'transport-marker',
        }).bindPopup(popup).addTo(session.markers);
      }
      const points = markers.map(row => [row.pickup_lat, row.pickup_lng]);
      const signature = JSON.stringify(points);
      if (points.length && signature !== session.mapPoints) {
        session.map.fitBounds(points, { padding: [26, 26], maxZoom: 14, animate: false });
      }
      session.mapPoints = signature;
      $('transportMapStatus').textContent = markers.length + ' con ubicación compartida · ' + countWithout + ' sin marcador';
    }

    async function showMap(session) {
      try {
        if (!session.map) {
          await Promise.all([
            loadAsset('./assets/traslados/leaflet.css', true),
            loadAsset('./assets/traslados/leaflet.js'),
          ]);
          if (scope !== session || session.view !== 'map') return;
          if (!session.map) {
            session.map = window.L.map('transportMapCanvas').setView([-38, -64], 4);
            window.L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
              maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
            }).addTo(session.map);
            session.markers = window.L.layerGroup().addTo(session.map);
          }
        }
        updateMap(session);
      } catch {
        if (scope === session) $('transportMapStatus').textContent = 'No se pudo cargar el mapa. Los pedidos siguen disponibles en la lista.';
      }
    }

    async function loadLink(session) {
      try {
        const [setting] = await checked(sb.rpc('gestok_transport_driver_settings', { p_org: session.orgId }));
        if (scope !== session) return;
        if (!codeFormat.test(setting?.public_code)) throw new Error('Código no disponible');
        const url = new URL('https://gestokwebcontrol.online/');
        url.searchParams.set('traslado', setting.public_code);
        $('transportShareUrl').value = url.href;
        $('transportLinkControls').hidden = false;
        $('transportRequestsAvailability').textContent = setting.requests_enabled ? 'Habilitadas' : 'Desactivadas';
        $('transportLinkStatus').textContent = setting.requests_enabled
          ? 'Compartí este enlace para recibir solicitudes.' : 'El enlace es permanente. Las solicitudes públicas siguen desactivadas.';
        if (session.view !== 'code') return;
        await loadAsset('./assets/traslados/qrcode.js');
        if (scope !== session) return;
        const qr = window.qrcode(0, 'M');
        qr.addData(url.href);
        qr.make();
        $('transportQr').src = qr.createDataURL(5, 20);
        $('transportQr').hidden = false;
      } catch {
        if (scope !== session) return;
        if ($('transportLinkControls').hidden) {
          $('transportRequestsAvailability').textContent = 'Sin verificar';
          $('transportLinkStatus').textContent = 'No se pudo cargar el enlace. Volvé a abrir esta sección.';
        } else $('transportShareFeedback').textContent = 'No se pudo generar el QR. El enlace se puede compartir.';
      }
    }

    async function copyLink() {
      const session = scope;
      if (!session) return;
      const input = $('transportShareUrl');
      try {
        await navigator.clipboard.writeText(input.value);
        if (scope === session) $('transportShareFeedback').textContent = 'Enlace copiado.';
      } catch {
        if (scope !== session) return;
        input.focus();
        input.select();
        $('transportShareFeedback').textContent = 'El enlace quedó seleccionado para copiarlo.';
      }
    }

    $('transportCopy').onclick = copyLink;
    $('transportShare').onclick = async () => {
      if (!navigator.share) return await copyLink();
      try {
        await navigator.share({ title: 'GestOK Traslados', url: $('transportShareUrl').value });
      } catch (error) {
        if (error.name !== 'AbortError') await copyLink();
      }
    };

    async function refresh(session) {
      if (scope !== session) return;
      if (session.refreshing) {
        session.refreshAgain = true;
        return;
      }
      session.refreshing = true;
      try {
        const rows = [];
        for (let offset = 0; scope === session; offset += 100) {
          const batch = await checked(sb.from('transport_requests')
            .select('id,pickup,destination,pickup_at,pickup_lat,pickup_lng,status,delay_minutes,amount,updated_at')
            .eq('organization_id', session.orgId).in('status', ['pending', 'delayed', 'confirmed'])
            .order('pickup_at').order('id').range(offset, offset + 99));
          rows.push(...batch);
          if (batch.length < 100) break;
        }
        if (scope !== session) return;
        const fresh = rows.filter(row => row.status === 'pending' && !session.known.has(row.id)).length;
        for (const row of rows) session.known.add(row.id);
        if (session.loaded && fresh) {
          notice(session, fresh === 1 ? 'Llegó un pedido nuevo.' : 'Llegaron ' + fresh + ' pedidos nuevos.');
          playNotification(session);
        }
        session.loaded = true;
        session.rows = rows;
        const list = $('transportPending');
        const focus = list.contains(document.activeElement);
        const signature = rows.map(row => row.id + ':' + row.updated_at).join(',');
        const changed = signature !== session.signature;
        if (changed) {
          list.replaceChildren(...(rows.length ? rows.map(row => orderCard(session, row)) : [el('p', 'No hay pedidos activos.')]));
          if (focus) $('transportOrders').querySelector('h2').focus({ preventScroll: true });
          session.signature = signature;
          updateMap(session);
        }
        finance.updated(session, changed || session.historyDirty);
        session.historyDirty = false;
      } catch {
        notice(session, 'No se pudieron actualizar los pedidos. Se reintentará automáticamente.');
      } finally {
        session.refreshing = false;
        if (session.refreshAgain) {
          session.refreshAgain = false;
          void refresh(session);
        }
      }
    }

    function show(view) {
      const session = scope;
      if (!session) return;
      session.view = view;
      if (view === 'map') void showMap(session);
      finance.show(session, view);
      if (view === 'code') void loadLink(session);
    }

    function start(orgId) {
      stop();
      const session = { orgId, view: 'home', rows: [], known: new Set() };
      scope = session;
      finance.start(session);
      $('transportRequestsAvailability').textContent = 'Verificando…';
      $('transportLinkStatus').textContent = 'Cargando enlace…';
      $('transportPending').replaceChildren(el('p', 'Cargando pedidos…'));
      void loadLink(session);
      const filter = 'organization_id=eq.' + orgId;
      const params = { schema: 'public', table: 'transport_requests', filter };
      const onChange = () => {
        session.historyDirty = true;
        void refresh(session);
      };
      session.channel = sb.channel('gestok-transport-' + orgId)
        .on('postgres_changes', { ...params, event: 'INSERT' }, onChange)
        .on('postgres_changes', { ...params, event: 'UPDATE' }, onChange)
        .subscribe(status => { if (status === 'SUBSCRIBED') void refresh(session); });
      session.timer = setInterval(() => void refresh(session), 12000);
      void refresh(session);
    }

    return { start, stop, show };
  }

  async function startPassenger(sb, code) {
    const shell = $('transportPassenger');
    const form = $('transportPassengerForm');
    const tracking = $('transportPassengerTracking');
    const note = $('transportPassengerNotice');
    shell.classList.remove('hidden');
    if (!codeFormat.test(code)) {
      note.textContent = 'El enlace de Traslados no es válido.';
      return;
    }
    code = code.toLowerCase();
    const key = 'gestok-transport-receipt:' + code;
    const pickup = $('transportPickup');
    let coords;
    let locationAttempt = 0;
    let receipt;
    let timer;
    let waiting = false;

    function remember(value) {
      receipt = value;
      try {
        if (value) sessionStorage.setItem(key, value);
        else sessionStorage.removeItem(key);
      } catch { /* El seguimiento de esta pestaña sigue disponible en memoria. */ }
    }
    try { receipt = sessionStorage.getItem(key); } catch { /* Almacenamiento no disponible. */ }
    if (receipt && !/^[a-f0-9]{64}$/.test(receipt)) remember(null);

    function setLocation(value, message) {
      coords = value;
      pickup.required = !value;
      $('transportRemoveLocation').hidden = !value;
      $('transportLocationStatus').textContent = message;
    }

    $('transportLocate').onclick = () => {
      if (!navigator.geolocation) {
        setLocation(null, 'El navegador no pudo acceder a tu ubicación. Ingresá la dirección.');
        return;
      }
      const attempt = ++locationAttempt;
      $('transportLocationStatus').textContent = 'Buscando tu ubicación…';
      navigator.geolocation.getCurrentPosition(
        ({ coords: position }) => {
          if (attempt === locationAttempt) setLocation(position, 'Ubicación lista. Se enviará al confirmar la solicitud.');
        },
        () => {
          if (attempt === locationAttempt) setLocation(null, 'No se pudo obtener la ubicación. Ingresá la dirección.');
        },
        { timeout: 12000 },
      );
    };
    $('transportRemoveLocation').onclick = () => {
      locationAttempt++;
      setLocation(null, 'Ubicación quitada. Ingresá la dirección de recogida.');
    };

    const schedule = $('transportSchedule');
    const date = $('transportScheduleDate');
    schedule.onchange = () => {
      $('transportScheduleDateField').hidden = schedule.value !== 'scheduled';
      date.required = schedule.value === 'scheduled';
    };

    async function availability() {
      try {
        const on = await checked(sb.rpc('gestok_transport_public_available', { p_code: code }));
        form.hidden = !on;
        note.textContent = on ? 'Elegí dónde y cuándo querés viajar.' : 'Este enlace todavía no recibe solicitudes.';
        return on;
      } catch {
        note.textContent = 'No se pudo verificar el enlace. Recargá la página para reintentar.';
        return null;
      }
    }

    function track(row) {
      form.hidden = true;
      tracking.hidden = false;
      note.textContent = 'Podés consultar la respuesta del conductor desde esta pestaña.';
      $('transportPassengerStatus').textContent = statusNames[row.status] || row.status;
      $('transportPassengerPickupTime').textContent = dateFormat.format(new Date(row.pickup_at));
      $('transportPassengerDelay').textContent = row.delay_minutes == null ? '—' : row.delay_minutes + ' min';
      $('transportPassengerAmount').textContent = row.amount == null ? '—' : money.format(row.amount);
      $('transportPassengerNew').hidden = !terminal(row.status);
      if (terminal(row.status)) {
        clearInterval(timer);
        timer = null;
      } else if (!timer) timer = setInterval(() => void refreshStatus(), 8000);
    }

    async function refreshStatus() {
      if (waiting || !receipt) return;
      waiting = true;
      try {
        const [row] = await checked(sb.rpc('gestok_transport_request_status', { p_code: code, p_receipt: receipt }));
        if (row) track(row);
        return row;
      } catch {
        note.textContent = 'No se pudo actualizar el estado. Volvé a intentar.';
        return null;
      } finally {
        waiting = false;
      }
    }

    $('transportPassengerRefresh').onclick = refreshStatus;
    $('transportPassengerNew').onclick = async () => {
      remember(null);
      tracking.hidden = true;
      form.reset();
      schedule.onchange();
      $('transportRemoveLocation').click();
      await availability();
    };

    form.onsubmit = async event => {
      event.preventDefault();
      const button = $('transportRequestSubmit');
      if (button.disabled) return;
      let scheduledAt = null;
      if (schedule.value === 'scheduled') {
        const typed = new Date(date.value);
        if (!Number.isFinite(typed.getTime()) || typed.getTime() <= Date.now()) {
          note.textContent = 'Elegí una fecha y hora futuras.';
          return;
        }
        scheduledAt = typed.toISOString();
      }
      if (!receipt) remember(Array.from(crypto.getRandomValues(new Uint8Array(32)),
        byte => byte.toString(16).padStart(2, '0')).join(''));
      button.disabled = true;
      locationAttempt++;
      try {
        await checked(sb.rpc('gestok_transport_submit', {
          p_code: code, p_receipt: receipt, p_pickup: pickup.value.trim() || 'Ubicación compartida',
          p_destination: $('transportDestination').value.trim(), p_lat: coords?.latitude ?? null,
          p_lng: coords?.longitude ?? null, p_schedule: schedule.value, p_at: scheduledAt,
        }));
        if (!await refreshStatus()) {
          note.textContent = 'Solicitud enviada. Si no aparece el estado, reenviá desde esta pestaña para recuperarla.';
        }
      } catch {
        if (!await refreshStatus() && await availability()) {
          note.textContent = 'No se pudo confirmar el envío. Revisá los datos o reintentá desde esta pestaña.';
        }
      } finally {
        button.disabled = false;
      }
    };

    if (receipt) {
      const row = await refreshStatus();
      if (row) return;
    }
    await availability();
  }

  window.GestokTransport = { createDriver, startPassenger };
})();
