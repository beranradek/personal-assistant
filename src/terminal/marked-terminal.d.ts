declare module "marked-terminal" {
  import type { MarkedExtension } from "marked";
  interface TerminalRendererOptions {
    reflowText?: boolean;
    width?: number;
    tab?: number;
    [key: string]: unknown;
  }
  export function markedTerminal(
    options?: TerminalRendererOptions,
  ): MarkedExtension;
  export default class Renderer {}
}
