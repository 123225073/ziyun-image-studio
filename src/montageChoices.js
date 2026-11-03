export function splitCandidates(text) {
  return text.split(/\r?\n\s*---\s*\r?\n|\r?\n/).map(value => value.trim()).filter(Boolean);
}

export function montageChoices(sections) {
  return sections.map(section => {
    const candidates = splitCandidates(section.candidates);
    if (!candidates.length) return [];
    const selected = candidates[Math.max(0, Math.min(section.pick || 0, candidates.length - 1))];
    // Imported audio belongs to the explicitly selected text and must not rotate.
    if (section.audioPath) return [selected];
    const unique = [...new Set(candidates)];
    const start = unique.indexOf(selected);
    return [...unique.slice(start), ...unique.slice(0, start)];
  });
}

export function montageCapacity(choices) {
  return choices.reduce((total, section) => Math.min(total * section.length, 1000000), 1);
}

export function montageCombinations(choices, requested) {
  const count = Math.min(requested, montageCapacity(choices));
  return Array.from({ length: count }, (_, index) => {
    let cursor = index;
    return choices.map(section => {
      const text = section[cursor % section.length];
      cursor = Math.floor(cursor / section.length);
      return text;
    });
  });
}
