// Sincronizzazione dei dati tra i dispositivi dei genitori.
// Riceve un "adapter" (firebase-adapter.js) e collega l'app (window.app) al database condiviso:
//  - ascolta in tempo reale bambini e misurazioni e aggiorna lo schermo;
//  - sostituisce le funzioni di store.* con scritture sul database;
//  - al primo accesso carica sul cloud i dati già presenti sul dispositivo.
export function startCloud(fb) {
  const app = window.app, st = app.store, $ = app.$;
  const babies = new Map();          // id -> oggetto bambino (con measures)
  const unsubMeasures = new Map();   // id -> funzione per smettere di ascoltare
  let unsubBabies = null;
  let localAtLogin = null;           // dati del dispositivo prima del primo collegamento
  let offline = !navigator.onLine, pending = false, fromCache = true;

  /* ---------- stato della sincronizzazione ---------- */
  function updateStatus() {
    if (!st.user) { st.status = st.authKnown ? 'Accesso richiesto' : 'Connessione…'; st.statusKind = 'wait'; }
    else if (offline || fromCache) { st.status = pending ? 'Offline · modifiche in attesa' : 'Offline · dati salvati qui'; st.statusKind = 'off'; }
    else if (pending) { st.status = 'Invio in corso…'; st.statusKind = 'wait'; }
    else { st.status = '✓ Sincronizzato'; st.statusKind = 'ok'; }
    app.renderStatus();
  }
  addEventListener('online', () => { offline = false; updateStatus(); });
  addEventListener('offline', () => { offline = true; updateStatus(); });
  const fail = e => {
    console.error(e);
    st.status = e?.code === 'permission-denied' ? 'Accesso non autorizzato' : 'Errore di sincronizzazione';
    st.statusKind = 'bad'; app.renderStatus();
  };

  /* ---------- conversione dati ---------- */
  const babyData = b => ({
    name: b.name || '', sex: b.sex || 'F', birth: b.birth, birthWeight: b.birthWeight ?? null,
    birthLength: b.birthLength ?? null, gaWeeks: b.gaWeeks ?? 40, gaDays: b.gaDays ?? 0, corrected: !!b.corrected,
  });
  const measureData = m => ({
    date: m.date, weight: m.weight ?? null, length: m.length ?? null, formula: m.formula ?? null, note: m.note || '',
  });
  const plain = r => { const o = { ...r }; delete o.updatedAt; delete o.updatedBy; return o; };

  /* ---------- dal database allo schermo ---------- */
  function publish() {
    const s = app.state;
    s.babies = [...babies.values()].sort((a, b) => (a.name || '').localeCompare(b.name || '') || a.id.localeCompare(b.id));
    if (!s.babies.some(b => b.id === s.current)) s.current = s.babies[0]?.id || null;
    app.save();   // copia locale, utile per avvii senza rete
    app.render();
  }

  function onBabies(list, meta) {
    fromCache = meta.fromCache; pending = meta.pending; updateStatus();
    const s = app.state;
    if (!s.cloudSynced) {
      // Primo collegamento di questo dispositivo: aspetta la risposta del server
      if (meta.fromCache) return;
      if (list.length === 0 && localAtLogin?.length) {
        uploadAll(localAtLogin);            // il cloud è vuoto: ci carico i dati del telefono
      } else if (localAtLogin?.length) {
        // il cloud ha già dei dati: tengo comunque una copia di sicurezza di quelli locali
        try { localStorage.setItem('crescitaNeonato.copiaPrimaDelCloud', JSON.stringify(localAtLogin)); } catch (e) {}
      }
      s.cloudSynced = true; localAtLogin = null; app.save();
      if (list.length === 0) return;        // i dati caricati arriveranno con il prossimo aggiornamento
    }
    const ids = new Set(list.map(r => r.id));
    for (const [id, unsub] of unsubMeasures) if (!ids.has(id)) { unsub(); unsubMeasures.delete(id); babies.delete(id); }
    for (const r of list) {
      let b = babies.get(r.id);
      if (!b) { b = { id: r.id, measures: [] }; babies.set(r.id, b); }
      Object.assign(b, plain(r));
      if (!unsubMeasures.has(r.id)) unsubMeasures.set(r.id, fb.db.listenMeasures(r.id, (ms, m) => onMeasures(r.id, ms, m), fail));
    }
    publish();
  }

  function onMeasures(bid, list, meta) {
    const b = babies.get(bid); if (!b) return;
    b.measures = list.map(plain);
    pending = meta.pending; fromCache = meta.fromCache; updateStatus();
    publish();
  }

  function uploadAll(list) {
    return fb.db.replaceAll([], list.map(b => ({
      id: b.id, data: babyData(b), measures: (b.measures || []).map(m => ({ id: m.id, data: measureData(m) })),
    }))).catch(fail);
  }

  function stopListening() {
    unsubBabies?.(); unsubBabies = null;
    for (const u of unsubMeasures.values()) u();
    unsubMeasures.clear(); babies.clear();
  }

  /* ---------- dallo schermo al database ---------- */
  st.saveBaby = b => { fb.db.setBaby(b.id, babyData(b)).catch(fail); };
  st.deleteBaby = b => { fb.db.deleteBaby(b.id, (b.measures || []).map(m => m.id)).catch(fail); };
  st.saveMeasure = (b, m) => { fb.db.setMeasure(b.id, m.id, measureData(m)).catch(fail); };
  st.deleteMeasure = (b, id) => { fb.db.deleteMeasure(b.id, id).catch(fail); };
  // Ripristino da backup: cancella ciò che non c'è nel backup e riscrive il resto
  // (un documento che verrà riscritto non viene cancellato prima).
  st.replaceAll = list => {
    const newIds = new Set(list.map(b => b.id));
    const newMeas = new Set(list.flatMap(b => (b.measures || []).map(m => b.id + '/' + m.id)));
    const oldList = [...babies.values()].map(b => ({
      id: b.id,
      measureIds: b.measures.map(m => m.id).filter(id => !newMeas.has(b.id + '/' + id)),
      dropBaby: !newIds.has(b.id),
    }));
    fb.db.replaceAll(oldList, list.map(b => ({
      id: b.id, data: babyData(b), measures: (b.measures || []).map(m => ({ id: m.id, data: measureData(m) })),
    }))).catch(fail);
  };
  st.logout = async () => {
    if (!confirm('Uscire dall\'account su questo dispositivo?\nI dati restano salvati nel cloud e li ritrovi al prossimo accesso.')) return;
    stopListening();
    await fb.auth.signOut().catch(fail);
    const s = app.state; s.babies = []; s.current = null; s.cloudSynced = false; app.save();
    await fb.clearLocalCache?.();
    location.reload();
  };

  /* ---------- accesso ---------- */
  const msg = (text, kind = 'bad') => { const m = $('loginMsg'); m.textContent = text; m.className = 'alert ' + kind; };
  const errText = e => ({
    'auth/invalid-credential': 'Email o password non corretti.',
    'auth/wrong-password': 'Email o password non corretti.',
    'auth/user-not-found': 'Email o password non corretti.',
    'auth/invalid-email': 'Indirizzo email non valido.',
    'auth/too-many-requests': 'Troppi tentativi: riprova tra qualche minuto.',
    'auth/network-request-failed': 'Nessuna connessione a internet.',
  }[e?.code] || (String(e?.code).startsWith('auth/api-key-not-valid') ? 'Configurazione Firebase non valida: controlla il file firebase-config.js.' : null) || 'Accesso non riuscito (' + (e?.code || e?.message || 'errore') + ').');

  $('btnLogin').onclick = () => {
    const email = $('lEmail').value.trim(), pw = $('lPass').value;
    if (!email || !pw) return msg('Inserisci email e password.');
    $('btnLogin').disabled = true; msg('Accesso in corso…', 'ok');
    fb.auth.signIn(email, pw).then(() => { $('lPass').value = ''; $('loginMsg').className = 'alert hidden'; })
      .catch(e => msg(errText(e))).finally(() => { $('btnLogin').disabled = false; });
  };
  $('lPass').addEventListener('keydown', e => { if (e.key === 'Enter') $('btnLogin').click(); });
  $('btnReset').onclick = () => {
    const email = $('lEmail').value.trim();
    if (!email) return msg('Scrivi la tua email nel campo qui sopra, poi premi di nuovo "Password dimenticata".');
    fb.auth.reset(email).then(() => msg('Ti abbiamo inviato un\'email per reimpostare la password (controlla anche lo spam).', 'ok'))
      .catch(e => msg(errText(e)));
  };

  fb.auth.onChange(user => {
    st.authKnown = true; st.user = user;
    stopListening();
    if (user) {
      const s = app.state;
      if (!s.cloudSynced) localAtLogin = JSON.parse(JSON.stringify(s.babies || []));
      fromCache = true;
      unsubBabies = fb.db.listenBabies(onBabies, fail);
    }
    updateStatus(); app.render();
  });
}
