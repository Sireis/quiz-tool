// Shared practice uses the trainer's normal question, answer, feedback and statistics UI.
(() => {
  const $ = id => document.getElementById(id);
  let room = null;
  let profile = null;
  let busy = false;
  let polling = false;
  let requestNumber = 0;
  let appliedNumber = 0;
  let fieldRequest = 0;
  let shownResult = null;
  let fields = [];
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

  function render(next, sequence) {
    if (sequence < appliedNumber) return;
    appliedNumber = sequence;
    const changed = !room || next.round_id !== room.round_id;
    room = next;
    $('shared-room').hidden = false;
    $('shared-title').textContent = `${room.mode === 'coop' ? 'Kooperativ' : 'Wettbewerb'} · ${room.code}`;
    $('shared-round').textContent = `Runde ${room.number}`;
    $('shared-participants').replaceChildren(...room.participants.map(person => {
      const chip = document.createElement('span');
      chip.className = 'shared-person';
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
    if (room.own_answer !== null && room.own_answer !== undefined) $('answer-input').value = room.own_answer;
    const waiting = room.participants.length < 2;
    $('answer-input').disabled = room.closed || busy || waiting || own.status !== 'answering';
    $('submit-btn').disabled = room.closed || busy || waiting || !['answering', 'error'].includes(own.status);
    $('submit-btn').textContent = own.status === 'error' ? 'Bewertung erneut versuchen' : 'Antwort abgeben';
    $('reveal-btn').hidden = true;
    $('loading').classList.toggle('visible', own.status === 'grading' && !room.closed);
    $('shared-status').textContent = room.closed ? 'Die Sitzung ist beendet.'
      : room.error || (waiting ? 'Teile den Einladungslink und warte auf ein zweites Profil.'
      : room.revealed ? 'Beide Antworten sind aufgedeckt. Geht weiter, sobald ihr beide bereit seid.'
      : own.status === 'answering' ? 'Deine Antwort bleibt bis zur gemeinsamen Auflösung privat.'
      : 'Deine Antwort ist abgegeben. Warte auf beide Bewertungen.');
    $('shared-comparison').hidden = !room.revealed;
    $('shared-summary').textContent = room.revealed && room.mode === 'compete'
      ? room.participants.map(person => `${person.name}: ${person.points} Punkte`).join(' · ')
      : `${room.completed} gemeinsame Runden`;
    if (room.revealed) {
      if (shownResult !== room.round_id) {
        shownResult = room.round_id;
        const result = {...own.result, answer: room.reference_answer};
        showResult(result);
        prepareChatGptPrompt(currentQuestion, room.field, own.answer, result);
        refreshPersonalData();
      }
      $('shared-partner-name').textContent = `${partner.name} · ${Math.round(partner.result.score * 100)} %`;
      $('shared-partner-answer').textContent = partner.answer;
      $('shared-partner-feedback').textContent = partner.result.feedback;
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
    $('shared-dialog').close();
    render(next, sequence);
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
    room = null;
    shownResult = null;
    sessionStorage.removeItem('trainer_shared_room');
    history.replaceState({}, '', '/');
    $('shared-room').hidden = true;
    $('shared-comparison').hidden = true;
    $('next-btn').disabled = false;
    $('next-btn').textContent = 'Nächste Frage →';
    $('submit-btn').textContent = 'Antwort prüfen';
    setRoomControls(false);
    await selectField(sel.field);
  }

  const controller = {
    get active() { return room !== null; },
    async submit() {
      if (!room || room.closed || busy || room.revealed) return;
      const answer = $('answer-input').value.trim();
      if (!answer) return;
      if (!['answering', 'error'].includes(room.participants.find(person => person.id === profile).status)) return;
      return perform(() => api(`/api/rooms/${room.code}/submit`, {round_id: room.round_id, answer}));
    },
    async next() {
      if (!room || room.closed || busy || !room.revealed) return;
      return perform(() => api(`/api/rooms/${room.code}/ready`, {round_id: room.round_id}));
    },
    async init(availableFields) {
      fields = availableFields;
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
      setInterval(async () => {
        if (!room || room.closed || busy || polling || document.hidden) return;
        polling = true;
        const sequence = ++requestNumber;
        try { render(await api(`/api/rooms/${room.code}`), sequence); }
        catch { message('Verbindung unterbrochen. Erneuter Versuch läuft …'); }
        finally { polling = false; }
      }, 1000);
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
