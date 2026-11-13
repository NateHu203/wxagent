import type { ChatTurn } from "./store";

/** JSON Schema for a tool's input: always an object. */
export interface ToolInputSchema {
  additionalProperties: false;
  properties: Record<string, unknown>;
  required: string[];
  type: "object";
}

export interface ToolSpec {
  description: string;
  inputSchema: ToolInputSchema;
  name: string;
}

export interface ModelRequest {
  /** Earlier turns of this conversation, oldest first. */
  history: ChatTurn[];
  /** The user's new message. */
  message: string;
  /** Run a tool the model called; resolves to the text shown to the model. Never throws. */
  runTool(name: string, input: unknown): Promise<string>;
  system: string;
  tools: ToolSpec[];
}

/**
 * A chat model that can call tools. Implementations own the tool loop: call
 * `runTool` for each tool call and return the final text for the user.
 */
export interface Model {
  reply(request: ModelRequest): Promise<string>;
}

/** Shown to the user when the model produces nothing usable. */
export const EMPTY_REPLY = "抱歉，这条我没处理好，换个说法再试一次？";
/** Tool loops stop after this many model calls in one turn. */
export const MAX_MODEL_CALLS = 10;
