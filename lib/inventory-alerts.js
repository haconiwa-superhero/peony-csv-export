'use strict';

const DEFAULT_THRESHOLDS = [500, 300, 100, 50, 0];

function normalizeThresholds(value = DEFAULT_THRESHOLDS) {
  const source = Array.isArray(value) ? value : String(value).split(',');
  const thresholds = [...new Set(source.map(Number).filter(Number.isFinite))];
  return thresholds.sort((a, b) => b - a);
}

function selectCrossedThreshold(previousQuantity, currentQuantity, thresholds = DEFAULT_THRESHOLDS) {
  if (!Number.isFinite(previousQuantity) || !Number.isFinite(currentQuantity)) return null;
  if (currentQuantity >= previousQuantity) return null;

  const crossed = normalizeThresholds(thresholds).filter(
    threshold => previousQuantity > threshold && currentQuantity <= threshold
  );
  return crossed.length ? Math.min(...crossed) : null;
}

function evaluateInventoryChange({ previousQuantity, currentQuantity, thresholds = DEFAULT_THRESHOLDS }) {
  if (!Number.isFinite(currentQuantity)) {
    return { action: 'ignore', reason: 'invalid-current-quantity' };
  }
  if (!Number.isFinite(previousQuantity)) {
    return { action: 'initialize', currentQuantity };
  }
  if (currentQuantity > previousQuantity) {
    return { action: 'restocked', previousQuantity, currentQuantity };
  }
  if (currentQuantity === previousQuantity) {
    return { action: 'ignore', reason: 'unchanged', currentQuantity };
  }

  const threshold = selectCrossedThreshold(previousQuantity, currentQuantity, thresholds);
  if (threshold === null) {
    return { action: 'update', previousQuantity, currentQuantity };
  }
  return { action: 'notify', previousQuantity, currentQuantity, threshold };
}

module.exports = {
  DEFAULT_THRESHOLDS,
  normalizeThresholds,
  selectCrossedThreshold,
  evaluateInventoryChange,
};
