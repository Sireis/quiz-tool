// A deterministic SVG map: no simulation, dependencies, or new mastery rules.
(() => {
  const dialog = document.getElementById('constellation-dialog');
  const svg = document.getElementById('constellation-svg');
  const tooltip = document.getElementById('constellation-tooltip');
  const status = document.getElementById('constellation-status');
  const legend = document.getElementById('constellation-legend');
  const preparationLegend = document.getElementById('constellation-preparation-legend');
  const topicHues = [195, 275, 35, 155, 330, 225, 80, 15];
  const islandStates = {
    unattempted: { label: 'Unversucht', saturation: 0, lightness: 38 },
    red: { label: 'Übungsbedarf', saturation: 8, lightness: 42 },
    yellow: { label: 'Im Aufbau', saturation: 55, lightness: 55 },
    green: { label: 'Gut vorbereitet', saturation: 90, lightness: 65 },
  };
  Object.entries(islandStates).forEach(([key, state]) => {
    const sample = document.createElement('span');
    sample.className = `preparation-island-sample island-${key}`;
    sample.style.setProperty('--island-color', `hsl(195 ${state.saturation}% ${state.lightness}%)`);
    sample.textContent = state.label;
    preparationLegend.append(sample);
  });
  let world, bounds, scale = 1, x = 0, y = 0, drag, moved = false, requestId = 0;
  let viewportWidth = 1000, viewportHeight = 640;
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
    viewportWidth = svg.clientWidth || 1000;
    viewportHeight = svg.clientHeight || 640;
    svg.setAttribute('viewBox', `0 0 ${viewportWidth} ${viewportHeight}`);
    scale = Math.min(1.5, (viewportWidth - 80) / bounds.width, (viewportHeight - 80) / bounds.height);
    x = (viewportWidth - bounds.width * scale) / 2;
    y = (viewportHeight - bounds.height * scale) / 2;
    transform();
  }
  function zoom(factor, center = { x: viewportWidth / 2, y: viewportHeight / 2 }) {
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
    if (node.concepts?.length) {
      const concepts = document.createElement('div');
      concepts.className = 'tooltip-concepts';
      concepts.textContent = `Konzepte: ${node.concepts.slice(0, 6).join(' · ')}${node.concepts.length > 6 ? ` · +${node.concepts.length - 6} weitere` : ''}`;
      tooltip.append(concepts);
    }
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
    const islands = element('g', { class: 'constellation-islands' });
    const links = element('g', { class: 'constellation-links' });
    const conceptLinks = element('g', { class: 'constellation-concept-links' });
    const nodes = element('g');
    world.append(islands, links, conceptLinks, nodes);
    const placements = [], conceptEdges = [], hierarchyEdges = [];
    legend.replaceChildren();
    function highlightConcepts(data, topic, subtopic) {
      const related = new Set();
      conceptEdges.forEach(edge => {
        const active = data && (subtopic
          ? edge.a.data === data || edge.b.data === data
          : edge.a.topic === topic || edge.b.topic === topic);
        edge.path.classList.toggle('concept-link-active', Boolean(active));
        if (active) { related.add(edge.a); related.add(edge.b); }
      });
      placements.forEach(item => item.group.classList.toggle('concept-related', related.has(item)));
    }
    function node(data, topicIndex, subtopic = null) {
      const topic = topics[topicIndex].name;
      const hue = topicHues[topicIndex % topicHues.length] + Math.floor(topicIndex / topicHues.length) * 17;
      const color = `hsl(${hue % 360} 65% 68%)`;
      const r = 8 + Math.sqrt(data.total) * 2.2;
      const label = `${data.name}: ${data.attempted ? PREPARATION_LABELS[data.preparation.rating] : 'Noch nicht versucht'}, ${data.total} Fragen. Quiz starten.`;
      const group = element('g', { class: 'constellation-node', tabindex: '0', role: 'button', 'aria-label': label, style: `--node-color:${color}` });
      group.append(element('circle', { r: r + 9, class: 'node-halo' }), element('circle', { r, class: 'node-core' }));
      const text = element('text', { y: r + 22, 'text-anchor': 'middle', class: subtopic ? 'node-label subtopic-label' : 'node-label' }, data.name.length > 30 ? data.name.slice(0, 28) + '…' : data.name);
      group.append(text);
      const inspect = () => {
        highlightConcepts(data, topic, subtopic);
        showTooltip(data, subtopic ? topic : null, group);
      };
      const clear = () => { tooltip.hidden = true; highlightConcepts(null); };
      group.addEventListener('pointerenter', () => { if (!drag) inspect(); });
      group.addEventListener('pointerleave', clear);
      group.addEventListener('focus', inspect);
      group.addEventListener('blur', clear);
      group.addEventListener('click', () => { if (!moved) startQuiz(topic, subtopic); });
      group.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); startQuiz(topic, subtopic); }
      });
      nodes.append(group);
      return { data, cx: 0, cy: 0, r, topic, topicIndex, color, group, concepts: data.concepts || [] };
    }
    topics.forEach((topic, index) => {
      const parent = node(topic, index);
      // Parent aggregates are not independent evidence for a concept connection.
      parent.concepts = topic.children.length ? topic.direct_concepts || [] : parent.concepts;
      placements.push(parent);
      topic.children.forEach(child => {
        const placement = node(child, index, child.name);
        const line = element('path', { style: `--link-color:${parent.color}` });
        links.append(line);
        hierarchyEdges.push({ a: parent, b: placement, line });
        placements.push(placement);
      });
      const swatch = document.createElement('span');
      swatch.textContent = topic.name;
      swatch.style.setProperty('--node-color', parent.color);
      legend.append(swatch);
    });
    const conceptNodes = new Map(), pairs = new Map();
    placements.forEach((item, index) => {
      new Set(item.concepts).forEach(concept => {
        if (!conceptNodes.has(concept)) conceptNodes.set(concept, []);
        conceptNodes.get(concept).push(index);
      });
    });
    conceptNodes.forEach((indices, concept) => {
      indices.forEach((a, i) => indices.slice(i + 1).forEach(b => {
        const key = `${a}:${b}`;
        if (!pairs.has(key)) pairs.set(key, { a: placements[a], b: placements[b], concepts: [] });
        pairs.get(key).concepts.push(concept);
      }));
    });
    const layout = layoutConstellation(topics, placements, [...pairs.values()]);
    bounds = layout.bounds;
    placements.forEach(item => item.group.setAttribute('transform', `translate(${item.cx} ${item.cy})`));
    hierarchyEdges.forEach(({ a, b, line }) => {
      line.setAttribute('d', `M ${a.cx} ${a.cy + a.r} C ${a.cx} ${b.cy - 60} ${b.cx} ${b.cy - 60} ${b.cx} ${b.cy}`);
    });
    layout.groups.forEach(cluster => {
      const topic = topics[cluster.index];
      cluster.parent.group.style.setProperty('--topic-label-cap', `${(cluster.width - 60) / (Math.min(topic.name.length, 29) * 0.65)}px`);
      const hue = topicHues[cluster.index % topicHues.length] + Math.floor(cluster.index / topicHues.length) * 17;
      const stateKey = topic.attempted ? topic.preparation.rating : 'unattempted';
      const state = islandStates[stateKey];
      const island = element('g', { class: `topic-island island-${stateKey}`, style: `--island-color:hsl(${hue % 360} ${state.saturation}% ${state.lightness}%)` });
      const rect = element('rect', { class: 'island-background', x: cluster.x, y: cluster.y, width: cluster.width, height: cluster.height, rx: 30,
        'stroke-dasharray': topic.attempted ? 'none' : '5 7' });
      island.append(rect, element('title', {}, `${topic.name}: ${state.label} (schwächste Frage)`));
      // Keep the status and breakdown above the links, with dedicated footer space.
      const annotation = element('g', { class: 'island-annotation',
        role: 'img', 'aria-label': `${topic.name}: ${state.label}. ${topic.attempted}/${topic.total} Fragen bearbeitet.` });
      const counts = topic.preparation.counts || { red: 0, yellow: 0, green: 0 };
      const description = `Übungsbedarf: ${counts.red}, im Aufbau: ${counts.yellow}, gut vorbereitet: ${counts.green}. Unversuchte Fragen zählen zum Übungsbedarf.`;
      const strip = element('g', { class: 'island-preparation-strip', role: 'img', 'aria-label': description });
      const stripWidth = Math.min(120, cluster.width - 48), stripY = cluster.y + cluster.height - 24;
      const stripX = cluster.x + (cluster.width - stripWidth) / 2;
      strip.append(element('rect', { x: stripX, y: stripY, width: stripWidth, height: 3, rx: 1.5, class: 'island-strip-track' }));
      let offset = 0;
      ['red', 'yellow', 'green'].forEach(color => {
        const width = topic.total ? counts[color] / topic.total * stripWidth : 0;
        if (width > 0) strip.append(element('rect', { x: stripX + offset, y: stripY, width, height: 3, class: `island-strip-segment preparation-${color}` }));
        offset += width;
      });
      strip.append(element('title', {}, description));
      annotation.append(strip);
      nodes.append(annotation);
      islands.append(island);
    });
    pairs.forEach(edge => {
      const { a, b } = edge;
      const mx = (a.cx + b.cx) / 2, my = (a.cy + b.cy) / 2;
      const path = element('path', {
        d: `M ${a.cx} ${a.cy} Q ${mx + (b.cy - a.cy) * 0.12} ${my - (b.cx - a.cx) * 0.12} ${b.cx} ${b.cy}`,
        'stroke-width': Math.min(3, 0.8 + Math.sqrt(edge.concepts.length) * 0.5),
      });
      path.append(element('title', {}, `${a.data.name} ↔ ${b.data.name}: ${edge.concepts.join(', ')}`));
      edge.path = path;
      conceptEdges.push(edge);
      conceptLinks.append(path);
    });
    fit();
  }
  document.getElementById('constellation-open').addEventListener('click', async () => {
    const id = ++requestId, field = sel.field;
    document.getElementById('constellation-field').textContent = field || '';
    dialog.showModal();
    svg.replaceChildren();
    world = bounds = null;
    legend.replaceChildren();
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
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => { if (dialog.open) fit(); }).observe(svg);
  }
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
