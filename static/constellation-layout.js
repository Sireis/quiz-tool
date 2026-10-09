// Fixed, bounded layout optimization. Positions depend on metadata, never progress.
function layoutConstellation(topics, placements, edges) {
  const gap = 90, padding = 42;
  const groups = topics.map((topic, index) => {
    const members = placements.filter(item => item.topicIndex === index);
    const parent = members[0], children = members.slice(1);
    const largestChild = Math.max(0, ...children.map(child => child.r));
    const cellWidth = Math.max(220, largestChild * 2 + 50);
    const cellHeight = Math.max(115, largestChild * 2 + 65);
    const columns = Math.max(1, Math.ceil(Math.sqrt(children.length)));
    const header = Math.max(120, parent.r * 2 + 70);
    const slots = children.map((_, i) => ({
      x: padding + cellWidth * (i % columns + 0.5),
      y: padding + header + cellHeight * (Math.floor(i / columns) + 0.5),
    }));
    return { index, parent, children, slots, width: Math.max(320, columns * cellWidth + padding * 2),
      height: padding * 2 + header + Math.ceil(children.length / columns) * cellHeight + 84 };
  });
  const targetWidth = Math.max(...groups.map(group => group.width),
    Math.sqrt(groups.reduce((sum, group) => sum + (group.width + gap) * (group.height + gap), 0) * 1.4));
  let order = groups.slice(), bounds;
  function position(group) {
    group.parent.cx = group.x + group.width / 2;
    group.parent.cy = group.y + padding + group.parent.r;
    group.children.forEach((child, i) => {
      child.cx = group.x + group.slots[i].x;
      child.cy = group.y + group.slots[i].y;
    });
  }
  function pack() {
    let x = gap / 2, y = gap / 2, rowHeight = 0, width = 0;
    order.forEach(group => {
      if (x > gap / 2 && x + group.width > targetWidth) { x = gap / 2; y += rowHeight + gap; rowHeight = 0; }
      group.x = x; group.y = y;
      position(group);
      x += group.width + gap;
      rowHeight = Math.max(rowHeight, group.height);
      width = Math.max(width, x - gap / 2);
    });
    bounds = { width, height: y + rowHeight + gap / 2 };
  }
  // Use all links for distance, and a bounded sample for crossing penalties.
  const crossingEdges = edges.slice().sort((a, b) => b.concepts.length - a.concepts.length).slice(0, 60);
  const turn = (a, b, c) => (b.cx - a.cx) * (c.cy - a.cy) - (b.cy - a.cy) * (c.cx - a.cx);
  function score() {
    let cost = edges.reduce((sum, edge) => sum + edge.concepts.length *
      ((edge.a.cx - edge.b.cx) ** 2 + (edge.a.cy - edge.b.cy) ** 2), 0);
    crossingEdges.forEach((edge, i) => {
      for (let j = i + 1; j < crossingEdges.length; j++) {
        const other = crossingEdges[j];
        if (edge.a === other.a || edge.a === other.b || edge.b === other.a || edge.b === other.b) continue;
        if (turn(edge.a, edge.b, other.a) * turn(edge.a, edge.b, other.b) < 0 &&
            turn(other.a, other.b, edge.a) * turn(other.a, other.b, edge.b) < 0) cost += 40000;
      }
    });
    return cost;
  }
  pack();
  let best = score();
  const swap = (items, a, b) => { [items[a], items[b]] = [items[b], items[a]]; };
  // Accept only improvements: deterministic, finite, with no on-screen motion.
  for (let pass = 0; pass < 2 && edges.length; pass++) {
    for (let a = 0; a < order.length; a++) {
      for (let b = a + 1; b < order.length; b++) {
        swap(order, a, b); pack();
        const candidate = score();
        if (candidate < best - 0.01) best = candidate;
        else { swap(order, a, b); pack(); }
      }
    }
    groups.forEach(group => {
      if (!edges.some(edge => edge.a.topicIndex === group.index || edge.b.topicIndex === group.index)) return;
      for (let a = 0; a < group.children.length; a++) {
        // Bound work for large banks while allowing long-distance slot swaps.
        const step = Math.max(1, Math.ceil(group.children.length / 24));
        for (let b = a + 1; b < group.children.length; b += step) {
          swap(group.children, a, b); position(group);
          const candidate = score();
          if (candidate < best - 0.01) best = candidate;
          else { swap(group.children, a, b); position(group); }
        }
      }
    });
  }
  return { groups, bounds };
}
