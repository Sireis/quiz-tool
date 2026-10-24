// Shared practice uses the trainer's normal question, answer, feedback and statistics UI.
(() => {
  const $ = id => document.getElementById(id);
  let room = null;
  let profile = null;
  let busy = false;
  let requestNumber = 0;
  let appliedNumber = 0;
  let fieldRequest = 0;
  let shownResult = null;
  let fields = [];
  let joinableCode = null;
  let discovering = false;
  let socket = null;
  let editor = null;
  let connected = false;
  let reconnectTimer = null;
  let reconnectAttempt = 0;
  let socketGeneration = 0;
  const client = globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2);
  const traffic = {sent: {}, received: {}, lastError: null};
  const statusNames = {answering: 'Antwortet …', grading: 'Bewertung läuft …', graded: 'Antwort bereit', error: 'Bewertung wiederholen'};

  async function api(path, body) {
    const headers = {'X-Trainer-Profile': profile || $('shared-profile').value};
    const options = {headers};
    if (body !== undefined) {
      options.method = 'POST';
      headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }
    // Explicit room membership must survive a different profile selected in another tab.
    const response = await originalFetch(path, options);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Anfrage fehlgeschlagen');
    return data;
  }

  function message(text) {
    $(room ? 'shared-status' : 'shared-lobby-status').textContent = text;
  }

  function setRoomControls(active) {
    $('profile-select').disabled = active;
    $('profile-add').disabled = active;
    $('reveal-btn').hidden = active;
    $('skip-btn').hidden = active;
    document.querySelectorAll('#sidebar .sb-scroll > div').forEach(section => {
      section.inert = active;
      section.classList.toggle('shared-locked', active);
    });
  }

  async function refreshPersonalData() {
    try { await Promise.all([refreshStats(), refreshGoal(sel.field)]); }
    catch { message('Statistiken konnten nicht aktualisiert werden.'); }
  }

  async function discover() {
    if (discovering || room || document.hidden) return;
    discovering = true;
    try {
      const response = await originalFetch('/api/rooms', {headers: {'X-Trainer-Profile': pageProfile}});
      if (!response.ok) return;
      const available = await response.json();
      joinableCode = available[0]?.code || null;
      $('shared-quick-join').hidden = !joinableCode || !!room;
    } catch { /* Discovery retries silently while solo practice continues. */ }
    finally { discovering = false; }
  }

  function renderAnswerCards() {
    const cooperative = room.mode === 'coop';
    const people = cooperative ? [room.participants[0]]
      : [...room.participants].sort((a, b) => Number(b.id === profile) - Number(a.id === profile));
    $('shared-answer-cards').classList.toggle('cooperative', cooperative);
    $('shared-answer-cards').replaceChildren(...people.map(person => {
      const card = document.createElement('article');
      card.className = `shared-answer-card ${getResultType(person.result)}`;
      const heading = document.createElement('h3');
      heading.textContent = cooperative ? 'Eure gemeinsame Antwort' : person.name + (person.id === profile ? ' · Du' : '');
      const rating = document.createElement('p');
      rating.className = 'shared-rating';
      const labels = {correct: 'Richtig', partial: 'Teilweise richtig', wrong: 'Falsch'};
      rating.textContent = `${labels[getResultType(person.result)]} · ${Math.round(person.result.score * 100)} %` +
        (person.result.is_sks ? ` · ${person.result.sks_punkte}/2 SKS-Punkte` : '');
      const answer = document.createElement('p');
      answer.className = 'shared-submitted-answer';
      answer.textContent = person.answer;
      const feedback = document.createElement('p');
      feedback.className = 'shared-answer-feedback';
      feedback.textContent = person.result.feedback;
      card.append(heading, rating, answer, feedback);
      return card;
    }));
    if (cooperative) {
      $('shared-outcome').textContent = 'Gemeinsam gelöst · Das Ergebnis zählt für beide Profile.';
    } else {
      const [a, b] = room.participants;
      const difference = Math.round(a.result.score * 100) - Math.round(b.result.score * 100);
      $('shared-outcome').textContent = difference === 0 ? 'Unentschieden in dieser Runde'
        : `${difference > 0 ? a.name : b.name} gewinnt diese Runde`;
    }
  }

  function send(message) {
    if (socket?.readyState !== 1) return false;
    traffic.sent[message.type] = (traffic.sent[message.type] || 0) + 1;
    socket.send(JSON.stringify(message));
    return true;
  }

  function hello() {
    send({type: 'hello', round_id: editor?.round, version: editor?.version});
  }

  function connect() {
    if (!room || room.closed) return;
    const generation = ++socketGeneration;
    clearTimeout(reconnectTimer);
    connected = false;
    editor?.setConnected(false);
    $('shared-connection').textContent = reconnectAttempt ? 'Verbindung wird wiederhergestellt …' : 'Verbinden …';
    const url = new URL(`/ws/rooms/${room.code}`, location.origin);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('profile', profile);
    url.searchParams.set('client', client);
    socket = new WebSocket(url);
    socket.onopen = hello;
    socket.onmessage = event => {
      if (generation !== socketGeneration || !room) return;
      try {
        const message = JSON.parse(event.data);
        traffic.received[message.type] = (traffic.received[message.type] || 0) + 1;
        if (message.type === 'updates') {
          editor?.receive(message);
        } else if (message.type === 'cursor') {
          editor?.cursor(message);
        } else if (message.type === 'state' || message.type === 'sync') {
          if (message.type === 'sync') {
            connected = true;
            reconnectAttempt = 0;
            editor?.setConnected(true);
            const own = message.state.participants.find(p => p.id === profile);
            if (message.editor) editor?.sync(message.editor, own.color || '#c4abff');
          }
          $('shared-connection').textContent = connected ? 'Live verbunden' : 'Synchronisieren …';
          render(message.state, ++requestNumber, message.editor);
        } else if (message.type === 'error') {
          messageError(message.message);
          hello();
        }
      } catch (error) { messageError(error.message || 'Synchronisierung fehlgeschlagen.'); }
    };
    socket.onclose = () => {
      if (generation !== socketGeneration || !room || room.closed) return;
      connected = false;
      editor?.setConnected(false);
      $('shared-connection').textContent = 'Verbindung unterbrochen · Verbinde erneut …';
      // Preserve unconfirmed local edits in the editor until the socket resynchronizes.
      render(room, appliedNumber);
      reconnectTimer = setTimeout(connect, Math.min(5000, 300 * 2 ** reconnectAttempt++));
    };
    socket.onerror = () => socket.close();
  }

  function messageError(text) { traffic.lastError = text; message(text); }

  function render(next, sequence, editorDocument = null) {
    if (sequence < appliedNumber) return;
    appliedNumber = sequence;
    const changed = !room || next.round_id !== room.round_id;
    room = next;
    $('shared-room').hidden = false;
    $('shared-quick-join').hidden = true;
    $('shared-title').textContent = `${room.mode === 'coop' ? 'Kooperativ' : 'Wettbewerb'} · ${room.code}`;
    $('shared-round').textContent = `Runde ${room.number}`;
    $('shared-participants').replaceChildren(...room.participants.map(person => {
      const chip = document.createElement('span');
      chip.className = 'shared-person';
      if (person.color) chip.style.setProperty('--participant-color', person.color);
      chip.textContent = `${person.name}${person.id === profile ? ' · Du' : ''}: ${person.online ? '' : 'Offline · '}${person.ready ? 'Bereit' : statusNames[person.status]}`;
      return chip;
    }));
    const own = room.participants.find(person => person.id === profile);
    const partner = room.participants.find(person => person.id !== profile);
    if (changed) {
      ++questionRequest; // Discard any pending solo question response.
      shownResult = null;
      resetResultCard();
      $('answer-input').value = '';
      $('answer-input').style.height = '';
      displayQuestion(room.question);
      document.querySelector('main').scrollTop = 0;
    } else if (currentQuestion) {
      Object.assign(currentQuestion, room.question);
      $('q-preparation').innerHTML = preparationIndicator(room.question.preparation);
    }
    if (room.mode === 'coop' && editorDocument && editor && editor.round !== editorDocument.round_id) {
      editor.sync(editorDocument, own.color || '#c4abff');
    }
    if (room.mode === 'coop' && room.own_answer != null && editorDocument) {
      editor?.freeze({...editorDocument, doc: room.own_answer}, own.color || '#c4abff');
    }
    $('shared-editor').hidden = room.mode !== 'coop';
    $('answer-input').hidden = room.mode === 'coop';
    if (room.own_answer !== null && room.own_answer !== undefined) $('answer-input').value = room.own_answer;
    const waiting = room.participants.length < 2;
    $('answer-input').disabled = room.closed || busy || waiting || own.status !== 'answering';
    editor?.setWritable(connected && !room.closed && !busy && !waiting && own.status === 'answering');
    $('submit-btn').disabled = room.closed || busy || !connected || waiting || !['answering', 'error'].includes(own.status);
    $('submit-btn').textContent = own.status === 'error' ? 'Bewertung erneut versuchen' : room.mode === 'coop' ? 'Gemeinsame Antwort prüfen' : 'Antwort abgeben';
    $('answer-label').textContent = room.mode === 'coop' ? 'Eure gemeinsame Antwort' : 'Deine Antwort';
    $('answer-label').htmlFor = room.mode === 'coop' ? 'shared-answer-text' : 'answer-input';
    $('answer-area').hidden = room.revealed;
    $('reveal-btn').hidden = true;
    $('loading').classList.toggle('visible', own.status === 'grading' && !room.closed);
    $('shared-status').textContent = room.closed ? 'Die Sitzung ist beendet.'
      : room.error || (waiting ? 'Teile den Einladungslink und warte auf ein zweites Profil.'
      : room.revealed ? 'Geht weiter, sobald ihr beide bereit seid.'
      : room.mode === 'coop' && own.status === 'answering' ? 'Ihr schreibt gemeinsam an derselben Antwort.'
      : own.status === 'answering' ? 'Deine Antwort bleibt bis zur gemeinsamen Auflösung privat.'
      : 'Deine Antwort ist abgegeben. Warte auf beide Bewertungen.');
    $('shared-comparison').hidden = !room.revealed;
    if (room.mode === 'coop') {
      const preparation = room.team_preparation;
      $('shared-summary').textContent = preparation
        ? `Gemeinsam vorbereitet: ${preparation.prepared}/${preparation.total} Fragen · ${room.completed} Runden`
        : `${room.completed} gemeinsame Runden`;
    } else if (room.participants.length === 2) {
      const [a, b] = room.participants;
      const aPoints = a.points || 0;
      const bPoints = b.points || 0;
      const lead = aPoints === bPoints ? 'Gleichstand' : `${aPoints > bPoints ? a.name : b.name} führt`;
      $('shared-summary').textContent = `${a.name}: ${aPoints} Punkte · ${b.name}: ${bPoints} Punkte · ${lead}`;
    } else if (changed) {
      $('shared-summary').textContent = 'Bis zu 100 Punkte pro Runde';
    }
    if (room.revealed && shownResult !== room.round_id) {
      shownResult = room.round_id;
      const result = {...own.result, answer: room.reference_answer};
      showResult(result);
      $('solo-result').hidden = true;
      renderAnswerCards();
      prepareChatGptPrompt(currentQuestion, room.field, own.answer, result);
      refreshPersonalData();
    }
    $('next-btn').disabled = room.closed || busy || !room.revealed || own.ready;
    $('next-btn').textContent = own.ready ? 'Warte auf die andere Person …' : 'Bereit für die nächste Frage →';
    $('shared-leave').disabled = room.closed || busy;
    $('shared-solo').hidden = !room.closed;
    if (!room.closed) sessionStorage.setItem('trainer_shared_room', JSON.stringify({code: room.code, profile}));
    else sessionStorage.removeItem('trainer_shared_room');
  }

  async function attach(next, sequence) {
    // All normal API requests (bookmarks, statistics, goals) use this tab's room profile.
    pageProfile = profile;
    $('profile-select').value = profile;
    Object.assign(sel, {field: next.field, topic: next.topic, subtopic: null, examen: null, set: null});
    setRoomControls(true);
    if (next.mode === 'coop') editor = new SharedEditor($('shared-editor'), client, send, hello);
    $('shared-dialog').close();
    render(next, sequence);
    connect();
    const invite = new URL('/together', location.origin);
    invite.searchParams.set('room', next.code);
    history.replaceState({}, '', invite);
    updateHeaderCtx();
    highlightSel('field', next.field);
    await Promise.all([loadTopics(next.field), loadExamens(next.field), loadSets(next.field), loadBookmarks(next.field), refreshPersonalData()]);
    highlightSel('topic', next.topic);
    mobileGoMain();
  }

  async function perform(work, entering = false) {
    if (busy) return;
    busy = true;
    message('');
    $('shared-create').disabled = true;
    $('shared-join').disabled = true;
    if (room) render(room, appliedNumber);
    const sequence = ++requestNumber;
    try {
      const next = await work();
      busy = false;
      if (entering) await attach(next, sequence);
      else render(next, sequence);
    } catch (error) { message(error.message); }
    finally {
      busy = false;
      $('shared-create').disabled = false;
      $('shared-join').disabled = false;
      if (room) {
        // Restore controls without clearing an actionable request error.
        const error = $('shared-status').textContent;
        render(room, appliedNumber);
        $('shared-status').textContent = error;
      }
    }
  }

  async function join(code) {
    profile = $('shared-profile').value;
    return perform(() => api(`/api/rooms/${encodeURIComponent(code)}/join`, {}), true);
  }

  async function loadRoomTopics() {
    const sequence = ++fieldRequest;
    $('shared-create').disabled = true;
    try {
      const topics = await api(`/api/fields/${encodeURIComponent($('shared-field').value)}/topics`);
      if (sequence !== fieldRequest) return;
      $('shared-topic').replaceChildren(new Option('Alle Themen', ''), ...topics.map(topic => new Option(topic, topic)));
      $('shared-create').disabled = false;
    } catch (error) { message(error.message); }
  }

  async function openLobby() {
    if (room) { mobileGoMain(); $('shared-room').scrollIntoView({block: 'nearest'}); return; }
    const response = await originalFetch('/api/profiles');
    if (!response.ok) throw new Error('Profile konnten nicht geladen werden.');
    const profiles = await response.json();
    $('shared-profile').replaceChildren(...profiles.map(person => new Option(person.name, person.id)));
    $('shared-profile').value = pageProfile;
    $('shared-field').replaceChildren(...fields.map(field => new Option(field, field)));
    const field = sel.field || localStorage.getItem('trainer_field');
    if (fields.includes(field)) $('shared-field').value = field;
    await loadRoomTopics();
    if (sel.topic) $('shared-topic').value = sel.topic;
    $('shared-dialog').showModal();
  }

  async function stop() {
    ++requestNumber;
    appliedNumber = requestNumber;
    ++socketGeneration;
    clearTimeout(reconnectTimer);
    socket?.close();
    socket = null;
    connected = false;
    editor?.destroy();
    editor = null;
    room = null;
    shownResult = null;
    sessionStorage.removeItem('trainer_shared_room');
    history.replaceState({}, '', '/');
    $('shared-room').hidden = true;
    $('shared-comparison').hidden = true;
    $('solo-result').hidden = false;
    $('answer-area').hidden = false;
    $('answer-label').textContent = 'Deine Antwort';
    $('answer-label').htmlFor = 'answer-input';
    $('shared-editor').hidden = true;
    $('answer-input').hidden = false;
    $('next-btn').disabled = false;
    $('next-btn').textContent = 'Nächste Frage →';
    $('submit-btn').textContent = 'Antwort prüfen';
    setRoomControls(false);
    await selectField(sel.field);
    await discover();
  }

  const controller = {
    diagnostics() {
      return {connected, socketState: socket?.readyState ?? null, room: room?.code,
        mode: room?.mode, client: client.slice(-8), server: room?._transport || null,
        participants: room?.participants.map(p => ({name: p.name, online: p.online})),
        editor: editor?.diagnostics?.() || null,
        sent: {...traffic.sent}, received: {...traffic.received}, lastError: traffic.lastError};
    },
    get active() { return room !== null; },
    async submit() {
      if (!room || room.closed || busy || room.revealed) return;
      if (!connected) { message('Warte auf die Verbindung zum Raum.'); return; }
      if (!['answering', 'error'].includes(room.participants.find(person => person.id === profile).status)) return;
      if (room.mode === 'coop') {
        return perform(async () => {
          const submission = await editor.flush();
          if (!submission.answer) throw new Error('Bitte zuerst eine Antwort eingeben.');
          return api(`/api/rooms/${room.code}/submit`, {round_id: room.round_id, ...submission});
        });
      }
      const answer = $('answer-input').value.trim();
      if (!answer) return;
      return perform(() => api(`/api/rooms/${room.code}/submit`, {round_id: room.round_id, answer}));
    },
    async next() {
      if (!room || room.closed || busy || !room.revealed) return;
      return perform(() => api(`/api/rooms/${room.code}/ready`, {round_id: room.round_id}));
    },
    async init(availableFields) {
      fields = availableFields;
      $('shared-quick-join').addEventListener('click', () => {
        if (!joinableCode || room || busy) return;
        profile = pageProfile;
        const code = joinableCode;
        perform(() => api(`/api/rooms/${code}/join`, {}), true);
      });
      await discover();
      setInterval(discover, 2000);
      $('shared-open').addEventListener('click', () => openLobby().catch(error => message(error.message)));
      $('shared-close').addEventListener('click', () => $('shared-dialog').close());
      $('shared-field').addEventListener('change', loadRoomTopics);
      $('shared-create-form').addEventListener('submit', event => {
        event.preventDefault();
        profile = $('shared-profile').value;
        perform(() => api('/api/rooms', {field: $('shared-field').value, topic: $('shared-topic').value || null, mode: $('shared-mode').value}), true);
      });
      $('shared-join-form').addEventListener('submit', event => {
        event.preventDefault();
        join($('shared-code').value.trim().toUpperCase());
      });
      $('shared-leave').addEventListener('click', async () => {
        if (busy || !confirm('Gemeinsame Sitzung für beide Profile beenden?')) return;
        await perform(() => api(`/api/rooms/${room.code}/leave`, {}));
        if (room?.closed) await stop();
      });
      $('shared-solo').addEventListener('click', stop);
      $('shared-copy').addEventListener('click', async () => {
        const invite = new URL('/together', location.origin);
        invite.searchParams.set('room', room.code);
        try { await navigator.clipboard.writeText(invite.href); message('Einladungslink kopiert.'); }
        catch { message(`Einladungslink: ${invite.href}`); }
      });
      setInterval(() => {
        if (room && !room.closed && connected) send({type: 'ping'});
      }, 10000);
      if (location.pathname === '/together') {
        await openLobby();
        const inviteCode = new URLSearchParams(location.search).get('room')?.toUpperCase();
        if (inviteCode) $('shared-code').value = inviteCode;
        let saved;
        try { saved = JSON.parse(sessionStorage.getItem('trainer_shared_room')); } catch {}
        if (saved && (!inviteCode || saved.code === inviteCode) && [...$('shared-profile').options].some(option => option.value === saved.profile)) {
          $('shared-profile').value = saved.profile;
          await join(saved.code);
        }
      }
    },
  };
  globalThis.sharedPractice = controller;
})();
