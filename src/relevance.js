// Keyword-only relevance normalization for hybrid search.
//
// Standalone, dependency-free module so it can be unit-tested under plain Node
// (src/index.js itself imports `agents/mcp` which resolves a `cloudflare:` scheme
// that Node cannot load). The Worker imports this via src/index.js; the G2
// regression test imports it directly — one source of truth, no replica drift.
//
// Mapping min(1 - 1/(1+kwWeight/8), 0.95):
//   - low end passes default min_score 0.25 (weight>=5 -> >=0.38)
//   - high end keeps rank discrimination (w19->0.70, w40->0.83, w130->0.94)
//     so relevance_score does not saturate and collapse top-N ordering
export function keywordRelevanceScore(kwWeight) {
  return Number(Math.min(1 - 1 / (1 + kwWeight / 8), 0.95).toFixed(3))
}

// Combined relevance for one result, given whichever channels scored it.
//
// Extracted from src/index.js so the confidence-bonus arithmetic and the three
// branches are unit-testable: the +0.35 keyword bonus and the separate 0.98 / 0.95
// ceilings previously existed only inside the file that cannot be imported.
export function relevanceScore({ vScore = 0, kwWeight = 0, facetCoverage } = {}) {
  let base = 0
  if (vScore > 0 && kwWeight > 0) {
    const kwBonus = Math.min((kwWeight / 100) * 0.35, 0.35)
    base = Math.min(vScore + kwBonus, 0.98)
  }
  else if (vScore > 0) {
    base = Math.min(vScore, 0.95)
  }
  else if (kwWeight > 0) {
    base = keywordRelevanceScore(kwWeight)
  }

  // Multi-facet coverage is a separate ranking signal: covering several distinct user
  // requirements should beat repeating synonyms from one intent domain. Single-facet
  // queries keep the previous score exactly, so identity and narrow recall semantics do
  // not drift just because the structured query representation exists.
  if (facetCoverage?.total >= 2) {
    const ratio = Math.max(0, Math.min(facetCoverage.matched / facetCoverage.total, 1))
    // Coverage changes the final relevance, not candidate generation. A partial match remains
    // discoverable, but a repository satisfying one of four requested facets cannot outrank an
    // otherwise similar repository satisfying all four merely because one intent had many synonyms.
    const coverageFactor = 0.85 + (ratio * 0.15)
    const coverageBonus = facetCoverage.matched >= 2 ? ratio * 0.12 : 0
    base = (base * coverageFactor) + coverageBonus
  }

  return Number(Math.min(base, 0.99).toFixed(3))
}

// Community cap: at most ceil(limit*0.4) community/archive results per query.
export function communityCap(limit) {
  return Math.ceil(limit * 0.4)
}

// Applies the cap to an already-ranked result list: starred hits are never
// dropped, and non-starred ones are admitted until the cap is reached. Extracted
// so the truncation order — not just the cap arithmetic — is unit-testable
// outside the Cloudflare worker runtime.
export function applyCommunityCap(rankedResults, limit) {
  const cap = communityCap(limit)
  const capped = []
  let communityCount = 0
  for (const result of rankedResults) {
    const isStarred = result.source === 'starred'
    if (!isStarred && communityCount >= cap)
      continue
    if (!isStarred)
      communityCount++
    capped.push(result)
  }
  return capped.slice(0, limit)
}
