/**
 * The result helpers every MCP tool shares: a text block, the error wrapper and
 * the output-schema wrapper. Split out of tools.ts so the admin authoring tools
 * (authoring-tools.ts) render results and errors exactly as the rest do.
 */
import { z } from "zod";
import { SubwaveError } from "./client.js";

/** Render any value as a text content block. */
export function text(value: unknown): { type: "text"; text: string } {
  return {
    type: "text",
    text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
  };
}

/**
 * Wrap a tool body so SubwaveError (and anything else) becomes an MCP error
 * result the agent can read, rather than a thrown exception. The error text is
 * already actionable — see client.ts — so we pass it straight through.
 */
export async function run(
  body: () => Promise<{ content: ReturnType<typeof text>[]; structuredContent?: Record<string, unknown> }>,
) {
  try {
    return await body();
  } catch (err) {
    const message =
      err instanceof SubwaveError
        ? err.message
        : `Unexpected error: ${err instanceof Error ? err.message : String(err)}`;
    return { content: [text(message)], isError: true };
  }
}

/**
 * Wraps every tool's output shape. The SDK publishes a zod output schema with
 * `$schema: draft-07` (its zod v4 path hard-codes that target), and an MCP
 * client that validates structured output with a JSON Schema 2020-12-only
 * validator refuses the whole tool over that one line ("unsupported
 * dialect"). Clearing it through zod metadata publishes the schema with no
 * dialect, so each client reads it in its own default, draft-07 or 2020-12.
 * Declaring 2020-12 instead would break the draft-07 clients the same way.
 * That is safe only while these shapes use nothing the two dialects read
 * differently (tuples, `definitions`/`$defs`, `dependencies`);
 * `scripts/mcp-output-schema.test.ts` pins both halves.
 */
export function output<T extends z.ZodRawShape>(shape: T) {
  return z.object(shape).meta({ $schema: undefined });
}
