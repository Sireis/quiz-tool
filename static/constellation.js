// SVG constellation, sharing the trainer's metadata, preparation states, and quiz flow.
(() => {
  const byId = id => document.getElementById(`constellation-${id}`);
  const dialog = byId('dialog'), svg = byId('svg'), status = byId('status');
  const details = byId('details'), content = byId('detail-content'), info = byId('info');
  const legend = byId('legend'), preparationLegend = byId('preparation-legend');
  const hues = [195, 275, 35, 155, 330, 225, 80, 15];
  const states = {
    unattempted: { label: 'Unversucht', saturation: 0, lightness: 48 },
    red: { label: 'Übungsbedarf', saturation: 12, lightness: 50 },
    yellow: { label: 'Im Aufbau', saturation: 55, lightness: 62 },
    green: { label: 'Gut vorbereitet', saturation: 90, lightness: 72 },
  };
  const stateFor = data => states[data.attempted ? data.preparation.rating : 'unattempted'];
  const hueFor = index => (hues[index % hues.length] + Math.floor(index / hues.length) * 17) % 360;
  const element = (tag, attrs = {}, text) => {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    Object.entries(attrs).forEach(([key, value]) => el.setAttribute(key, value));
    if (text != null) el.textContent = text;
    return el;
  };
  const html = (tag, className, text) => {
    const el = document.createElement(tag);
    el.className = className;
    if (text != null) el.textContent = text;
    return el;
  };
  Object.entries(states).forEach(([key, state]) => {
    const sample = html('span', `preparation-island-sample island-${key}`, state.label);
    sample.style.setProperty('--island-color', `hsl(195 ${state.saturation}% ${state.lightness}%)`);
    preparationLegend.append(sample);
  });
  let world, bounds, layout, placements = [], edges = [], selected = null;
  let scale = 1, x = 0, y = 0, width = 1000, height = 640, requestId = 0, moved = false;
  let drag = null, pinch = null;
  const pointers = new Map();
  const point = event => new DOMPoint(event.clientX, event.clientY).matrixTransform(svg.getScreenCTM().inverse());
  function highlight(item = null, edge = null) {
    const related = new Set();
    edges.forEach(link => {
      const active = link === edge || (item && (item.subtopic
        ? link.a === item || link.b === item
        : link.a.topicIndex === item.topicIndex || link.b.topicIndex === item.topicIndex));
      link.path.classList.toggle('concept-link-active', Boolean(active));
      if (active) { related.add(link.a); related.add(link.b); }
    });
    placements.forEach(node => {
      node.group.classList.toggle('node-selected', node === item);
      node.group.classList.toggle('concept-related', related.has(node));
    });
  }
  function closeDetails(restoreFocus = false) {
    const previous = selected;
    selected = null;
    details.hidden = true;
    dialog.classList.toggle('details-open', false);
    highlight();
    if (restoreFocus) (previous?.group || previous?.button || byId('info-open')).focus();
  }
  function closeInfo() { info.hidden = true; byId('info-open').setAttribute('aria-expanded', 'false'); }
  function showDetails(title, eyebrow, paragraphs, action) {
    closeInfo();
    content.replaceChildren(html('p', 'detail-eyebrow', eyebrow));
    const heading = html('h3', '', title);
    heading.id = 'constellation-detail-title'; heading.tabIndex = -1;
    content.append(heading);
    paragraphs.forEach(text => content.append(html('p', 'detail-text', text)));
    if (action) {
      const button = html('button', 'primary', 'Quiz starten →');
      button.type = 'button'; button.addEventListener('click', action);
      content.append(button);
    }
    details.hidden = false;
    dialog.classList.toggle('details-open', true);
    heading.focus({ preventScroll: true });
  }
  function inspectNode(item) {
    selected = item;
    highlight(item);
    const data = item.data, state = stateFor(data), counts = data.preparation.counts;
    const paragraphs = [`${state.label} · ${data.total} Fragen · ${data.attempted} bearbeitet`];
    if (counts) paragraphs.push(`Übungsbedarf: ${counts.red} · Im Aufbau: ${counts.yellow} · Gut vorbereitet: ${counts.green}`);
    if (data.concepts?.length) paragraphs.push(`Konzepte: ${data.concepts.join(' · ')}`);
    showDetails(data.name, item.subtopic ? item.topic : 'Thema', paragraphs, () => startQuiz(item));
    if (!item.subtopic && item.data.children.length) {
      const focus = html('button', 'secondary', 'Thema im Netz ansehen');
      focus.type = 'button'; focus.addEventListener('click', () => focusCluster(item.topicIndex));
      content.append(focus);
    }
  }
  function inspectEdge(edge) {
    selected = edge;
    highlight(null, edge);
    showDetails(`${edge.a.data.name} ↔ ${edge.b.data.name}`, 'Gemeinsame Konzepte',
      [`${edge.a.topic} · ${edge.b.topic}`, edge.concepts.join(' · ')], null);
  }
  async function startQuiz(item) {
    dialog.close();
    sel.topic = item.topic; sel.subtopic = item.subtopic;
    sel.set = sel.examen = null;
    highlightSel('topic', item.topic); highlightSel('set', null); highlightSel('examen', null);
    updateHeaderCtx(); mobileGoMain();
    await Promise.all([refreshStats(), loadNextQuestion()]);
  }
  function transform() {
    if (!world) return;
    world.setAttribute('transform', `translate(${x} ${y}) scale(${scale})`);
    world.style.setProperty('--label-size', `${12 / scale}px`);
    placements.forEach(item => {
      item.hit.setAttribute('r', Math.max(item.r + 8, 16 / scale));
      item.label.setAttribute('y', item.r + 20 / scale);
    });
    // Topic names keep a readable screen size; omit colliding labels in the overview.
    const visible = [];
    placements.filter(item => !item.subtopic).forEach(item => {
      const sx = item.cx * scale + x, sy = (item.cy + item.r) * scale + y + 20;
      const box = { x: sx - 70, y: sy - 14 };
      const overlaps = visible.some(other => Math.abs(other.x - box.x) < 140 && Math.abs(other.y - box.y) < 36);
      item.label.classList.toggle('label-collides', overlaps);
      if (!overlaps) visible.push(box);
    });
  }
  function fit() {
    if (!bounds) return;
    width = svg.clientWidth || 1000; height = svg.clientHeight || 640;
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    scale = Math.min(2, (width - 40) / bounds.width, (height - 120) / bounds.height);
    x = (width - bounds.width * scale) / 2; y = 64 + (height - 120 - bounds.height * scale) / 2;
    transform();
  }
  function focusCluster(index) {
    const group = layout.groups[index];
    closeDetails();
    scale = Math.min(2.5, (width - 40) / (group.radius * 2), (height - 120) / (group.radius * 2));
    x = width / 2 - group.cx * scale; y = height / 2 - group.cy * scale;
    transform();
  }
  function zoom(factor, center = { x: width / 2, y: height / 2 }) {
    const next = Math.min(6, Math.max(0.03, scale * factor));
    x = center.x - (center.x - x) * next / scale; y = center.y - (center.y - y) * next / scale;
    scale = next; transform();
  }
  const curve = (a, b, bend = 0.12) => {
    const mx = (a.cx + b.cx) / 2, my = (a.cy + b.cy) / 2;
    return `M ${a.cx} ${a.cy} Q ${mx + (b.cy - a.cy) * bend} ${my - (b.cx - a.cx) * bend} ${b.cx} ${b.cy}`;
  };
  function render(topics) {
    svg.replaceChildren(); placements = []; edges = [];
    const defs = element('defs');
    world = element('g', { class: 'constellation-world' });
    svg.append(defs, world);
    const clouds = element('g', { class: 'constellation-clouds' });
    const hierarchy = element('g', { class: 'constellation-links' });
    const concepts = element('g', { class: 'constellation-concept-links' });
    const nodes = element('g', { class: 'constellation-nodes' });
    world.append(clouds, hierarchy, concepts, nodes);
    legend.replaceChildren();
    const hierarchyEdges = [];
    function node(data, topicIndex, subtopic = null) {
      const topic = topics[topicIndex].name, hue = hueFor(topicIndex), state = stateFor(data);
      const key = data.attempted ? data.preparation.rating : 'unattempted';
      const color = `hsl(${hue} 65% 68%)`, nodeColor = `hsl(${hue} ${state.saturation}% ${state.lightness}%)`;
      const r = 12 + Math.sqrt(data.total) * 2.2;
      const group = element('g', { class: `constellation-node island-${key}${subtopic ? '' : ' topic-node'}`, tabindex: '0', role: 'button',
        'aria-label': `${data.name}: ${state.label}, ${data.total} Fragen. Details öffnen.`, style: `--topic-color:${color};--node-color:${nodeColor}` });
      group.append(element('circle', { r: r + 9, class: 'node-halo' }),
        element('circle', { r, class: 'node-core', 'stroke-dasharray': data.attempted ? 'none' : '3 4' }));
      const hit = element('circle', { r: r + 8, class: 'node-hit' });
      const label = element('text', { 'text-anchor': 'middle', class: `node-label${subtopic ? ' subtopic-label' : ''}` });
      // Full names stay in the detail sheet, where they can wrap naturally.
      const name = data.name.length > 36 ? data.name.slice(0, 34) + '…' : data.name;
      const split = name.length > 18 ? Math.max(1, name.lastIndexOf(' ', 18)) : name.length;
      const cut = split < 6 ? 18 : split;
      label.append(element('tspan', { x: 0 }, name.slice(0, cut)));
      if (cut < name.length) label.append(element('tspan', { x: 0, dy: '1.2em' }, name.slice(cut).trim()));
      group.append(hit, label);
      const item = { data, topic, subtopic, topicIndex, color, r, cx: 0, cy: 0, group, hit, label, concepts: data.concepts || [] };
      group.addEventListener('click', event => { event.stopPropagation(); if (!moved) inspectNode(item); });
      group.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); inspectNode(item); }
      });
      nodes.append(group); placements.push(item);
      return item;
    }
    topics.forEach((topic, index) => {
      const parent = node(topic, index);
      parent.concepts = topic.children.length ? topic.direct_concepts || [] : parent.concepts;
      topic.children.forEach(child => hierarchyEdges.push({ a: parent, b: node(child, index, child.name) }));
      const swatch = html('span', '', topic.name); swatch.style.setProperty('--node-color', parent.color); legend.append(swatch);
    });
    const conceptNodes = new Map(), pairs = new Map();
    placements.forEach((item, index) => new Set(item.concepts).forEach(concept => {
      if (!conceptNodes.has(concept)) conceptNodes.set(concept, []);
      conceptNodes.get(concept).push(index);
    }));
    conceptNodes.forEach((indices, concept) => indices.forEach((a, i) => indices.slice(i + 1).forEach(b => {
      const key = `${a}:${b}`;
      if (!pairs.has(key)) pairs.set(key, { a: placements[a], b: placements[b], concepts: [] });
      pairs.get(key).concepts.push(concept);
    })));
    edges = [...pairs.values()];
    layout = layoutConstellation(topics, placements, edges); bounds = layout.bounds;
    placements.forEach(item => item.group.setAttribute('transform', `translate(${item.cx} ${item.cy})`));
    hierarchyEdges.forEach(({ a, b }) => hierarchy.append(element('path', { d: curve(a, b, 0.08), style: `--link-color:${a.color}` })));
    layout.groups.forEach(cluster => {
      const state = stateFor(topics[cluster.index]), key = topics[cluster.index].attempted ? topics[cluster.index].preparation.rating : 'unattempted';
      const gradient = element('radialGradient', { id: `constellation-cloud-${cluster.index}` });
      const color = `hsl(${hueFor(cluster.index)} ${Math.max(18, state.saturation)}% ${state.lightness}%)`;
      gradient.append(element('stop', { offset: '0%', 'stop-color': color, 'stop-opacity': '.25' }),
        element('stop', { offset: '55%', 'stop-color': color, 'stop-opacity': '.08' }),
        element('stop', { offset: '100%', 'stop-color': color, 'stop-opacity': '0' }));
      defs.append(gradient);
      const cloud = element('g', { class: `topic-cloud island-${key}`, style: `--island-color:${color}` });
      cloud.append(element('ellipse', { cx: cluster.cx, cy: cluster.cy, rx: cluster.radius * 1.12, ry: cluster.radius,
        fill: `url(#constellation-cloud-${cluster.index})` }));
      clouds.append(cloud);
    });
    edges.forEach(edge => {
      const d = curve(edge.a, edge.b, 0.16);
      const button = element('g', { class: 'concept-connection', tabindex: '0', role: 'button',
        'aria-label': `${edge.a.data.name} und ${edge.b.data.name}: ${edge.concepts.join(', ')}. Verbindung erklären.` });
      const path = element('path', { d, class: 'concept-line', 'stroke-width': Math.min(2, 0.6 + Math.sqrt(edge.concepts.length) * 0.35) });
      path.append(element('title', {}, edge.concepts.join(', ')));
      button.append(path, element('path', { d, class: 'concept-hit' }));
      button.addEventListener('click', event => { event.stopPropagation(); if (!moved) inspectEdge(edge); });
      button.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); inspectEdge(edge); }
      });
      edge.path = path; edge.button = button; concepts.append(button);
    });
    fit();
  }
  byId('open').addEventListener('click', async () => {
    const id = ++requestId, field = sel.field;
    byId('field').textContent = field || ''; dialog.showModal(); closeDetails(); closeInfo();
    svg.replaceChildren(); world = bounds = null; legend.replaceChildren();
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
  byId('close').onclick = () => dialog.close();
  byId('detail-close').onclick = () => closeDetails(true);
  byId('info-open').onclick = () => {
    const opening = info.hidden;
    closeDetails(); info.hidden = !opening;
    byId('info-open').setAttribute('aria-expanded', String(opening));
    if (opening) byId('info-close').focus();
  };
  byId('info-close').onclick = () => { closeInfo(); byId('info-open').focus(); };
  dialog.addEventListener('cancel', event => {
    if (!info.hidden || !details.hidden) { event.preventDefault(); closeInfo(); closeDetails(true); }
  });
  dialog.addEventListener('close', () => { ++requestId; closeDetails(); closeInfo(); pointers.clear(); drag = pinch = null; });
  byId('plus').onclick = () => zoom(1.3);
  byId('minus').onclick = () => zoom(1 / 1.3);
  byId('fit').onclick = fit;
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => { if (dialog.open) fit(); }).observe(svg);
  svg.addEventListener('click', () => { if (!moved) { closeDetails(); closeInfo(); } });
  svg.addEventListener('wheel', event => { event.preventDefault(); zoom(Math.exp(-event.deltaY * 0.0015), point(event)); }, { passive: false });
  const pinchState = () => {
    const [a, b] = [...pointers.values()];
    return { distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, scale, x, y };
  };
  svg.addEventListener('pointerdown', event => {
    if (event.button !== 0 || pointers.size >= 2) return;
    const p = point(event); pointers.set(event.pointerId, p);
    if (pointers.size === 1) { drag = { id: event.pointerId, start: p, x, y }; moved = false; }
    if (pointers.size === 2) { pinch = pinchState(); moved = true; }
  });
  svg.addEventListener('pointermove', event => {
    if (!pointers.has(event.pointerId)) return;
    const p = point(event); pointers.set(event.pointerId, p);
    if (pointers.size === 2 && pinch) {
      const next = pinchState();
      scale = Math.min(6, Math.max(0.03, pinch.scale * next.distance / pinch.distance));
      x = next.center.x - (pinch.center.x - pinch.x) * scale / pinch.scale;
      y = next.center.y - (pinch.center.y - pinch.y) * scale / pinch.scale;
      moved = true; svg.setPointerCapture(event.pointerId); transform();
    } else if (drag && drag.id === event.pointerId) {
      const dx = p.x - drag.start.x, dy = p.y - drag.start.y;
      if (Math.hypot(dx, dy) > 5) { moved = true; svg.setPointerCapture(event.pointerId); x = drag.x + dx; y = drag.y + dy; transform(); }
    }
  });
  function endPointer(event) {
    pointers.delete(event.pointerId); pinch = null;
    const [remaining] = pointers.entries();
    drag = remaining ? { id: remaining[0], start: remaining[1], x, y } : null;
  }
  svg.addEventListener('pointerup', endPointer);
  svg.addEventListener('pointercancel', event => { moved = true; endPointer(event); });
  svg.addEventListener('lostpointercapture', endPointer);
  svg.addEventListener('pointerleave', event => { if (!svg.hasPointerCapture(event.pointerId)) endPointer(event); });
})();
