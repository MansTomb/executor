import { parse, tokTypes, type Token } from "acorn";

export function referencedApps(code: string): ReadonlySet<string> | undefined {
  const tokens: Array<Pick<Token, "type"> & { readonly value: unknown }> = [];
  try {
    parse(code, {
      ecmaVersion: "latest",
      sourceType: "module",
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
      onToken: (token) =>
        tokens.push({ type: token.type, value: "value" in token ? token.value : undefined }),
    });
  } catch {
    return undefined;
  }
  const apps = new Set<string>();
  for (const [index, token] of tokens.entries()) {
    if (token.type !== tokTypes.name) continue;
    if (token.value === "search") return undefined;
    if (token.value !== "tools") continue;
    const member = tokens[index + 1];
    const optional = member?.type === tokTypes.questionDot;
    const property = tokens[index + 2];
    if ((member?.type === tokTypes.dot || optional) && property?.type === tokTypes.name) {
      if (typeof property.value !== "string" || property.value === "search") return undefined;
      apps.add(property.value);
      continue;
    }
    const opening = optional ? property : member;
    const key = tokens[index + (optional ? 3 : 2)];
    const closing = tokens[index + (optional ? 4 : 3)];
    if (
      opening?.type !== tokTypes.bracketL ||
      key?.type !== tokTypes.string ||
      typeof key.value !== "string" ||
      closing?.type !== tokTypes.bracketR
    )
      return undefined;
    const app = key.value.split(".")[0];
    if (app === undefined || app === "search") return undefined;
    apps.add(app);
  }
  return apps;
}
