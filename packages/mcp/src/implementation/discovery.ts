import { parse, tokTypes, type AnyNode, type CallExpression, type Token } from "acorn";

function isNode(value: unknown): value is AnyNode {
  return (
    typeof value === "object" && value !== null && "type" in value && typeof value.type === "string"
  );
}

function searchCallee(call: CallExpression) {
  const callee = call.callee;
  if (callee.type === "Identifier") return callee.name === "search" ? callee : undefined;
  if (
    callee.type !== "MemberExpression" ||
    callee.object.type !== "Identifier" ||
    callee.object.name !== "tools"
  )
    return undefined;
  const property = callee.property;
  if (!callee.computed && property.type === "Identifier" && property.name === "search")
    return property;
  if (callee.computed && property.type === "Literal" && property.value === "search")
    return property;
  return undefined;
}

function searchedApp(call: CallExpression): string | undefined {
  const [input, ...rest] = call.arguments;
  if (input?.type !== "ObjectExpression" || rest.length > 0) return undefined;
  const namespaces = [];
  for (const property of input.properties) {
    if (property.type !== "Property" || property.computed) return undefined;
    const key =
      property.key.type === "Identifier"
        ? property.key.name
        : property.key.type === "Literal"
          ? property.key.value
          : undefined;
    if (key === "namespace") namespaces.push(property);
  }
  const [namespace, ...duplicates] = namespaces;
  if (
    namespace === undefined ||
    duplicates.length > 0 ||
    namespace.kind !== "init" ||
    namespace.value.type !== "Literal" ||
    typeof namespace.value.value !== "string" ||
    namespace.value.value.startsWith("tools")
  )
    return undefined;
  return namespace.value.value.split(".")[0];
}

function scopedSearches(node: unknown, scopes: Map<number, string>): void {
  if (Array.isArray(node)) {
    for (const child of node) scopedSearches(child, scopes);
    return;
  }
  if (!isNode(node)) return;
  if (node.type === "CallExpression") {
    const callee = searchCallee(node);
    const app = callee === undefined ? undefined : searchedApp(node);
    if (callee !== undefined && app !== undefined) scopes.set(callee.start, app);
  }
  for (const child of Object.values(node)) scopedSearches(child, scopes);
}

export function referencedApps(code: string): ReadonlySet<string> | undefined {
  const tokens: Array<Pick<Token, "type" | "start"> & { readonly value: unknown }> = [];
  const scopes = new Map<number, string>();
  try {
    scopedSearches(
      parse(code, {
        ecmaVersion: "latest",
        sourceType: "module",
        allowReturnOutsideFunction: true,
        allowAwaitOutsideFunction: true,
        onToken: (token) =>
          tokens.push({
            type: token.type,
            start: token.start,
            value: "value" in token ? token.value : undefined,
          }),
      }),
      scopes,
    );
  } catch {
    return undefined;
  }
  const apps = new Set<string>();
  for (const [index, token] of tokens.entries()) {
    if (token.type !== tokTypes.name) continue;
    if (token.value === "search") {
      const app = scopes.get(token.start);
      if (app === undefined) return undefined;
      apps.add(app);
      continue;
    }
    if (token.value !== "tools") continue;
    const member = tokens[index + 1];
    const optional = member?.type === tokTypes.questionDot;
    const property = tokens[index + 2];
    if ((member?.type === tokTypes.dot || optional) && property?.type === tokTypes.name) {
      if (typeof property.value !== "string") return undefined;
      if (property.value !== "search") apps.add(property.value);
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
    const app = key.value === "search" ? scopes.get(key.start) : key.value.split(".")[0];
    if (app === undefined || app === "search") return undefined;
    apps.add(app);
  }
  return apps;
}
