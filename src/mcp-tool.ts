import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Implementation, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";

export const READ: ToolAnnotations = { readOnlyHint: true, openWorldHint: true };
export const WRITE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };
export const DESTRUCTIVE: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, openWorldHint: true };

/** What a server tells a client about itself, besides its name. */
export type ServerInfo = Pick<Implementation, "version" | "websiteUrl" | "icons">;

/** Drops empty values (null, undefined, "", [], {}) so results stay short for the model. */
export function clean(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(clean).filter((v) => v !== undefined);
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(value)) {
      const v = clean(raw);
      if (v === undefined || v === null || v === "") continue;
      if (Array.isArray(v) && v.length === 0) continue;
      if (typeof v === "object" && !Array.isArray(v) && Object.keys(v as object).length === 0) continue;
      out[key] = v;
    }
    return out;
  }
  return value === null ? undefined : value;
}

export type ToolConfig<Shape extends z.ZodRawShape> = {
  title: string;
  description: string;
  input?: Shape;
  annotations: ToolAnnotations;
};

/**
 * Returns the function a server registers its tools with. A tool's result is returned as compact
 * JSON; an error becomes the readable text that `explain` makes of it.
 */
export function toolRegistrar(server: McpServer, explain: (error: unknown) => string) {
  return function tool<Shape extends z.ZodRawShape>(
    name: string,
    config: ToolConfig<Shape>,
    run: (args: z.infer<z.ZodObject<Shape>>) => Promise<unknown>,
  ): void {
    server.registerTool(
      name,
      { title: config.title, description: config.description, inputSchema: (config.input ?? {}) as Shape, annotations: config.annotations },
      (async (args: z.infer<z.ZodObject<Shape>>) => {
        try {
          const result = await run(args);
          return { content: [{ type: "text" as const, text: JSON.stringify(clean(result)) }] };
        } catch (error) {
          return { content: [{ type: "text" as const, text: explain(error) }], isError: true };
        }
      }) as never,
    );
  };
}
