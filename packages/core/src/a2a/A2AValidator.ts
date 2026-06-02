import addFormats from "ajv-formats";
import Ajv2020, { type ValidateFunction } from "ajv/dist/2020.js";

/**
 * The shape of the vendored A2A schema bundle (`vendor/a2a/a2a.schema.json`).
 *
 * The bundle is a single document with a `definitions` map whose KEYS are the
 * spaced display names (e.g. `"Agent Card"`, `"Send Message Response"`) and whose
 * cross-references use external-file-style `$ref`s like
 * `lf.a2a.v1.AgentCapabilities.jsonschema.json` (NOT `#/definitions/...`). We do
 * not rewrite the vendored file; instead we register each definition with Ajv
 * under an `$id` equal to its referenced filename so those `$ref`s resolve.
 */
export interface A2ASchemaBundle {
  $schema?: string;
  title?: string;
  description?: string;
  version?: string;
  definitions: Record<string, Record<string, unknown>>;
}

export interface A2AValidationResult {
  valid: boolean;
  errors: unknown[];
}

/** Normalize a name/ref-core to a comparison key (strip non-alphanumerics, lowercase). */
function norm(value: string): string {
  return value.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

/** Extract the dotted core of an external `$ref` filename (the type name). */
function refCore(ref: string): string {
  const base = ref.replace(/\.jsonschema\.json$/, "");
  const parts = base.split(".");
  return parts[parts.length - 1] as string;
}

/**
 * Validates JSON values against the **vendored** A2A schema bundle using Ajv's
 * 2020-12 dialect (`ajv/dist/2020`) — no new dependency, no second schema system,
 * no Zod. The validator conforms to whatever the vendored file actually contains;
 * it does not invent or rewrite fields. Definition names are addressed by their
 * spaced display-name key as authored in the bundle (e.g. `"Agent Card"`).
 */
export class A2AValidator {
  private readonly ajv: Ajv2020;
  /** Maps a definition's spaced name -> the `$id` it was registered under. */
  private readonly idByName = new Map<string, string>();

  constructor(bundle: A2ASchemaBundle) {
    this.ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(this.ajv);

    const defs = bundle.definitions ?? {};

    // 1. Collect every external `$ref` filename used anywhere in the bundle and
    //    index it by its normalized type-core so we can map a definition to the
    //    filename other definitions reference it by.
    const refByCore = new Map<string, string>();
    JSON.stringify(bundle, (key, value) => {
      if (key === "$ref" && typeof value === "string") {
        refByCore.set(norm(refCore(value)), value);
      }
      return value;
    });

    // 2. Assign each definition an `$id`: the filename it is referenced by when
    //    one exists, otherwise a synthesized `lf.a2a.v1.<NoSpaces>.jsonschema.json`
    //    (root request/response types are never referenced by others).
    for (const name of Object.keys(defs)) {
      const referenced = refByCore.get(norm(name));
      const id = referenced ?? `lf.a2a.v1.${name.replace(/[^A-Za-z0-9]/g, "")}.jsonschema.json`;
      this.idByName.set(name, id);
    }

    // 3. Register each definition as a standalone schema under its `$id` so the
    //    external-file `$ref`s between definitions resolve against the registry.
    for (const [name, schema] of Object.entries(defs)) {
      const id = this.idByName.get(name) as string;
      this.ajv.addSchema({ ...schema, $id: id }, id);
    }
  }

  /** Definition names present in the vendored bundle. */
  definitionNames(): string[] {
    return [...this.idByName.keys()];
  }

  private compileByName(name: string): ValidateFunction {
    const id = this.idByName.get(name);
    if (!id) {
      throw new Error(
        `A2A definition not found in vendored schema: "${name}". ` +
          `Known: ${this.definitionNames().join(", ")}`,
      );
    }
    const validate = this.ajv.getSchema(id);
    if (!validate) throw new Error(`A2A schema not registered for "${name}" (${id})`);
    return validate;
  }

  /** Validate `data` against the named definition from the vendored bundle. */
  validate(definitionName: string, data: unknown): A2AValidationResult {
    const validate = this.compileByName(definitionName);
    const valid = validate(data) as boolean;
    return { valid, errors: valid ? [] : (validate.errors ?? []) };
  }
}
