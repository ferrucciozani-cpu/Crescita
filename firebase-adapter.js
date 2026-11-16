// Collegamento a Firebase (autenticazione + database Firestore con cache offline).
// cloud.js usa solo l'oggetto restituito da makeAdapter, non Firebase direttamente.
const V = '10.12.2';
const { initializeApp } = await import(`https://www.gstatic.com/firebasejs/${V}/firebase-app.js`);
const { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut, sendPasswordResetEmail } =
  await import(`https://www.gstatic.com/firebasejs/${V}/firebase-auth.js`);
const { initializeFirestore, persistentLocalCache, persistentMultipleTabManager, collection, doc, onSnapshot,
        setDoc, deleteDoc, writeBatch, serverTimestamp, terminate, clearIndexedDbPersistence } =
  await import(`https://www.gstatic.com/firebasejs/${V}/firebase-firestore.js`);

export function makeAdapter(config) {
  const app = initializeApp(config);
  const auth = getAuth(app);
  // Cache sul dispositivo: l'app funziona anche senza rete e invia le modifiche appena torna.
  const db = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });
  const who = () => auth.currentUser?.email || '';
  const stamp = d => ({ ...d, updatedAt: serverTimestamp(), updatedBy: who() });
  const babyRef = id => doc(db, 'bambini', id);
  const measRef = (bid, id) => doc(db, 'bambini', bid, 'misure', id);
  const meta = s => ({ fromCache: s.metadata.fromCache, pending: s.metadata.hasPendingWrites });
  const rows = s => s.docs.map(d => ({ id: d.id, ...d.data() }));

  // Esegue molte scritture a blocchi (limite Firestore: 500 operazioni per batch).
  // Non si attende il server: offline le scritture restano in coda e partono dopo.
  function runOps(ops) {
    const commits = [];
    for (let i = 0; i < ops.length; i += 400) {
      const batch = writeBatch(db);
      ops.slice(i, i + 400).forEach(op => op(batch));
      commits.push(batch.commit());
    }
    return Promise.all(commits);
  }

  return {
    auth: {
      onChange: cb => onAuthStateChanged(auth, u => cb(u ? { email: u.email, uid: u.uid } : null)),
      signIn: (email, pw) => signInWithEmailAndPassword(auth, email, pw),
      signOut: () => signOut(auth),
      reset: email => sendPasswordResetEmail(auth, email),
    },
    db: {
      listenBabies: (cb, onErr) =>
        onSnapshot(collection(db, 'bambini'), { includeMetadataChanges: true }, s => cb(rows(s), meta(s)), onErr),
      listenMeasures: (bid, cb, onErr) =>
        onSnapshot(collection(db, 'bambini', bid, 'misure'), { includeMetadataChanges: true }, s => cb(rows(s), meta(s)), onErr),
      setBaby: (id, data) => setDoc(babyRef(id), stamp(data)),
      setMeasure: (bid, id, data) => setDoc(measRef(bid, id), stamp(data)),
      deleteMeasure: (bid, id) => deleteDoc(measRef(bid, id)),
      deleteBaby: (bid, measureIds) =>
        runOps([...measureIds.map(id => b => b.delete(measRef(bid, id))), b => b.delete(babyRef(bid))]),
      // oldList: [{id, measureIds, dropBaby}] da cancellare   newList: [{id, data, measures:[{id, data}]}] da scrivere
      replaceAll: (oldList, newList) => runOps([
        ...oldList.flatMap(o => [...o.measureIds.map(id => b => b.delete(measRef(o.id, id))),
                                 ...(o.dropBaby ? [b => b.delete(babyRef(o.id))] : [])]),
        ...newList.flatMap(n => [b => b.set(babyRef(n.id), stamp(n.data)),
                                 ...n.measures.map(m => b => b.set(measRef(n.id, m.id), stamp(m.data)))]),
      ]),
    },
    async clearLocalCache() {
      try { await terminate(db); await clearIndexedDbPersistence(db); } catch (e) { console.warn(e); }
    },
  };
}
