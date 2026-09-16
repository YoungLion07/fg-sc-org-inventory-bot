'use strict';

// Ore/mineral quality: turn a raw in-game reading (1-1000) into the community S-F tier,
// using that specific material's own thresholds from the ore_mineral_quality table.

const TIER_ORDER = [
  ['S', 'tier_s_min'],
  ['A', 'tier_a_min'],
  ['B', 'tier_b_min'],
  ['C', 'tier_c_min'],
  ['D', 'tier_d_min'],
  ['E', 'tier_e_min'],
  ['F', 'tier_f_min'],
];

/**
 * @param {number} reading   raw quality value shown in-game
 * @param {object} thresholds a row from ore_mineral_quality
 * @returns {string|null} 'Perfect', 'S'...'F', or null if the reading is below every
 *   published threshold for that material (e.g. Carinite has no published F minimum).
 */
function deriveQualityTier(reading, thresholds) {
  if (!Number.isInteger(reading) || reading < 1 || reading > 1000) {
    throw new RangeError('Quality reading must be a whole number from 1 to 1000');
  }
  const perfect = thresholds.tier_perfect ?? 1000;
  if (reading >= perfect) return 'Perfect';
  for (const [tier, column] of TIER_ORDER) {
    const min = thresholds[column];
    if (min !== null && min !== undefined && reading >= Number(min)) return tier;
  }
  return null;
}

function describeTier(tier) {
  if (!tier) return 'tier unknown';
  return tier === 'Perfect' ? 'Perfect quality' : `${tier}-tier`;
}

module.exports = { deriveQualityTier, describeTier };
