/**
 * Renders a tool result's JSON Schema as a compact TypeScript type for the tool's description.
 * Claude Code's describeTool shows a tool's parameters but not its outputSchema (v2.1.332), so the
 * description is the one place a code-mode script can read what a tool returns.
 */
import { isJsonObject, type JsonSchema } from "./rex-tool-schemas.ts";

const DEFINITION_PREFIX = "#/$defs/";
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** A rendered type, and whether it is a top-level `|` or `&` that an array or `&` must group. */
interface RenderedType {
  readonly text: string;
  readonly isCompound: boolean;
}

function readSchemas(value: unknown): ReadonlyArray<JsonSchema> {
  return Array.isArray(value) ? value.filter(isJsonObject) : [];
}

function renderKey(key: string): string {
  return IDENTIFIER.test(key) ? key : JSON.stringify(key);
}

/** A `$defs` name as a type name: a quoted name would read as a string literal type. */
function renderTypeName(name: string): string {
  const identifier = name.replace(/[^A-Za-z0-9_$]/g, "_");
  return /^[0-9]/.test(identifier) ? `_${identifier}` : identifier;
}

/**
 * Joins distinct members, so two branded strings read `string`, not `string | string`. No members
 * (an empty `enum`) is `never`.
 */
function joinTypes(members: ReadonlyArray<string>, separator: " | " | " & "): RenderedType {
  const distinct = [...new Set(members)];
  if (distinct.length === 0) return { text: "never", isCompound: false };
  return { text: distinct.join(separator), isCompound: distinct.length > 1 };
}

function renderSimple(text: string): RenderedType {
  return { text, isCompound: false };
}

/** Renders one schema, collecting the `$defs` it references so they are written once, after it. */
class TypeScriptRenderer {
  readonly #definitions: { readonly [name: string]: unknown };
  readonly #referenced = new Map<string, string>();

  constructor(root: JsonSchema) {
    this.#definitions = isJsonObject(root.$defs) ? root.$defs : {};
  }

  renderResult(root: JsonSchema): string {
    const type = this.render(root).text;
    const definitions = [...this.#referenced].map(
      ([name, body]) => `type ${renderTypeName(name)} = ${body};`,
    );
    return definitions.length === 0 ? type : `${type}, where ${definitions.join(" ")}`;
  }

  render(node: unknown): RenderedType {
    if (!isJsonObject(node)) return renderSimple("unknown");
    const reference = node.$ref;
    if (typeof reference === "string" && reference.startsWith(DEFINITION_PREFIX)) {
      return renderSimple(this.renderReference(reference.slice(DEFINITION_PREFIX.length)));
    }
    if ("const" in node) return renderSimple(JSON.stringify(node.const));
    if (Array.isArray(node.enum)) {
      return joinTypes(
        node.enum.map((value) => JSON.stringify(value)),
        " | ",
      );
    }
    const union = readSchemas(node.anyOf ?? node.oneOf);
    if (union.length > 0)
      return joinTypes(
        union.map((member) => this.render(member).text),
        " | ",
      );
    const intersection = readSchemas(node.allOf);
    if (intersection.length > 0) {
      return joinTypes(
        intersection.map((member) => this.renderGrouped(member)),
        " & ",
      );
    }
    if (Array.isArray(node.type)) {
      return joinTypes(
        node.type.map((type: unknown) => this.render({ ...node, type }).text),
        " | ",
      );
    }
    switch (node.type) {
      case "string":
      case "boolean":
      case "null":
        return renderSimple(node.type);
      case "number":
      case "integer":
        return renderSimple("number");
      case "array":
        return renderSimple(this.renderArray(node));
      case "object":
        return renderSimple(this.renderObject(node));
      default:
        return renderSimple("unknown");
    }
  }

  renderGrouped(node: unknown): string {
    const { text, isCompound } = this.render(node);
    return isCompound ? `(${text})` : text;
  }

  renderArray(node: JsonSchema): string {
    const tuple = readSchemas(node.prefixItems);
    if (tuple.length > 0) return `[${tuple.map((item) => this.render(item).text).join(", ")}]`;
    return `${this.renderGrouped(node.items)}[]`;
  }

  renderObject(node: JsonSchema): string {
    const properties = isJsonObject(node.properties) ? Object.entries(node.properties) : [];
    if (properties.length === 0) {
      return `Record<string, ${this.render(node.additionalProperties).text}>`;
    }
    const required = new Set(Array.isArray(node.required) ? node.required : []);
    const fields = properties.map(
      ([key, value]) =>
        `${renderKey(key)}${required.has(key) ? "" : "?"}: ${this.render(value).text}`,
    );
    return `{ ${fields.join("; ")} }`;
  }

  renderReference(name: string): string {
    if (!this.#referenced.has(name)) {
      // Reserved before rendering, so a recursive definition refers to itself instead of looping.
      this.#referenced.set(name, "unknown");
      this.#referenced.set(name, this.render(this.#definitions[name]).text);
    }
    return renderTypeName(name);
  }
}

/** The TypeScript type of a tool result, such as `{ markId: string }`, from its JSON Schema. */
export function describeResultType(schema: JsonSchema): string {
  return new TypeScriptRenderer(schema).renderResult(schema);
}
