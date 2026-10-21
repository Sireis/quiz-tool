(() => {
  const $ = id => document.getElementById(id);
  let room = null;
  let profile = null;
  let busy = false;
  let polling = false;
  let requestNumber = 0;
  let appliedNumber = 0;
  let fieldRequest = 0;
  const statusNames = {answering: 'Antwortet …', grading: 'Bewertung läuft …', graded: 'Antwort bereit', error: 'Bewertung muss wiederholt werden'};

  async function api(path, body) {
    const options = {headers: {'X-Trainer-Profile': profile || $('profile').value}};
    if (body !== undefined) {
      options.method = 'POST';
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }
    const response = await fetch(path, options);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Anfrage fehlgeschlagen');
    return data;
  }

  function remember() {
    sessionStorage.setItem('trainer_shared_room', JSON.stringify({code: room.code, profile}));
  }

  function render(next, sequence) {
    if (sequence < appliedNumber) return;
    appliedNumber = sequence;
    const changed = !room || next.round_id !== room.round_id;
    room = next;
    $('lobby').hidden = true;
    $('room').hidden = false;
    $('room-title').textContent = `${room.mode === 'coop' ? 'Kooperativ' : 'Wettbewerb'} · ${room.code}`;
    $('room-meta').textContent = `${room.field}${room.topic ? ' · ' + room.topic : ''} · Runde ${room.number}`;
    const invite = new URL('/together', location.origin);
    invite.searchParams.set('room', room.code);
    $('invite').value = invite.href;
    $('question-meta').textContent = room.question.topic + (room.question.subtopic ? ' · ' + room.question.subtopic : '');
    $('question').textContent = room.question.question;
    const own = room.participants.find(person => person.id === profile);
    if (changed) $('answer').value = '';
    if (room.own_answer !== null && room.own_answer !== undefined) $('answer').value = room.own_answer;
    $('answer').disabled = room.closed || own.status !== 'answering' || room.participants.length < 2;
    $('submit').disabled = room.closed || busy || room.participants.length < 2 || !['answering', 'error'].includes(own.status);
    $('submit').textContent = own.status === 'error' ? 'Bewertung erneut versuchen' : 'Antwort abgeben';
    $('answer-form').hidden = room.revealed;
    $('participants').replaceChildren(...room.participants.map(person => {
      const card = document.createElement('div');
      card.className = 'person';
      const name = document.createElement('strong');
      name.textContent = person.name + (person.id === profile ? ' · Du' : '');
      const state = document.createElement('p');
      state.textContent = `${person.online ? 'Verbunden' : 'Verbindung unterbrochen'} · ${person.ready ? 'Bereit für nächste Frage' : statusNames[person.status]}`;
      card.append(name, state);
      return card;
    }));
    $('round-status').textContent = room.closed ? 'Die Sitzung ist beendet. Du kannst zum Solo-Trainer zurückkehren.'
      : room.error || (room.participants.length < 2 ? 'Teile den Link und warte auf ein zweites Profil.'
      : room.revealed ? 'Beide Antworten sind bewertet.'
      : own.status === 'answering' ? 'Deine Antwort bleibt bis zur gemeinsamen Auflösung privat.'
      : 'Deine Antwort ist abgegeben. Warte auf beide Bewertungen.');
    $('results').hidden = !room.revealed;
    if (room.revealed) {
      $('comparison').replaceChildren(...room.participants.map(person => {
        const card = document.createElement('article');
        card.className = 'person';
        const heading = document.createElement('h3');
        heading.textContent = `${person.name} · ${Math.round(person.result.score * 100)} %`;
        const answer = document.createElement('p');
        answer.className = 'answer-text';
        answer.textContent = person.answer;
        const feedback = document.createElement('p');
        feedback.className = 'answer-text';
        feedback.textContent = person.result.feedback;
        card.append(heading, answer, feedback);
        if (room.mode === 'compete') {
          const total = document.createElement('p');
          total.textContent = `Gesamt: ${person.points} Punkte · ${person.correct} richtige Antworten`;
          card.append(total);
        }
        return card;
      }));
      $('reference').textContent = room.reference_answer;
      const correct = room.participants.reduce((sum, person) => sum + Number(person.result.correct), 0);
      $('summary').textContent = room.mode === 'coop'
        ? `${room.completed} gemeinsame Runden · Diese Frage: ${correct} von 2 Antworten richtig. Besprecht eure Lösungen, bevor ihr weitergeht.`
        : 'Pro Runde sind bis zu 100 Punkte möglich. Die Gesamtpunkte entsprechen den aufsummierten Bewertungsscores.';
      $('ready').disabled = room.closed || busy || own.ready;
      $('ready').textContent = own.ready ? 'Warte auf die andere Person …' : 'Bereit für die nächste Frage';
    }
    $('leave').disabled = room.closed || busy;
    if (!room.closed) remember();
    else sessionStorage.removeItem('trainer_shared_room');
  }

  async function perform(work) {
    if (busy) return;
    busy = true;
    $('status').textContent = '';
    document.querySelectorAll('button[type="submit"]').forEach(button => { button.disabled = true; });
    const sequence = ++requestNumber;
    try {
      const next = await work();
      busy = false;
      render(next, sequence);
    } catch (error) {
      $('status').textContent = error.message;
    } finally {
      busy = false;
      if (room) render(room, appliedNumber);
      else { $('create').disabled = false; $('join').disabled = false; }
    }
  }

  async function join(code) {
    profile = $('profile').value;
    await perform(() => api(`/api/rooms/${encodeURIComponent(code)}/join`, {}));
  }

  async function loadTopics() {
    const sequence = ++fieldRequest;
    $('create').disabled = true;
    try {
      const topics = await api(`/api/fields/${encodeURIComponent($('field').value)}/topics`);
      if (sequence !== fieldRequest) return;
      $('topic').replaceChildren(new Option('Alle Themen', ''), ...topics.map(topic => new Option(typeof topic === 'string' ? topic : topic.name, typeof topic === 'string' ? topic : topic.name)));
      $('create').disabled = false;
    } catch (error) { $('status').textContent = error.message; }
  }

  async function init() {
    const [profilesResponse, fieldsResponse] = await Promise.all([fetch('/api/profiles'), fetch('/api/fields')]);
    if (!profilesResponse.ok || !fieldsResponse.ok) throw new Error('Profile oder Fächer konnten nicht geladen werden.');
    const profiles = await profilesResponse.json();
    const fields = await fieldsResponse.json();
    $('profile').replaceChildren(...profiles.map(person => new Option(person.name, person.id)));
    const savedProfile = localStorage.getItem('trainer_profile');
    if (profiles.some(person => person.id === savedProfile)) $('profile').value = savedProfile;
    $('profile').disabled = false;
    $('field').replaceChildren(...fields.map(field => new Option(field, field)));
    const savedField = localStorage.getItem('trainer_field');
    if (fields.includes(savedField)) $('field').value = savedField;
    $('join').disabled = false;
    $('field').addEventListener('change', loadTopics);
    await loadTopics();
    const inviteCode = new URLSearchParams(location.search).get('room')?.toUpperCase();
    if (inviteCode) $('code').value = inviteCode;
    let saved;
    try { saved = JSON.parse(sessionStorage.getItem('trainer_shared_room')); } catch {}
    if (saved && (!inviteCode || inviteCode === saved.code) && profiles.some(person => person.id === saved.profile)) {
      $('profile').value = saved.profile;
      await join(saved.code);
    }
    $('create-form').addEventListener('submit', event => {
      event.preventDefault();
      profile = $('profile').value;
      perform(() => api('/api/rooms', {field: $('field').value, topic: $('topic').value || null, mode: $('mode').value}));
    });
    $('join-form').addEventListener('submit', event => {
      event.preventDefault();
      join($('code').value.trim().toUpperCase());
    });
    $('answer-form').addEventListener('submit', event => {
      event.preventDefault();
      if (!room || room.closed) return;
      perform(() => api(`/api/rooms/${room.code}/submit`, {round_id: room.round_id, answer: $('answer').value}));
    });
    $('ready').addEventListener('click', () => {
      perform(() => api(`/api/rooms/${room.code}/ready`, {round_id: room.round_id}));
    });
    $('leave').addEventListener('click', () => {
      if (confirm('Gemeinsame Sitzung für beide Profile beenden?')) {
        perform(() => api(`/api/rooms/${room.code}/leave`, {}));
      }
    });
    $('copy').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText($('invite').value); $('status').textContent = 'Einladungslink kopiert.'; }
      catch { $('invite').select(); $('status').textContent = 'Bitte den markierten Link kopieren.'; }
    });
    setInterval(async () => {
      if (!room || room.closed || busy || polling || document.hidden) return;
      polling = true;
      const sequence = ++requestNumber;
      try {
        const next = await api(`/api/rooms/${room.code}`);
        render(next, sequence);
        $('status').textContent = '';
      } catch { $('status').textContent = 'Verbindung unterbrochen. Erneuter Versuch läuft …'; }
      finally { polling = false; }
    }, 1000);
  }
  init().catch(error => { $('status').textContent = error.message; });
})();
