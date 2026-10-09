// A small, deterministic clustered layout. No animation or progress-dependent positions.
function layoutConstellation(topics, placements, edges) {
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  const groups = topics.map((topic, index) => {
    const members = placements.filter(item => item.topicIndex === index);
    const parent = members[0], children = members.slice(1);
    const spacing = Math.max(74, ...children.map(child => child.r * 2 + 32));
    const inner = parent.r + spacing * 0.7;
    children.forEach((child, i) => {
      const angle = i * goldenAngle + index * 0.7;
      const distance = Math.sqrt(inner * inner + (i + 0.5) * spacing * spacing / Math.PI);
      child.lx = Math.cos(angle) * distance;
      child.ly = Math.sin(angle) * distance;
      child.seedX = child.lx; child.seedY = child.ly;
    });
    const radius = Math.max(parent.r + 70, ...children.map(child => Math.hypot(child.lx, child.ly) + child.r + 36));
    return { index, parent, children, radius, cx: 0, cy: 0 };
  });
  // Start with non-overlapping circles, then bring connected clusters together.
  groups.forEach((group, i) => {
    if (!i) return;
    for (let candidate = 1; candidate < 20000; candidate++) {
      const distance = Math.sqrt(candidate) * 45;
      group.cx = Math.cos(candidate * goldenAngle) * distance;
      group.cy = Math.sin(candidate * goldenAngle) * distance;
      if (groups.slice(0, i).every(other => Math.hypot(group.cx - other.cx, group.cy - other.cy) >= group.radius + other.radius + 48)) break;
    }
  });
  const weights = new Map();
  edges.forEach(edge => {
    const a = Math.min(edge.a.topicIndex, edge.b.topicIndex), b = Math.max(edge.a.topicIndex, edge.b.topicIndex);
    if (a !== b) weights.set(`${a}:${b}`, (weights.get(`${a}:${b}`) || 0) + edge.concepts.length);
  });
  function separateGroups() {
    groups.forEach((a, i) => groups.slice(i + 1).forEach(b => {
      const dx = b.cx - a.cx, dy = b.cy - a.cy, distance = Math.hypot(dx, dy) || 1;
      const overlap = a.radius + b.radius + 48 - distance;
      if (overlap > 0) {
        const push = overlap / 2 + 0.01;
        a.cx -= dx / distance * push; a.cy -= dy / distance * push;
        b.cx += dx / distance * push; b.cy += dy / distance * push;
      }
    }));
  }
  for (let step = 0; step < 100; step++) {
    groups.forEach(group => { group.cx *= 0.995; group.cy *= 0.995; });
    weights.forEach((weight, key) => {
      const [ai, bi] = key.split(':').map(Number), a = groups[ai], b = groups[bi];
      const dx = b.cx - a.cx, dy = b.cy - a.cy, distance = Math.hypot(dx, dy) || 1;
      const pull = Math.max(0, distance - a.radius - b.radius - 60) * Math.min(0.08, 0.008 * Math.sqrt(weight));
      a.cx += dx / distance * pull; a.cy += dy / distance * pull;
      b.cx -= dx / distance * pull; b.cy -= dy / distance * pull;
    });
    separateGroups();
  }
  for (let step = 0; step < 40; step++) separateGroups();
  // Relax subtopics inside their cluster, with explicit circle collision avoidance.
  groups.forEach(group => {
    const children = group.children;
    function collide() {
      children.forEach((a, i) => {
        const distance = Math.hypot(a.lx, a.ly) || 1, inner = group.parent.r + a.r + 30;
        if (distance < inner) { a.lx *= inner / distance; a.ly *= inner / distance; }
        children.slice(i + 1).forEach(b => {
          const dx = b.lx - a.lx, dy = b.ly - a.ly, d = Math.hypot(dx, dy) || 1;
          const overlap = a.r + b.r + 30 - d;
          if (overlap > 0) {
            const push = overlap / 2 + 0.01;
            a.lx -= dx / d * push; a.ly -= dy / d * push;
            b.lx += dx / d * push; b.ly += dy / d * push;
          }
        });
        const extent = Math.hypot(a.lx, a.ly), limit = group.radius - a.r - 20;
        if (extent > limit) { a.lx *= limit / extent; a.ly *= limit / extent; }
      });
    }
    const related = edges.filter(edge => edge.a.topicIndex === group.index || edge.b.topicIndex === group.index);
    for (let step = 0; step < (related.length ? 70 : 0); step++) {
      children.forEach(child => { child.lx += (child.seedX - child.lx) * 0.015; child.ly += (child.seedY - child.ly) * 0.015; });
      related.forEach(edge => {
        const local = edge.a.topicIndex === group.index ? edge.a : edge.b;
        const other = local === edge.a ? edge.b : edge.a;
        if (local === group.parent) return;
        if (other.topicIndex === group.index) {
          if (other === group.parent) return;
          const pull = Math.min(0.02, 0.004 * edge.concepts.length);
          local.lx += (other.lx - local.lx) * pull;
          local.ly += (other.ly - local.ly) * pull;
        } else {
          const target = groups[other.topicIndex], dx = target.cx - group.cx, dy = target.cy - group.cy;
          const distance = Math.hypot(dx, dy) || 1;
          local.lx += (dx / distance * group.radius * 0.7 - local.lx) * 0.008;
          local.ly += (dy / distance * group.radius * 0.7 - local.ly) * 0.008;
        }
      });
      collide();
    }
    for (let step = 0; step < 24; step++) collide();
  });
  const left = Math.min(...groups.map(group => group.cx - group.radius)) - 36;
  const top = Math.min(...groups.map(group => group.cy - group.radius)) - 36;
  const right = Math.max(...groups.map(group => group.cx + group.radius)) + 36;
  const bottom = Math.max(...groups.map(group => group.cy + group.radius)) + 36;
  groups.forEach(group => {
    group.cx -= left; group.cy -= top;
    group.parent.cx = group.cx; group.parent.cy = group.cy;
    group.children.forEach(child => { child.cx = group.cx + child.lx; child.cy = group.cy + child.ly; });
  });
  return { groups, bounds: { width: right - left, height: bottom - top } };
}
