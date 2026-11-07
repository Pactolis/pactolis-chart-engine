export const totalJitterMs = (sampleMs) => Math.min(1000, sampleMs * 0.02);

export const spanValid = (values, sampleMs) => {
  if (!Array.isArray(values) || !Number.isFinite(sampleMs) || sampleMs <= 0) return false;
  if (values.length < 2) return true;
  const totalJitter = totalJitterMs(sampleMs);
  const expectedSpan = (values.length - 1) * sampleMs;
  return values.every((sample, i) => Number.isFinite(sample.at)
    && (i === 0 || (sample.minute === values[i - 1].minute + 1 && sample.at > values[i - 1].at)))
    && values.at(-1).at - values[0].at >= expectedSpan - totalJitter;
};
