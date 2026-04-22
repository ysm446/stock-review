export function parseNumericInput(value) {
  const normalized = String(value ?? "")
    .trim()
    .replaceAll(",", "");
  if (!normalized) {
    return 0;
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function parseWholeNumber(value) {
  return Math.round(parseNumericInput(value));
}

export function formatCurrency(value) {
  return new Intl.NumberFormat("ja-JP", {
    style: "currency",
    currency: "JPY",
    maximumFractionDigits: 0
  }).format(value);
}

export function formatPercent(value) {
  return `${value.toFixed(1)}%`;
}

export function formatSignedCurrency(value) {
  const abs = formatCurrency(Math.abs(value));
  return `${value >= 0 ? "+" : "-"}${abs}`;
}

export function formatSignedPercent(value) {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

export function formatPlainNumber(value) {
  return new Intl.NumberFormat("ja-JP", {
    maximumFractionDigits: 0
  }).format(value);
}

export function normalizeSearchText(value) {
  return String(value || "")
    .trim()
    .normalize("NFKC")
    .toLowerCase();
}

export function formatMaybeCurrency(value, currency = "JPY", compact = false) {
  const numeric = parseNumericInput(value);
  if (!numeric) {
    return "-";
  }
  const options = {
    style: "currency",
    currency,
    maximumFractionDigits: 0
  };
  if (compact) {
    options.notation = "compact";
    options.compactDisplay = "short";
  }
  return new Intl.NumberFormat("ja-JP", options).format(numeric);
}

export function formatMaybeNumber(value, digits = 1, suffix = "") {
  const numeric = toFiniteNumber(value);
  if (numeric === null) {
    return "-";
  }
  return `${numeric.toFixed(digits)}${suffix}`;
}

export function formatMaybeMultiple(value) {
  const numeric = toFiniteNumber(value);
  if (numeric === null) {
    return "-";
  }
  return `${numeric.toFixed(2)} 倍`;
}

export function formatMaybePercent(value, digits = 1) {
  const numeric = toFiniteNumber(value);
  if (numeric === null) {
    return "-";
  }
  return `${(numeric * 100).toFixed(digits)}%`;
}

export function formatMaybeYieldPercent(value, digits = 1) {
  const numeric = toFiniteNumber(value);
  if (numeric === null) {
    return "-";
  }

  let normalized = numeric;
  if (Math.abs(normalized) <= 1) {
    normalized *= 100;
  } else if (Math.abs(normalized) >= 100) {
    normalized /= 100;
  }
  return `${normalized.toFixed(digits)}%`;
}

export function formatPriceWithDate(value, currency, dateLabel = "", compact = false) {
  const formattedValue = formatMaybeCurrency(value, currency, compact);
  const normalizedDateLabel = String(dateLabel || "").trim();
  if (formattedValue === "-" || !normalizedDateLabel) {
    return formattedValue;
  }
  return `${formattedValue} <span class="metric-date-note">(${normalizedDateLabel})</span>`;
}

export function normalizeYieldPercentValue(value) {
  const numeric = toFiniteNumber(value);
  if (numeric === null) {
    return null;
  }

  let normalized = numeric;
  if (Math.abs(normalized) <= 1) {
    normalized *= 100;
  } else if (Math.abs(normalized) >= 100) {
    normalized /= 100;
  }
  return normalized;
}

export function formatNormalizedPercent(value, digits = 1) {
  const numeric = toFiniteNumber(value);
  if (numeric === null) {
    return "-";
  }
  return `${numeric.toFixed(digits)}%`;
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function interpolateColor(start, end, ratio) {
  const safeRatio = clamp(ratio, 0, 1);
  return start.map((value, index) => Math.round(value + (end[index] - value) * safeRatio));
}

export function buildMetricToneStyle(value, stops) {
  const numeric = toFiniteNumber(value);
  if (numeric === null) {
    return "";
  }

  const [min, mid, max] = stops;
  const lowColor = [32, 163, 140];
  const neutralColor = [118, 126, 140];
  const highColor = [214, 94, 48];
  let rgb;

  if (numeric <= mid) {
    const ratio = mid === min ? 1 : clamp((numeric - min) / (mid - min), 0, 1);
    rgb = interpolateColor(lowColor, neutralColor, ratio);
  } else {
    const ratio = max === mid ? 1 : clamp((numeric - mid) / (max - mid), 0, 1);
    rgb = interpolateColor(neutralColor, highColor, ratio);
  }

  return `color: rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]});`;
}

export function buildYieldToneStyle(value) {
  const numeric = toFiniteNumber(value);
  if (numeric === null) {
    return "";
  }

  const lowColor = [118, 126, 140];
  const goodColor = [32, 163, 140];
  const highColor = [214, 94, 48];
  let rgb;

  if (numeric <= 3) {
    const ratio = clamp((numeric - 0.5) / (3 - 0.5), 0, 1);
    rgb = interpolateColor(lowColor, goodColor, ratio);
  } else {
    const ratio = clamp((numeric - 3) / (6 - 3), 0, 1);
    rgb = interpolateColor(goodColor, highColor, ratio);
  }

  return `color: rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]});`;
}

export function normalizePercentLikeValue(value) {
  const numeric = toFiniteNumber(value);
  if (numeric === null) {
    return null;
  }
  return Math.abs(numeric) <= 1 ? numeric * 100 : numeric;
}

export function buildPositiveMetricToneStyle(value, stops) {
  const numeric = normalizePercentLikeValue(value);
  if (numeric === null) {
    return "";
  }

  const [min, mid, max] = stops;
  const lowColor = [118, 126, 140];
  const midColor = [76, 133, 183];
  const goodColor = [32, 163, 140];
  let rgb;

  if (numeric <= mid) {
    const ratio = mid === min ? 1 : clamp((numeric - min) / (mid - min), 0, 1);
    rgb = interpolateColor(lowColor, midColor, ratio);
  } else {
    const ratio = max === mid ? 1 : clamp((numeric - mid) / (max - mid), 0, 1);
    rgb = interpolateColor(midColor, goodColor, ratio);
  }

  return `color: rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]});`;
}

export function getMetricToneHelpText(metric) {
  switch (metric) {
    case "PER":
      return "PERは株価が1株利益の何倍まで買われているかを見る指標です。色は低めで青緑、中間でグレー、高めで赤寄りです。";
    case "PBR":
      return "PBRは株価が1株純資産の何倍かを見る指標です。色は低めで青緑、中間でグレー、高めで赤寄りです。";
    case "dividendYield":
      return "配当利回りは現在株価に対する年間配当の割合です。色は2〜4%前後が見やすい帯で青緑、低すぎるとグレー、高すぎると赤寄りです。";
    case "ROE":
      return "ROEは自己資本を使ってどれだけ効率よく利益を出したかを見る指標です。色は低いとグレー、10%前後から良化し、15%以上で青緑寄りです。";
    case "ROA":
      return "ROAは総資産全体を使ってどれだけ利益を出したかを見る指標です。色は低いとグレー、5%前後から良化し、8%以上で青緑寄りです。";
    default:
      return "";
  }
}

export function buildMetricHeaderCell(label, metricKey = "") {
  const helpText = metricKey ? getMetricToneHelpText(metricKey) : "";
  if (!helpText) {
    return `<th>${label}</th>`;
  }
  return `<th><button type="button" class="metric-help-label" data-metric-key="${metricKey}">${label}</button></th>`;
}

export function toFiniteNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

export function formatStatementNumber(value) {
  const numeric = toFiniteNumber(value);
  if (numeric === null) {
    return "-";
  }
  return new Intl.NumberFormat("ja-JP", {
    notation: "compact",
    compactDisplay: "short",
    maximumFractionDigits: 1
  }).format(numeric);
}
