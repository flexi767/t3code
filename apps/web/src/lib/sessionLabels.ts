export function compactSessionModel(label: string, showVersion = true): string {
  const family = /\b(opus|fable|sol|astra|terra|luna|sonnet|haiku)\b/i.exec(label);
  if (!family) return label;
  if (!showVersion) return family[0][0]!.toUpperCase();
  const version = /\d+(?:[.-]\d+)?/.exec(label)?.[0]?.replace("-", ".");
  return `${family[0][0]!.toUpperCase()}${version ?? ""}`;
}

export function sessionMachineLabel(label: string | null): string {
  const name = label?.trim() ?? "";
  return /^(?:m3|m5|j)$/i.test(name) ? name.toUpperCase() : name;
}
