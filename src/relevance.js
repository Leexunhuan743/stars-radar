// Relevance lives on one 0..1 scale. Lexical and semantic evidence are calibrated
// independently, then corroborating evidence is combined without source-specific bonuses.

export function keywordRelevanceScore(kwWeight) {
  const weight = Number.isFinite(kwWeight) ? Math.max(0, kwWeight) : 0
  if (weight === 0)
    return 0
  return Number((weight / (weight + 8)).toFixed(3))
}

export function vectorRelevanceScore(vScore) {
  const similarity = Number.isFinite(vScore) ? Math.max(0, Math.min(vScore, 1)) : 0
  if (similarity <= 0.2)
    return 0

  // Search only admits cosine similarities above 0.2. Map that retrieval floor to zero relevance
  // instead of pretending a raw cosine is already calibrated on the same scale as lexical evidence.
  return Number(((similarity - 0.2) / 0.8).toFixed(3))
}

export function relevanceScore({ vScore = 0, kwWeight = 0 } = {}) {
  const semantic = vectorRelevanceScore(vScore)
  const lexical = keywordRelevanceScore(kwWeight)

  // A single channel keeps exactly its calibrated score. When independent lexical and semantic
  // evidence corroborate the same repository, noisy-OR raises confidence without letting repeated
  // synonyms or source provenance manufacture score. This is monotonic, bounded, and symmetric.
  return Number((1 - (1 - semantic) * (1 - lexical)).toFixed(3))
}
