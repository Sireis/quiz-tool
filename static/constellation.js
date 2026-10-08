// A deterministic SVG map: no simulation, dependencies, or new mastery rules.
(() => {
  const dialog = document.getElementById('constellation-dialog');
  const svg = document.getElementById('constellation-svg');
  const tooltip = document.getElementById('constellation-tooltip');
  const status = document.getElementById('constellation-status');
  const colors = { neutral: '#8798b2', red: '#e47c70', yellow: '#e0b860', green: '#6cdbb1' };
  let world, bounds, scale = 1, x = 0, y = 0, drag, moved = false, requestId = 0;
  const element = (tag, attrs = {}, text) => {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    Object.entries(attrs).forEach(([key, value]) => el.setAttribute(key, value));
    if (text != null) el.textContent = text;
    return el;
  };
  const point = event => new DOMPoint(event.clientX, event.clientY).matrixTransform(svg.getScreenCTM().inverse());
  function transform() {
    if (world) {
      world.setAttribute('transform', `translate(${x} ${y}) scale(${scale})`);
      world.classList.toggle('overview', scale < 0.65);
      world.style.setProperty('--topic-label-size', `${Math.min(48, Math.max(13, 13 / scale))}px`);
    }
    tooltip.hidden = true;
  }
  function fit() {
    if (!bounds) return;
    scale = Math.min(1.5, 920 / bounds.width, 560 / bounds.height);
    x = (1000 - bounds.width * scale) / 2;
    y = (640 - bounds.height * scale) / 2;
    transform();
  }
  function zoom(factor, center = { x: 500, y: 320 }) {
    const next = Math.min(5, Math.max(0.08, scale * factor));
    x = center.x - (center.x - x) * next / scale;
    y = center.y - (center.y - y) * next / scale;
    scale = next;
    transform();
  }
  function showTooltip(node, topic, group) {
    const rating = node.attempted ? PREPARATION_LABELS[node.preparation.rating] : 'Noch nicht versucht';
    tooltip.replaceChildren();
    const title = document.createElement('strong');
    title.textContent = node.name;
    const detail = document.createElement('div');
    detail.textContent = `${rating} · ${node.total} Fragen · ${node.attempted} bearbeitet`;
    const hint = document.createElement('small');
    hint.textContent = `${topic ? topic + ' · ' : ''}Klicken / Enter: Quiz starten`;
    tooltip.append(title, detail, hint);
    tooltip.hidden = false;
    const box = group.getBoundingClientRect();
    const stage = svg.parentElement.getBoundingClientRect();
    tooltip.style.left = `${Math.max(8, Math.min(stage.width - tooltip.offsetWidth - 8, box.x - stage.x + box.width / 2))}px`;
    tooltip.style.top = `${Math.max(8, Math.min(stage.height - tooltip.offsetHeight - 8, box.y - stage.y + box.height + 10))}px`;
  }
  async function startQuiz(topic, subtopic) {
    dialog.close();
    sel.topic = topic;
    sel.subtopic = subtopic;
    sel.set = sel.examen = null;
    highlightSel('topic', topic);
    highlightSel('set', null);
    highlightSel('examen', null);
    updateHeaderCtx();
    mobileGoMain();
    await Promise.all([refreshStats(), loadNextQuestion()]);
  }
  function render(topics) {
    svg.replaceChildren();
    world = element('g');
    svg.append(world);
    const links = element('g', { class: 'constellation-links' });
    const nodes = element('g');
    world.append(links, nodes);
    // Each topic owns a spacious cluster; sorted metadata keeps positions stable.
    function childPosition(index) {
      let ring = 1;
      while (index >= ring * 6) { index -= ring * 6; ring++; }
      const angle = -Math.PI / 2 + (index + (ring % 2) * 0.5) * Math.PI * 2 / (ring * 6);
      return { x: ring * 150 * Math.cos(angle), y: ring * 150 * Math.sin(angle), radius: ring * 150 };
    }
    const largest = Math.max(1, ...topics.map(t => t.children.length));
    const radius = childPosition(largest - 1).radius;
    const cell = radius * 2 + 160;
    const columns = Math.max(1, Math.ceil(Math.sqrt(topics.length)));
    bounds = { width: columns * cell, height: Math.ceil(topics.length / columns) * cell };
    function node(data, cx, cy, topic, subtopic = null) {
      const color = colors[data.attempted ? data.preparation.rating : 'neutral'];
      const r = 8 + Math.sqrt(data.total) * 2.2;
      const label = `${data.name}: ${data.attempted ? PREPARATION_LABELS[data.preparation.rating] : 'Noch nicht versucht'}, ${data.total} Fragen. Quiz starten.`;
      const group = element('g', { transform: `translate(${cx} ${cy})`, class: 'constellation-node', tabindex: '0', role: 'button', 'aria-label': label, style: `--node-color:${color}` });
      group.append(element('circle', { r: r + 9, class: 'node-halo' }), element('circle', { r, class: 'node-core', 'stroke-dasharray': data.attempted ? 'none' : '3 4' }));
      const text = element('text', { y: r + 22, 'text-anchor': 'middle', class: subtopic ? 'node-label subtopic-label' : 'node-label' }, data.name.length > 30 ? data.name.slice(0, 28) + '…' : data.name);
      group.append(text);
      group.addEventListener('pointerenter', () => { if (!drag) showTooltip(data, subtopic ? topic : null, group); });
      group.addEventListener('pointerleave', () => { tooltip.hidden = true; });
      group.addEventListener('focus', () => showTooltip(data, subtopic ? topic : null, group));
      group.addEventListener('blur', () => { tooltip.hidden = true; });
      group.addEventListener('click', () => { if (!moved) startQuiz(topic, subtopic); });
      group.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); startQuiz(topic, subtopic); }
      });
      nodes.append(group);
    }
    topics.forEach((topic, index) => {
      const cx = (index % columns + 0.5) * cell;
      const cy = (Math.floor(index / columns) + 0.5) * cell;
      node(topic, cx, cy, topic.name);
      topic.children.forEach((child, i) => {
        const position = childPosition(i);
        const px = cx + position.x, py = cy + position.y;
        links.append(element('line', { x1: cx, y1: cy, x2: px, y2: py }));
        node(child, px, py, topic.name, child.name);
      });
    });
    fit();
  }
  document.getElementById('constellation-open').addEventListener('click', async () => {
    const id = ++requestId, field = sel.field;
    document.getElementById('constellation-field').textContent = field || '';
    dialog.showModal();
    svg.replaceChildren();
    world = bounds = null;
    status.textContent = 'Dein Wissensnetz wird geladen…';
    try {
      const response = await fetch(`/api/fields/${encodeURIComponent(field)}/constellation`);
      if (!response.ok) throw new Error('Fehler beim Laden. Bitte erneut öffnen.');
      const topics = await response.json();
      if (id !== requestId || !dialog.open) return;
      status.textContent = topics.length ? '' : 'Noch keine Themen vorhanden.';
      if (topics.length) render(topics);
    } catch (error) { if (id === requestId) status.textContent = error.message; }
  });
  document.getElementById('constellation-close').onclick = () => dialog.close();
  dialog.addEventListener('close', () => { ++requestId; tooltip.hidden = true; drag = null; });
  document.getElementById('constellation-plus').onclick = () => zoom(1.25);
  document.getElementById('constellation-minus').onclick = () => zoom(0.8);
  document.getElementById('constellation-fit').onclick = fit;
  svg.addEventListener('wheel', event => { event.preventDefault(); zoom(Math.exp(-event.deltaY * 0.0015), point(event)); }, { passive: false });
  svg.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    const p = point(event);
    drag = { id: event.pointerId, start: p, x, y };
    moved = false;
  });
  svg.addEventListener('pointermove', event => {
    if (!drag || drag.id !== event.pointerId) return;
    const p = point(event), dx = p.x - drag.start.x, dy = p.y - drag.start.y;
    if (Math.hypot(dx, dy) > 5) {
      moved = true;
      svg.setPointerCapture(event.pointerId);
      x = drag.x + dx; y = drag.y + dy;
      transform();
    }
  });
  const endDrag = () => { drag = null; };
  svg.addEventListener('pointerup', endDrag);
  svg.addEventListener('pointercancel', endDrag);
  svg.addEventListener('lostpointercapture', endDrag);
  svg.addEventListener('pointerleave', event => {
    if (!svg.hasPointerCapture(event.pointerId)) endDrag();
  });
})();
